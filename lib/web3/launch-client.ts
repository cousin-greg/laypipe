import {
  decodeAddress,
  decodeBool,
  decodeLaunchConfig,
  decodeMineSaltResult,
  decodeUint,
  encodeAllowanceCall,
  encodeApproveCall,
  encodeBalanceOfCall,
  encodeGetLaunchConfigCall,
  encodeLaunchCall,
  encodeLaunchEnabledCall,
  encodeLaunchFeeCall,
  encodeMineSaltCall,
  encodeQuoteTokenCall,
  type FactoryLaunchConfig,
  type FactoryTokenParams,
} from "./abi";
import {
  PIPEDOG_ADDRESS,
  ROBINHOOD_CHAIN_ID_HEX,
  ROBINHOOD_WALLET_CHAIN,
  robinhoodWalletAddChainParameters,
} from "./robinhood";
import {
  assertAuditedDeployment,
  DeploymentIntegrityError,
  type AuditedDeploymentManifest,
} from "./deployment-manifest";
import {
  assertAddress,
  isAddress,
  isHexData,
  isHexQuantity,
  isTransactionHash,
  sameAddress,
  type Address,
  type Eip1193Provider,
  type Hex,
  type RpcTransactionReceipt,
  type RpcTransactionRequest,
} from "./types";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
export const TOKEN_LAUNCHED_TOPIC =
  "0x17091df68f499cf4e20dcfc5d42f064dd22359e785b77691c4c4ed0322608897";

export interface FactoryPreflight {
  launchFee: bigint;
  launchEnabled: boolean;
  quoteToken: Address;
  launchConfig: FactoryLaunchConfig;
  allowance: bigint;
  pipedogBalance: bigint;
}

export interface LaunchCallInput {
  params: FactoryTokenParams;
  configId: bigint;
  firstBuyIn: bigint;
  firstBuyMinOut: bigint;
  salt: Hex;
}

export interface ExactApprovalPlan {
  currentAllowance: bigint;
  requiredAllowance: bigint;
  steps: Array<{
    kind: "reset" | "approve-exact";
    amount: bigint;
    label: string;
  }>;
}

export interface ConfirmedLaunch {
  receipt: RpcTransactionReceipt;
  token: Address;
  poolId: Hex;
}

export class WalletFlowError extends Error {
  readonly code?: number | string;
  readonly causeData?: unknown;

  constructor(message: string, code?: number | string, causeData?: unknown) {
    super(message);
    this.name = "WalletFlowError";
    this.code = code;
    this.causeData = causeData;
  }
}

function unknownErrorCode(error: unknown) {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "number" || typeof code === "string" ? code : undefined;
}

function unknownErrorMessage(error: unknown) {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return "The wallet could not complete that request.";
}

export function describeWalletError(error: unknown) {
  const code = unknownErrorCode(error);
  if (code === 4001 || code === "4001") return "You rejected the wallet request.";
  if (code === -32002 || code === "-32002") {
    return "A wallet request is already open. Finish it in your wallet and try again.";
  }

  const message = unknownErrorMessage(error);
  if (/insufficient funds/i.test(message)) {
    return "The wallet does not have enough ETH on Robinhood Chain for gas.";
  }
  if (/user rejected|denied transaction|cancelled/i.test(message)) {
    return "You rejected the wallet request.";
  }
  if (/allowance/i.test(message)) {
    return "The PIPEDOG allowance is no longer exact. Refresh it before launching.";
  }
  if (/slippage|minimum.*out/i.test(message)) {
    return "The first-buy quote moved beyond your minimum. Prepare a fresh quote.";
  }
  if (/paused|LaunchPaused/i.test(message)) {
    return "New launches are currently paused by the factory owner.";
  }
  return message.length > 240 ? `${message.slice(0, 237)}...` : message;
}

function assertRpcData(value: unknown, label: string): Hex {
  if (typeof value !== "string" || !isHexData(value)) {
    throw new WalletFlowError(`${label} returned malformed RPC data.`);
  }
  return value;
}

function assertRpcQuantity(value: unknown, label: string): Hex {
  if (typeof value !== "string" || !isHexQuantity(value)) {
    throw new WalletFlowError(`${label} returned a malformed RPC quantity.`);
  }
  return value;
}

function assertRpcTransactionHash(value: unknown, label: string): Hex {
  if (typeof value !== "string" || !isTransactionHash(value)) {
    throw new WalletFlowError(`${label} returned an invalid transaction hash.`);
  }
  return value;
}

export function getInjectedProvider(): Eip1193Provider | null {
  if (typeof window === "undefined") return null;
  const ethereum = (window as Window & { ethereum?: Eip1193Provider }).ethereum;
  return ethereum?.request ? ethereum : null;
}

export function subscribeToWalletContext(
  provider: Eip1193Provider,
  onContextChanged: () => void,
) {
  if (!provider.on) return () => undefined;
  provider.on("accountsChanged", onContextChanged);
  provider.on("chainChanged", onContextChanged);
  return () => {
    provider.removeListener?.("accountsChanged", onContextChanged);
    provider.removeListener?.("chainChanged", onContextChanged);
  };
}

export async function connectInjectedWallet(provider: Eip1193Provider) {
  try {
    const accounts = await provider.request<unknown>({ method: "eth_requestAccounts" });
    if (!Array.isArray(accounts) || typeof accounts[0] !== "string") {
      throw new WalletFlowError("The wallet did not return an account.");
    }
    return assertAddress(accounts[0], "Connected wallet");
  } catch (error) {
    if (error instanceof WalletFlowError) throw error;
    throw new WalletFlowError(
      describeWalletError(error),
      unknownErrorCode(error),
      error,
    );
  }
}

export async function ensureRobinhoodChain(provider: Eip1193Provider) {
  const chainId = await provider.request<unknown>({ method: "eth_chainId" });
  if (
    typeof chainId === "string" &&
    isHexQuantity(chainId) &&
    BigInt(chainId) === BigInt(ROBINHOOD_CHAIN_ID_HEX)
  ) {
    return;
  }

  try {
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: ROBINHOOD_CHAIN_ID_HEX }],
    });
  } catch (error) {
    const code = unknownErrorCode(error);
    if (code !== 4902 && code !== "4902") {
      throw new WalletFlowError(
        describeWalletError(error),
        code,
        error,
      );
    }

    await provider.request({
      method: "wallet_addEthereumChain",
      params: [robinhoodWalletAddChainParameters(ROBINHOOD_WALLET_CHAIN)],
    });
  }

  const selectedChain = await provider.request<unknown>({ method: "eth_chainId" });
  if (
    typeof selectedChain !== "string" ||
    !isHexQuantity(selectedChain) ||
    BigInt(selectedChain) !== BigInt(ROBINHOOD_CHAIN_ID_HEX)
  ) {
    throw new WalletFlowError("Switch your wallet to Robinhood Chain to continue.");
  }
}

export function buildExactApprovalPlan(
  currentAllowance: bigint,
  requiredAllowance: bigint,
): ExactApprovalPlan {
  if (currentAllowance < BigInt(0) || requiredAllowance < BigInt(0)) {
    throw new Error("Allowances cannot be negative.");
  }
  if (currentAllowance === requiredAllowance) {
    return { currentAllowance, requiredAllowance, steps: [] };
  }
  if (currentAllowance === BigInt(0)) {
    return {
      currentAllowance,
      requiredAllowance,
      steps:
        requiredAllowance === BigInt(0)
          ? []
          : [
              {
                kind: "approve-exact",
                amount: requiredAllowance,
                label: "Approve exact PIPEDOG amount",
              },
            ],
    };
  }

  return {
    currentAllowance,
    requiredAllowance,
    steps: [
      { kind: "reset", amount: BigInt(0), label: "Reset stale PIPEDOG allowance" },
      ...(requiredAllowance === BigInt(0)
        ? []
        : [
            {
              kind: "approve-exact" as const,
              amount: requiredAllowance,
              label: "Approve exact PIPEDOG amount",
            },
          ]),
    ],
  };
}

export function assertLaunchPreflight(options: {
  preflight: FactoryPreflight;
  expectedSelfBurn: boolean;
  firstBuyIn: bigint;
  expectedQuoteToken?: Address;
}) {
  const { preflight, expectedSelfBurn, firstBuyIn } = options;
  const expectedQuoteToken = options.expectedQuoteToken ?? PIPEDOG_ADDRESS;
  if (!sameAddress(preflight.quoteToken, expectedQuoteToken)) {
    throw new WalletFlowError(
      "Factory quote token does not match canonical PIPEDOG. Launch blocked.",
    );
  }
  if (!preflight.launchEnabled) {
    throw new WalletFlowError("New launches are currently paused.");
  }
  if (!preflight.launchConfig.enabled) {
    throw new WalletFlowError("This launch mode is currently disabled.");
  }
  if (preflight.launchConfig.selfBurn !== expectedSelfBurn) {
    throw new WalletFlowError("The selected fee mode does not match its on-chain config.");
  }

  const requiredAllowance = preflight.launchFee + firstBuyIn;
  if (preflight.pipedogBalance < requiredAllowance) {
    throw new WalletFlowError(
      "The connected wallet does not have enough PIPEDOG for the launch fee and first buy.",
    );
  }

  return {
    requiredAllowance,
    approvalPlan: buildExactApprovalPlan(preflight.allowance, requiredAllowance),
  };
}

export function assertFirstBuyAmounts(firstBuyIn: bigint, firstBuyMinOut: bigint) {
  if (firstBuyIn < BigInt(0) || firstBuyMinOut < BigInt(0)) {
    throw new WalletFlowError("First-buy amounts cannot be negative.");
  }
  if (firstBuyIn > BigInt(0) && firstBuyMinOut === BigInt(0)) {
    throw new WalletFlowError(
      "A non-zero first buy requires a non-zero minimum token output.",
    );
  }
  if (firstBuyIn === BigInt(0) && firstBuyMinOut !== BigInt(0)) {
    throw new WalletFlowError(
      "Minimum token output must be zero when the first buy is zero.",
    );
  }
}

function launchedTokenFromReceipt(
  receipt: RpcTransactionReceipt,
  factoryAddress: Address,
) {
  const launchLog = receipt.logs.find(
    (log) =>
      sameAddress(log.address, factoryAddress) &&
      log.topics[0]?.toLowerCase() === TOKEN_LAUNCHED_TOPIC,
  );
  if (!launchLog || launchLog.topics.length < 4) {
    throw new WalletFlowError(
      "Launch confirmed, but its TokenLaunched event was not found in the receipt.",
    );
  }
  const tokenTopic = launchLog.topics[1];
  if (!tokenTopic || tokenTopic.length !== 66) {
    throw new WalletFlowError("Launch receipt contained an invalid token address.");
  }
  return {
    token: assertAddress(`0x${tokenTopic.slice(-40)}`, "Launched token"),
    poolId: launchLog.topics[3],
  };
}

export class LaypipeLaunchClient {
  readonly provider: Eip1193Provider;
  readonly factoryAddress: Address;
  readonly quoteTokenAddress: Address;
  readonly auditedManifest: AuditedDeploymentManifest | null;

  constructor(
    provider: Eip1193Provider,
    deployment: Address | AuditedDeploymentManifest,
  ) {
    this.provider = provider;
    if (typeof deployment === "string") {
      this.factoryAddress = assertAddress(deployment, "Factory address");
      this.quoteTokenAddress = PIPEDOG_ADDRESS;
      this.auditedManifest = null;
    } else {
      this.factoryAddress = assertAddress(
        deployment.contracts.factoryProxy.address,
        "Factory address",
      );
      this.quoteTokenAddress = assertAddress(
        deployment.contracts.pipedog.address,
        "Quote token address",
      );
      this.auditedManifest = deployment;
    }
  }

  async verifyAuditedDeployment() {
    if (!this.auditedManifest) {
      throw new DeploymentIntegrityError(
        "The audited deployment manifest is not loaded. Wallet mutations are blocked.",
      );
    }
    return assertAuditedDeployment(this.provider, this.auditedManifest);
  }

  private async call(to: Address, data: Hex, from?: Address) {
    const result = await this.provider.request<unknown>({
      method: "eth_call",
      params: [{ to, data, ...(from ? { from } : {}) }, "latest"],
    });
    return assertRpcData(result, "Contract read");
  }

  async readPreflight(
    owner: Address,
    configId: bigint,
  ): Promise<FactoryPreflight> {
    await this.verifyAuditedDeployment();
    const [
      launchFeeResult,
      launchEnabledResult,
      quoteTokenResult,
      configResult,
    ] = await Promise.all([
      this.call(this.factoryAddress, encodeLaunchFeeCall()),
      this.call(this.factoryAddress, encodeLaunchEnabledCall()),
      this.call(this.factoryAddress, encodeQuoteTokenCall()),
      this.call(this.factoryAddress, encodeGetLaunchConfigCall(configId)),
    ]);
    const quoteToken = decodeAddress(quoteTokenResult);
    const [allowanceResult, balanceResult] = await Promise.all([
      this.call(
        quoteToken,
        encodeAllowanceCall(owner, this.factoryAddress),
      ),
      this.call(quoteToken, encodeBalanceOfCall(owner)),
    ]);

    return {
      launchFee: decodeUint(launchFeeResult),
      launchEnabled: decodeBool(launchEnabledResult),
      quoteToken,
      launchConfig: decodeLaunchConfig(configResult),
      allowance: decodeUint(allowanceResult),
      pipedogBalance: decodeUint(balanceResult),
    };
  }

  async readCanonicalPipedogAllowance(owner: Address) {
    return decodeUint(
      await this.call(
        this.quoteTokenAddress,
        encodeAllowanceCall(owner, this.factoryAddress),
      ),
    );
  }

  async mineVanitySalt(options: {
    params: FactoryTokenParams;
    configId: bigint;
    sender: Address;
    roundsPerCall?: bigint;
    maxCalls?: number;
  }) {
    await this.verifyAuditedDeployment();
    const rounds = options.roundsPerCall ?? BigInt(4096);
    const maxCalls = options.maxCalls ?? 4;
    let start = BigInt(0);
    for (let attempt = 0; attempt < maxCalls; attempt += 1) {
      const result = decodeMineSaltResult(
        await this.call(
          this.factoryAddress,
          encodeMineSaltCall({
            params: options.params,
            configId: options.configId,
            sender: options.sender,
            start,
            rounds,
          }),
          options.sender,
        ),
      );
      if (!sameAddress(result.token, ZERO_ADDRESS)) return result;
      start += rounds;
    }
    throw new WalletFlowError(
      "Could not mine a valid token address in the bounded search. Try preparing again.",
    );
  }

  async estimateApproval(owner: Address, amount: bigint) {
    await this.verifyAuditedDeployment();
    return this.estimate({
      from: owner,
      to: this.quoteTokenAddress,
      data: encodeApproveCall(this.factoryAddress, amount),
    });
  }

  async sendApproval(owner: Address, amount: bigint) {
    await this.verifyAuditedDeployment();
    const transaction = {
      from: owner,
      to: this.quoteTokenAddress,
      data: encodeApproveCall(this.factoryAddress, amount),
    } as const;
    await this.estimate(transaction);
    return this.send(transaction);
  }

  async estimateLaunch(owner: Address, input: LaunchCallInput) {
    assertFirstBuyAmounts(input.firstBuyIn, input.firstBuyMinOut);
    await this.verifyAuditedDeployment();
    return this.estimate({
      from: owner,
      to: this.factoryAddress,
      data: encodeLaunchCall(input),
    });
  }

  async sendLaunch(owner: Address, input: LaunchCallInput) {
    assertFirstBuyAmounts(input.firstBuyIn, input.firstBuyMinOut);
    await this.verifyAuditedDeployment();
    const transaction = {
      from: owner,
      to: this.factoryAddress,
      data: encodeLaunchCall(input),
    } as const;
    await this.estimate(transaction);
    return this.send(transaction);
  }

  private async estimate(transaction: RpcTransactionRequest) {
    try {
      const result = await this.provider.request<unknown>({
        method: "eth_estimateGas",
        params: [transaction],
      });
      return assertRpcQuantity(result, "Gas simulation");
    } catch (error) {
      throw new WalletFlowError(
        `Simulation failed: ${describeWalletError(error)}`,
        unknownErrorCode(error),
        error,
      );
    }
  }

  private async send(transaction: RpcTransactionRequest) {
    try {
      const result = await this.provider.request<unknown>({
        method: "eth_sendTransaction",
        params: [transaction],
      });
      return assertRpcTransactionHash(result, "Transaction submission");
    } catch (error) {
      throw new WalletFlowError(
        describeWalletError(error),
        unknownErrorCode(error),
        error,
      );
    }
  }

  async waitForReceipt(
    hash: Hex,
    options: {
      timeoutMs?: number;
      pollIntervalMs?: number;
      signal?: AbortSignal;
      expectedFrom?: Address;
      expectedTo?: Address;
    } = {},
  ) {
    const timeoutMs = options.timeoutMs ?? 180_000;
    const pollIntervalMs = options.pollIntervalMs ?? 2_000;
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (options.signal?.aborted) {
        throw new WalletFlowError("Receipt check cancelled.");
      }

      const result = await this.provider.request<unknown>({
        method: "eth_getTransactionReceipt",
        params: [hash],
      });
      if (result) {
        const receipt = result as RpcTransactionReceipt;
        if (
          !receipt.transactionHash ||
          !isTransactionHash(receipt.transactionHash) ||
          !receipt.status ||
          !isHexQuantity(receipt.status)
        ) {
          throw new WalletFlowError("Wallet returned an incomplete transaction receipt.");
        }
        if (receipt.transactionHash.toLowerCase() !== hash.toLowerCase()) {
          throw new WalletFlowError("Wallet returned a receipt for a different transaction.");
        }
        if (
          options.expectedFrom &&
          (!isAddress(receipt.from) ||
            !sameAddress(receipt.from, options.expectedFrom))
        ) {
          throw new WalletFlowError("Launch receipt sender does not match the creator.");
        }
        if (
          options.expectedTo &&
          (!receipt.to ||
            !isAddress(receipt.to) ||
            !sameAddress(receipt.to, options.expectedTo))
        ) {
          throw new WalletFlowError("Launch receipt target does not match the factory.");
        }
        if (BigInt(receipt.status) !== BigInt(1)) {
          throw new WalletFlowError("The transaction reverted on-chain.");
        }
        return receipt;
      }

      await abortableDelay(pollIntervalMs, options.signal);
    }
    throw new WalletFlowError(
      "Transaction is still pending. Check the explorer before trying again.",
    );
  }

  async confirmLaunch(
    hash: Hex,
    expected: { creator: Address; predictedToken: Address },
  ): Promise<ConfirmedLaunch> {
    const receipt = await this.waitForReceipt(hash, {
      expectedFrom: expected.creator,
      expectedTo: this.factoryAddress,
    });
    const launched = launchedTokenFromReceipt(receipt, this.factoryAddress);
    if (!sameAddress(launched.token, expected.predictedToken)) {
      throw new WalletFlowError(
        "Launch receipt token does not match the mined prediction.",
      );
    }
    return { receipt, ...launched };
  }

  async confirmApproval(hash: Hex, owner: Address) {
    return this.waitForReceipt(hash, {
      expectedFrom: owner,
      expectedTo: this.quoteTokenAddress,
    });
  }
}

export function abortableDelay(milliseconds: number, signal?: AbortSignal) {
  if (signal?.aborted) {
    return Promise.reject(new WalletFlowError("Receipt check cancelled."));
  }

  return new Promise<void>((resolve, reject) => {
    function cleanup() {
      signal?.removeEventListener("abort", onAbort);
    }
    function onAbort() {
      clearTimeout(timeout);
      cleanup();
      reject(new WalletFlowError("Receipt check cancelled."));
    }

    const timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
