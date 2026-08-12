import {
  decodeAbiParameters,
  decodeFunctionResult,
  encodeAbiParameters,
  encodeFunctionData,
  keccak256,
  type Abi,
} from "viem";

import swapRouterAbiJson from "../../contracts/abi/LaypipeSwapRouter.json";
import tokenAbiJson from "../../contracts/abi/LaypipeToken.json";
import {
  decodeBool,
  decodeUint,
  encodeAllowanceCall,
  encodeApproveCall,
  encodeBalanceOfCall,
} from "./abi";
import {
  assertAuditedDeployment,
  DeploymentIntegrityError,
  type AuditedDeploymentManifest,
} from "./deployment-manifest";
import {
  abortableDelay,
  buildExactApprovalPlan,
  describeWalletError,
  WalletFlowError,
  type ExactApprovalPlan,
} from "./launch-client";
import {
  assertAddress,
  isAddress,
  isHexData,
  isHexQuantity,
  isTransactionHash,
  sameAddress,
  type Address,
  type Eip1193RequestArguments,
  type Eip1193Provider,
  type Hex,
  type RpcTransactionReceipt,
  type RpcTransactionRequest,
} from "./types";
import {
  ROBINHOOD_CHAIN_ID_HEX,
  ROBINHOOD_PUBLIC_RPC_URL,
} from "./chains";
import {
  TRADE_DEADLINE_BLOCK_BUDGET,
  TRADE_QUOTE_TTL_MS,
} from "./trade-policy";

export {
  TRADE_DEADLINE_BLOCK_BUDGET,
  TRADE_DEADLINE_STRESS_BLOCKS_PER_SECOND,
  TRADE_QUOTE_TTL_MS,
  TRADE_WALLET_SUBMISSION_GRACE_MS,
} from "./trade-policy";

const SWAP_ROUTER_ABI = swapRouterAbiJson as Abi;
const TOKEN_ABI = tokenAbiJson as Abi;
const ZERO = BigInt(0);
const ONE = BigInt(1);
const BASIS_POINTS = BigInt(10_000);

export const TRADE_CONFIRMATION_BLOCKS = BigInt(2);
export const MIN_TRADE_SLIPPAGE_BPS = 50;
export const MAX_TRADE_SLIPPAGE_BPS = 500;

export type TradeSide = "buy" | "sell";

export interface TradeTokenIdentity {
  chainId: number;
  tokenAddress: Address;
  poolId: Hex;
  hookAddress: Address;
  configId: string;
  feeMode: "creator" | "self-burn";
}

export interface LaypipePoolKey {
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
}

export interface VerifiedTradePool {
  key: LaypipePoolKey;
  poolId: Hex;
  configId: bigint;
  feeMode: TradeTokenIdentity["feeMode"];
}

export interface TradePreflight {
  blockNumber: bigint;
  blockTag: Hex;
  owner: Address;
  side: TradeSide;
  inputAmount: bigint;
  inputToken: Address;
  inputSymbol: string;
  inputBalance: bigint;
  allowance: bigint;
  approvalPlan: ExactApprovalPlan;
  pool: VerifiedTradePool;
}

export interface TradeQuote {
  side: TradeSide;
  owner: Address;
  tokenAddress: Address;
  poolId: Hex;
  inputAmount: bigint;
  expectedOutput: bigint;
  minimumOutput: bigint;
  slippageBps: number;
  verifiedBlockNumber: bigint;
  deadlineBlock: bigint;
  createdAtMs: number;
  expiresAtMs: number;
}

export interface PendingTradeApproval {
  hash: Hex;
  token: Address;
  amount: bigint;
  kind: "reset" | "approve-exact";
  inputSymbol: string;
}

export interface PendingTrade {
  hash: Hex;
  simulatedOutput: bigint;
}

export interface TradeApprovalSubmissionIntent {
  token: Address;
  amount: bigint;
  kind: PendingTradeApproval["kind"];
  inputSymbol: string;
  target: Address;
  calldata: Hex;
}

export interface TradeSwapSubmissionIntent {
  target: Address;
  calldata: Hex;
  quote: TradeQuote;
  simulatedOutput: bigint;
}

export interface TradeSubmissionCallbacks<TIntent> {
  onSubmissionInvoked?: (intent: TIntent) => void;
  onSubmitted?: (hash: Hex, intent: TIntent) => void;
}

export interface ConfirmedTradeApproval {
  receipt: RpcTransactionReceipt;
  allowance: bigint;
  allowanceMatchesIntent: boolean;
}

export interface ConfirmedTrade {
  receipt: RpcTransactionReceipt;
  inputSpent: bigint;
  outputReceived: bigint;
  allowanceCleared: boolean;
}

type VerifiedDeploymentSnapshot = Awaited<
  ReturnType<typeof assertAuditedDeployment>
>;

export interface TradeClientDependencies {
  now?: () => number;
  confirmationProvider?: Eip1193Provider;
  verifyDeployment?: (
    provider: Eip1193Provider,
    manifest: AuditedDeploymentManifest,
  ) => Promise<VerifiedDeploymentSnapshot>;
}

export class TradeSubmissionIndeterminateError extends WalletFlowError {
  constructor(message: string, code?: number | string, causeData?: unknown) {
    super(message, code, causeData);
    this.name = "TradeSubmissionIndeterminateError";
  }
}

export class CanonicalTradeRevertedError extends WalletFlowError {
  constructor(message = "The transaction reverted on-chain.") {
    super(message);
    this.name = "CanonicalTradeRevertedError";
  }
}

export function isTradeSubmissionIndeterminate(error: unknown) {
  return error instanceof TradeSubmissionIndeterminateError;
}

export function isCanonicalTradeReverted(error: unknown) {
  return error instanceof CanonicalTradeRevertedError;
}

function errorCode(error: unknown) {
  if (!error || typeof error !== "object" || !("code" in error)) {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "number" || typeof code === "string"
    ? code
    : undefined;
}

function explicitWalletRejection(error: unknown) {
  const code = errorCode(error);
  return code === 4001 || code === "4001";
}

export function createRobinhoodTradeConfirmationProvider(
  fetcher: typeof fetch = fetch,
): Eip1193Provider {
  let requestId = 0;
  return {
    async request<T>(args: Eip1193RequestArguments) {
      const { method, params } = args;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);
      try {
        const response = await fetcher(ROBINHOOD_PUBLIC_RPC_URL, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: (requestId += 1),
            method,
            ...(params === undefined ? {} : { params }),
          }),
          cache: "no-store",
          credentials: "omit",
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new WalletFlowError(
            `Independent Robinhood RPC returned HTTP ${response.status}.`,
          );
        }
        const payload = (await response.json()) as {
          result?: unknown;
          error?: { code?: number; message?: string };
        };
        if (payload.error) {
          throw new WalletFlowError(
            payload.error.message ?? "Independent Robinhood RPC request failed.",
            payload.error.code,
            payload.error,
          );
        }
        if (!("result" in payload)) {
          throw new WalletFlowError(
            "Independent Robinhood RPC response omitted its result.",
          );
        }
        return payload.result as T;
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}

async function boundedProviderRequest<T>(
  provider: Eip1193Provider,
  args: Eip1193RequestArguments,
  options: { signal?: AbortSignal; deadlineAt: number; label: string },
) {
  if (options.signal?.aborted) {
    throw new WalletFlowError("Receipt check cancelled.");
  }
  const remaining = options.deadlineAt - Date.now();
  if (remaining <= 0) {
    throw new WalletFlowError(
      "Transaction is still pending. Check the explorer before trying again.",
    );
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    function cleanup() {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    }
    function finish(callback: () => void) {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    }
    function onAbort() {
      finish(() => reject(new WalletFlowError("Receipt check cancelled.")));
    }
    const timer = setTimeout(
      () =>
        finish(() =>
          reject(
            new WalletFlowError(
              `${options.label} timed out. The transaction remains pending-unknown.`,
            ),
          ),
        ),
      remaining,
    );
    options.signal?.addEventListener("abort", onAbort, { once: true });
    provider.request<T>(args).then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}

function failIntegrity(message: string): never {
  throw new DeploymentIntegrityError(message);
}

function assertBytes32(value: string, label: string): Hex {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new WalletFlowError(`${label} is not a bytes32 value.`);
  }
  return value as Hex;
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

function assertHash(value: unknown, label: string): Hex {
  if (typeof value !== "string" || !isTransactionHash(value)) {
    throw new WalletFlowError(`${label} returned an invalid transaction hash.`);
  }
  return value;
}

function assertTradeAmount(amount: bigint) {
  if (amount <= ZERO) {
    throw new WalletFlowError("Enter a trade amount greater than zero.");
  }
}

function configIdFromIdentity(value: string) {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new WalletFlowError("The indexed launch config ID is malformed.");
  }
  return BigInt(value);
}

function addressTopic(value: Address) {
  return `0x${value.slice(2).padStart(64, "0")}`.toLowerCase();
}

function topicAddress(value: Hex, label: string) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new WalletFlowError(`${label} event topic is malformed.`);
  }
  return assertAddress(`0x${value.slice(-40)}`, label);
}

function expectedCloneRuntime(implementation: Address) {
  return `0x363d3d373d3d3d363d73${implementation
    .slice(2)
    .toLowerCase()}5af43d82803e903d91602b57fd5bf3` as Hex;
}

function inputTokenFor(
  manifest: AuditedDeploymentManifest,
  identity: TradeTokenIdentity,
  side: TradeSide,
) {
  return side === "buy"
    ? manifest.contracts.pipedog.address
    : identity.tokenAddress;
}

function inputSymbolFor(side: TradeSide) {
  return side === "buy" ? "PIPEDOG" : "launch token";
}

export function describeTradeError(error: unknown) {
  if (isTradeSubmissionIndeterminate(error)) {
    return error instanceof Error
      ? error.message
      : "The wallet may have broadcast the transaction. Do not retry until wallet activity is reconciled.";
  }
  const message = error instanceof Error ? error.message : "";
  if (/allowance|approve/i.test(message)) {
    return "The input-token allowance is not the exact trade amount. Refresh or clear it before trading.";
  }
  if (/slippage|minimum.*out|quote.*moved/i.test(message)) {
    return "The simulated quote expired or moved beyond your minimum. Prepare a fresh quote.";
  }
  if (/quote.*expired|block drift|older block/i.test(message)) {
    return "The quote is stale. Prepare a fresh quote before submitting.";
  }
  const described = describeWalletError(error);
  return described.replace(/ before launching\.?$/i, " before trading.");
}

/**
 * Reconstruct the only pool key the audited factory can have launched for the
 * indexed identity. This makes an API row insufficient by itself to select an
 * arbitrary router call.
 */
export function resolveVerifiedTradePool(
  manifest: AuditedDeploymentManifest,
  identity: TradeTokenIdentity,
): VerifiedTradePool {
  if (manifest.testOnly || manifest.environment !== "robinhood-production") {
    failIntegrity("Trading requires the audited Robinhood production manifest.");
  }
  if (identity.chainId !== manifest.chain.chainId) {
    failIntegrity("Indexed token chain does not match the audited deployment.");
  }
  if (!sameAddress(identity.hookAddress, manifest.contracts.hook.address)) {
    failIntegrity("Indexed token hook does not match the audited deployment.");
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(identity.poolId)) {
    failIntegrity("Indexed pool ID is malformed.");
  }
  if (
    BigInt(identity.tokenAddress) <=
    BigInt(manifest.contracts.pipedog.address)
  ) {
    failIntegrity("Launch token is not ordered above canonical PIPEDOG.");
  }

  const configId = configIdFromIdentity(identity.configId);
  const expectedConfig =
    identity.feeMode === "creator"
      ? manifest.launch.creator
      : manifest.launch.selfBurn;
  if (configId !== expectedConfig.id) {
    failIntegrity("Indexed fee mode does not match the audited launch config.");
  }

  const key: LaypipePoolKey = {
    currency0: manifest.contracts.pipedog.address,
    currency1: identity.tokenAddress,
    fee: 0,
    tickSpacing: expectedConfig.config.tickSpacing,
    hooks: manifest.contracts.hook.address,
  };
  const calculatedPoolId = keccak256(
    encodeAbiParameters(
      [
        {
          type: "tuple",
          components: [
            { name: "currency0", type: "address" },
            { name: "currency1", type: "address" },
            { name: "fee", type: "uint24" },
            { name: "tickSpacing", type: "int24" },
            { name: "hooks", type: "address" },
          ],
        },
      ],
      [key],
    ),
  );
  if (calculatedPoolId.toLowerCase() !== identity.poolId.toLowerCase()) {
    failIntegrity("Indexed pool ID does not match the audited PoolKey.");
  }

  return {
    key,
    poolId: assertBytes32(identity.poolId, "Indexed pool ID"),
    configId,
    feeMode: identity.feeMode,
  };
}

export function applyTradeSlippage(output: bigint, slippageBps: number) {
  if (output <= ZERO) {
    throw new WalletFlowError("The router simulation returned no output.");
  }
  if (
    !Number.isInteger(slippageBps) ||
    slippageBps < MIN_TRADE_SLIPPAGE_BPS ||
    slippageBps > MAX_TRADE_SLIPPAGE_BPS
  ) {
    throw new WalletFlowError(
      `Slippage must be between ${MIN_TRADE_SLIPPAGE_BPS / 100}% and ${
        MAX_TRADE_SLIPPAGE_BPS / 100
      }%.`,
    );
  }
  const minimum =
    (output * (BASIS_POINTS - BigInt(slippageBps))) / BASIS_POINTS;
  if (minimum <= ZERO) {
    throw new WalletFlowError(
      "The quoted output is too small to protect with this slippage setting.",
    );
  }
  return minimum;
}

export function encodeLaypipeTradeCall(options: {
  side: TradeSide;
  pool: VerifiedTradePool;
  inputAmount: bigint;
  minimumOutput: bigint;
  recipient: Address;
  deadlineBlock: bigint;
}) {
  return encodeFunctionData({
    abi: SWAP_ROUTER_ABI,
    functionName: options.side === "buy" ? "buy" : "sell",
    args: [
      options.pool.key,
      options.inputAmount,
      options.minimumOutput,
      options.recipient,
      options.deadlineBlock,
    ],
  });
}

function decodeTradeOutput(side: TradeSide, data: Hex) {
  const result = decodeFunctionResult({
    abi: SWAP_ROUTER_ABI,
    functionName: side === "buy" ? "buy" : "sell",
    data,
  });
  if (typeof result !== "bigint") {
    throw new WalletFlowError("The router simulation returned malformed output.");
  }
  return result;
}

function tokenIdentityCall(name: "factory" | "poolId" | "hook" | "decimals") {
  return encodeFunctionData({ abi: TOKEN_ABI, functionName: name });
}

function decodeTokenIdentityCall(
  name: "factory" | "poolId" | "hook" | "decimals",
  data: Hex,
) {
  return decodeFunctionResult({ abi: TOKEN_ABI, functionName: name, data });
}

function approvalPlanForAsset(
  allowance: bigint,
  inputAmount: bigint,
  symbol: string,
) {
  const plan = buildExactApprovalPlan(allowance, inputAmount);
  return {
    ...plan,
    steps: plan.steps.map((step) => ({
      ...step,
      label:
        step.kind === "reset"
          ? `Reset stale ${symbol} allowance`
          : `Approve exact ${symbol} amount`,
    })),
  };
}

function tradeEventTopic(side: TradeSide) {
  return keccak256(
    new TextEncoder().encode(
      side === "buy"
        ? "Bought(bytes32,address,address,uint256,uint256)"
        : "Sold(bytes32,address,address,uint256,uint256)",
    ),
  );
}

function matchingTradeLog(
  receipt: RpcTransactionReceipt,
  router: Address,
  quote: TradeQuote,
) {
  const topic = tradeEventTopic(quote.side).toLowerCase();
  const logs = receipt.logs.filter(
    (log) =>
      sameAddress(log.address, router) &&
      log.topics[0]?.toLowerCase() === topic,
  );
  if (logs.length !== 1) {
    throw new WalletFlowError(
      "Confirmed transaction did not contain exactly one expected router trade event.",
    );
  }
  const log = logs[0]!;
  if (log.topics.length !== 4) {
    throw new WalletFlowError("Router trade event topics are malformed.");
  }
  if (log.topics[1]?.toLowerCase() !== quote.poolId.toLowerCase()) {
    throw new WalletFlowError("Router trade event pool does not match the quote.");
  }
  const sender = topicAddress(log.topics[2]!, "Trade sender");
  const recipient = topicAddress(log.topics[3]!, "Trade recipient");
  if (!sameAddress(sender, quote.owner) || !sameAddress(recipient, quote.owner)) {
    throw new WalletFlowError("Router trade event wallet does not match the quote.");
  }
  const [inputSpent, outputReceived] = decodeAbiParameters(
    [{ type: "uint256" }, { type: "uint256" }],
    log.data,
  );
  if (
    inputSpent <= ZERO ||
    inputSpent > quote.inputAmount ||
    outputReceived < quote.minimumOutput
  ) {
    throw new WalletFlowError("Router trade event amounts do not match the quote bounds.");
  }
  return { inputSpent, outputReceived };
}

export class LaypipeTradeClient {
  readonly provider: Eip1193Provider;
  readonly manifest: AuditedDeploymentManifest;
  readonly identity: TradeTokenIdentity;
  private readonly now: () => number;
  private readonly confirmationProvider: Eip1193Provider;
  private readonly verifyDeployment: NonNullable<
    TradeClientDependencies["verifyDeployment"]
  >;

  constructor(
    provider: Eip1193Provider,
    manifest: AuditedDeploymentManifest,
    identity: TradeTokenIdentity,
    dependencies: TradeClientDependencies = {},
  ) {
    this.provider = provider;
    this.manifest = manifest;
    this.identity = identity;
    this.now = dependencies.now ?? Date.now;
    this.confirmationProvider = dependencies.confirmationProvider ?? provider;
    this.verifyDeployment =
      dependencies.verifyDeployment ?? assertAuditedDeployment;
    // Fail before touching the wallet if server-provided identity cannot
    // reconstruct the canonical PIPEDOG PoolKey.
    resolveVerifiedTradePool(manifest, identity);
  }

  private async call(
    to: Address,
    data: Hex,
    blockTag: Hex,
    from?: Address,
    provider: Eip1193Provider = this.provider,
    options: { signal?: AbortSignal; deadlineAt?: number } = {},
  ) {
    const request = {
      method: "eth_call",
      params: [{ to, data, ...(from ? { from } : {}) }, blockTag],
    } as const;
    return assertRpcData(
      options.deadlineAt === undefined
        ? await provider.request<unknown>(request)
        : await boundedProviderRequest<unknown>(provider, request, {
            signal: options.signal,
            deadlineAt: options.deadlineAt,
            label: "Independent contract read",
          }),
      "Contract call",
    );
  }

  private async assertSelectedAccount(owner: Address) {
    const accounts = await this.provider.request<unknown>({ method: "eth_accounts" });
    if (
      !Array.isArray(accounts) ||
      typeof accounts[0] !== "string" ||
      !isAddress(accounts[0]) ||
      !sameAddress(accounts[0], owner)
    ) {
      throw new WalletFlowError(
        "The active wallet account changed. Reconnect and prepare the trade again.",
      );
    }
  }

  private async assertSubmissionContext(
    owner: Address,
    deadlineBlock?: bigint,
    quote?: TradeQuote,
  ) {
    const [chainIdValue, accounts, blockNumberValue] = await Promise.all([
      this.provider.request<unknown>({ method: "eth_chainId" }),
      this.provider.request<unknown>({ method: "eth_accounts" }),
      deadlineBlock === undefined
        ? Promise.resolve<unknown>(undefined)
        : this.provider.request<unknown>({ method: "eth_blockNumber" }),
    ]);
    const chainId = assertRpcQuantity(chainIdValue, "Selected chain ID");
    if (BigInt(chainId) !== BigInt(ROBINHOOD_CHAIN_ID_HEX)) {
      throw new WalletFlowError(
        "The active wallet chain changed. Switch back to Robinhood Chain and prepare again.",
      );
    }
    if (
      !Array.isArray(accounts) ||
      typeof accounts[0] !== "string" ||
      !isAddress(accounts[0]) ||
      !sameAddress(accounts[0], owner)
    ) {
      throw new WalletFlowError(
        "The active wallet account changed. Reconnect and prepare the trade again.",
      );
    }
    if (deadlineBlock !== undefined) {
      const latestBlock = BigInt(
        assertRpcQuantity(blockNumberValue, "Latest chain block"),
      );
      if (quote) this.assertQuote(quote, latestBlock);
      if (latestBlock > deadlineBlock) {
        throw new WalletFlowError(
          "The trade deadline passed before wallet submission. Prepare a fresh quote.",
        );
      }
    }
  }

  private async verifiedContext(owner: Address) {
    const deployment = await this.verifyDeployment(this.provider, this.manifest);
    await this.assertSelectedAccount(owner);
    const pool = resolveVerifiedTradePool(this.manifest, this.identity);
    const blockTag = deployment.blockTag;
    const [runtime, factoryData, poolData, hookData, decimalsData] =
      await Promise.all([
        this.provider.request<unknown>({
          method: "eth_getCode",
          params: [this.identity.tokenAddress, blockTag],
        }),
        this.call(
          this.identity.tokenAddress,
          tokenIdentityCall("factory"),
          blockTag,
        ),
        this.call(
          this.identity.tokenAddress,
          tokenIdentityCall("poolId"),
          blockTag,
        ),
        this.call(
          this.identity.tokenAddress,
          tokenIdentityCall("hook"),
          blockTag,
        ),
        this.call(
          this.identity.tokenAddress,
          tokenIdentityCall("decimals"),
          blockTag,
        ),
      ]);

    const cloneRuntime = assertRpcData(runtime, "Launch-token bytecode");
    if (
      cloneRuntime.toLowerCase() !==
      expectedCloneRuntime(
        this.manifest.contracts.tokenImplementation.address,
      ).toLowerCase()
    ) {
      failIntegrity(
        "Launch token is not the immutable clone of the audited implementation.",
      );
    }
    const factory = decodeTokenIdentityCall("factory", factoryData);
    const tokenPoolId = decodeTokenIdentityCall("poolId", poolData);
    const hook = decodeTokenIdentityCall("hook", hookData);
    const decimals = decodeTokenIdentityCall("decimals", decimalsData);
    if (
      typeof factory !== "string" ||
      !isAddress(factory) ||
      !sameAddress(factory, this.manifest.contracts.factoryProxy.address)
    ) {
      failIntegrity("Launch token factory binding does not match the audited factory.");
    }
    if (
      typeof tokenPoolId !== "string" ||
      tokenPoolId.toLowerCase() !== pool.poolId.toLowerCase()
    ) {
      failIntegrity("Launch token pool binding does not match the indexed pool.");
    }
    if (
      typeof hook !== "string" ||
      !isAddress(hook) ||
      !sameAddress(hook, this.manifest.contracts.hook.address)
    ) {
      failIntegrity("Launch token hook binding does not match the audited hook.");
    }
    if ((typeof decimals !== "number" && typeof decimals !== "bigint") || BigInt(decimals) !== BigInt(18)) {
      failIntegrity("Launch token does not use the audited 18-decimal interface.");
    }

    return { ...deployment, pool };
  }

  async readPreflight(
    owner: Address,
    side: TradeSide,
    inputAmount: bigint,
  ): Promise<TradePreflight> {
    assertTradeAmount(inputAmount);
    const context = await this.verifiedContext(owner);
    const inputToken = inputTokenFor(this.manifest, this.identity, side);
    const [allowanceData, balanceData] = await Promise.all([
      this.call(
        inputToken,
        encodeAllowanceCall(owner, this.manifest.contracts.swapRouter.address),
        context.blockTag,
      ),
      this.call(inputToken, encodeBalanceOfCall(owner), context.blockTag),
    ]);
    const allowance = decodeUint(allowanceData);
    const inputBalance = decodeUint(balanceData);
    const inputSymbol = inputSymbolFor(side);
    return {
      ...context,
      owner,
      side,
      inputAmount,
      inputToken,
      inputSymbol,
      inputBalance,
      allowance,
      approvalPlan: approvalPlanForAsset(
        allowance,
        inputAmount,
        inputSymbol,
      ),
    };
  }

  private assertBalance(preflight: TradePreflight) {
    if (preflight.inputBalance < preflight.inputAmount) {
      throw new WalletFlowError(
        `The connected wallet does not have enough ${preflight.inputSymbol} for this trade.`,
      );
    }
  }

  private async simulateApproval(
    transaction: RpcTransactionRequest,
    blockTag: Hex,
  ) {
    const result = await this.call(
      transaction.to,
      transaction.data,
      blockTag,
      transaction.from,
    );
    if (!decodeBool(result)) {
      throw new WalletFlowError("Token approval simulation returned false.");
    }
  }

  private async estimate(transaction: RpcTransactionRequest) {
    try {
      return assertRpcQuantity(
        await this.provider.request<unknown>({
          method: "eth_estimateGas",
          params: [transaction],
        }),
        "Gas simulation",
      );
    } catch (error) {
      throw new WalletFlowError(`Simulation failed: ${describeTradeError(error)}`);
    }
  }

  private async send(transaction: RpcTransactionRequest) {
    try {
      return assertHash(
        await this.provider.request<unknown>({
          method: "eth_sendTransaction",
          params: [transaction],
        }),
        "Transaction submission",
      );
    } catch (error) {
      const code = errorCode(error);
      if (explicitWalletRejection(error)) {
        throw new WalletFlowError(
          "You rejected the wallet request.",
          code,
          error,
        );
      }
      throw new TradeSubmissionIndeterminateError(
        "The wallet may have broadcast the transaction but did not return a trustworthy hash. Do not retry until you reconcile wallet activity.",
        code,
        error,
      );
    }
  }

  approvalCalldata(amount: bigint) {
    return encodeApproveCall(
      this.manifest.contracts.swapRouter.address,
      amount,
    );
  }

  async sendNextApproval(
    owner: Address,
    side: TradeSide,
    inputAmount: bigint,
    callbacks: TradeSubmissionCallbacks<TradeApprovalSubmissionIntent> = {},
  ): Promise<PendingTradeApproval> {
    const preflight = await this.readPreflight(owner, side, inputAmount);
    const step = preflight.approvalPlan.steps[0];
    if (!step) {
      throw new WalletFlowError("The allowance is already the exact trade amount.");
    }
    if (step.kind === "approve-exact") this.assertBalance(preflight);
    const transaction = {
      from: owner,
      to: preflight.inputToken,
      data: encodeApproveCall(
        this.manifest.contracts.swapRouter.address,
        step.amount,
      ),
    } as const;
    await this.simulateApproval(transaction, preflight.blockTag);
    await this.estimate(transaction);
    await this.assertSubmissionContext(owner);
    const submission = {
      token: preflight.inputToken,
      amount: step.amount,
      kind: step.kind,
      inputSymbol: preflight.inputSymbol,
      target: transaction.to,
      calldata: transaction.data,
    } satisfies TradeApprovalSubmissionIntent;
    callbacks.onSubmissionInvoked?.(submission);
    const hash = await this.send(transaction);
    try {
      callbacks.onSubmitted?.(hash, submission);
    } catch (error) {
      throw new TradeSubmissionIndeterminateError(
        "The wallet returned a hash, but its exact recovery intent could not be saved. Do not retry until wallet activity is reconciled.",
        errorCode(error),
        error,
      );
    }
    return {
      hash,
      token: preflight.inputToken,
      amount: step.amount,
      kind: step.kind,
      inputSymbol: preflight.inputSymbol,
    };
  }

  async clearAllowance(
    owner: Address,
    side: TradeSide,
    callbacks: TradeSubmissionCallbacks<TradeApprovalSubmissionIntent> = {},
  ) {
    const context = await this.verifiedContext(owner);
    const inputToken = inputTokenFor(this.manifest, this.identity, side);
    const allowance = decodeUint(
      await this.call(
        inputToken,
        encodeAllowanceCall(owner, this.manifest.contracts.swapRouter.address),
        context.blockTag,
      ),
    );
    if (allowance === ZERO) return null;
    const transaction = {
      from: owner,
      to: inputToken,
      data: encodeApproveCall(this.manifest.contracts.swapRouter.address, ZERO),
    } as const;
    await this.simulateApproval(transaction, context.blockTag);
    await this.estimate(transaction);
    await this.assertSubmissionContext(owner);
    const submission = {
      token: inputToken,
      amount: ZERO,
      kind: "reset" as const,
      inputSymbol: inputSymbolFor(side),
      target: transaction.to,
      calldata: transaction.data,
    } satisfies TradeApprovalSubmissionIntent;
    callbacks.onSubmissionInvoked?.(submission);
    const hash = await this.send(transaction);
    try {
      callbacks.onSubmitted?.(hash, submission);
    } catch (error) {
      throw new TradeSubmissionIndeterminateError(
        "The wallet returned a hash, but its exact recovery intent could not be saved. Do not retry until wallet activity is reconciled.",
        errorCode(error),
        error,
      );
    }
    return {
      hash,
      token: inputToken,
      amount: ZERO,
      kind: "reset" as const,
      inputSymbol: inputSymbolFor(side),
    };
  }

  async prepareQuote(options: {
    owner: Address;
    side: TradeSide;
    inputAmount: bigint;
    slippageBps: number;
  }): Promise<TradeQuote> {
    const preflight = await this.readPreflight(
      options.owner,
      options.side,
      options.inputAmount,
    );
    this.assertBalance(preflight);
    if (preflight.allowance !== options.inputAmount) {
      throw new WalletFlowError(
        "Quote simulation requires a single-use allowance equal to the exact input amount.",
      );
    }
    const deadlineBlock =
      preflight.blockNumber + TRADE_DEADLINE_BLOCK_BUDGET;
    const data = encodeLaypipeTradeCall({
      side: options.side,
      pool: preflight.pool,
      inputAmount: options.inputAmount,
      minimumOutput: ZERO,
      recipient: options.owner,
      deadlineBlock,
    });
    const expectedOutput = decodeTradeOutput(
      options.side,
      await this.call(
        this.manifest.contracts.swapRouter.address,
        data,
        preflight.blockTag,
        options.owner,
      ),
    );
    const minimumOutput = applyTradeSlippage(
      expectedOutput,
      options.slippageBps,
    );
    const createdAtMs = this.now();
    return {
      side: options.side,
      owner: options.owner,
      tokenAddress: this.identity.tokenAddress,
      poolId: preflight.pool.poolId,
      inputAmount: options.inputAmount,
      expectedOutput,
      minimumOutput,
      slippageBps: options.slippageBps,
      verifiedBlockNumber: preflight.blockNumber,
      deadlineBlock,
      createdAtMs,
      expiresAtMs: createdAtMs + TRADE_QUOTE_TTL_MS,
    };
  }

  private assertQuote(quote: TradeQuote, latestBlock: bigint) {
    if (
      quote.tokenAddress.toLowerCase() !== this.identity.tokenAddress.toLowerCase() ||
      quote.poolId.toLowerCase() !== this.identity.poolId.toLowerCase()
    ) {
      throw new WalletFlowError("Quote belongs to a different LayPipe pool.");
    }
    const now = this.now();
    if (
      quote.expiresAtMs !== quote.createdAtMs + TRADE_QUOTE_TTL_MS ||
      quote.createdAtMs > now
    ) {
      throw new WalletFlowError("Quote timing fields were modified or are invalid.");
    }
    if (now > quote.expiresAtMs) {
      throw new WalletFlowError("The quote expired. Prepare a fresh quote.");
    }
    if (latestBlock < quote.verifiedBlockNumber) {
      throw new WalletFlowError("Wallet RPC returned an older block than the quote.");
    }
    if (
      quote.deadlineBlock !==
      quote.verifiedBlockNumber + TRADE_DEADLINE_BLOCK_BUDGET
    ) {
      throw new WalletFlowError("Quote block deadline was modified.");
    }
    if (
      latestBlock > quote.deadlineBlock
    ) {
      throw new WalletFlowError("Quote exceeded the allowed block drift.");
    }
    const calculatedMinimum = applyTradeSlippage(
      quote.expectedOutput,
      quote.slippageBps,
    );
    if (quote.minimumOutput !== calculatedMinimum) {
      throw new WalletFlowError("Quote minimum output was modified.");
    }
  }

  async sendTrade(
    quote: TradeQuote,
    callbacks: TradeSubmissionCallbacks<TradeSwapSubmissionIntent> = {},
  ): Promise<PendingTrade> {
    assertTradeAmount(quote.inputAmount);
    const preflight = await this.readPreflight(
      quote.owner,
      quote.side,
      quote.inputAmount,
    );
    this.assertQuote(quote, preflight.blockNumber);
    this.assertBalance(preflight);
    if (preflight.allowance !== quote.inputAmount) {
      throw new WalletFlowError(
        "The exact single-use allowance changed after the quote was prepared.",
      );
    }
    const data = encodeLaypipeTradeCall({
      side: quote.side,
      pool: preflight.pool,
      inputAmount: quote.inputAmount,
      minimumOutput: quote.minimumOutput,
      recipient: quote.owner,
      deadlineBlock: quote.deadlineBlock,
    });
    const transaction = {
      from: quote.owner,
      to: this.manifest.contracts.swapRouter.address,
      data,
    } as const;
    const simulatedOutput = decodeTradeOutput(
      quote.side,
      await this.call(
        transaction.to,
        transaction.data,
        preflight.blockTag,
        quote.owner,
      ),
    );
    if (simulatedOutput < quote.minimumOutput) {
      throw new WalletFlowError("The quote moved below its minimum output.");
    }
    await this.estimate(transaction);
    await this.assertSubmissionContext(
      quote.owner,
      quote.deadlineBlock,
      quote,
    );
    const submission = {
      target: transaction.to,
      calldata: transaction.data,
      quote,
      simulatedOutput,
    } satisfies TradeSwapSubmissionIntent;
    callbacks.onSubmissionInvoked?.(submission);
    const hash = await this.send(transaction);
    try {
      callbacks.onSubmitted?.(hash, submission);
    } catch (error) {
      throw new TradeSubmissionIndeterminateError(
        "The wallet returned a hash, but its exact recovery intent could not be saved. Do not retry until wallet activity is reconciled.",
        errorCode(error),
        error,
      );
    }
    return { hash, simulatedOutput };
  }

  async waitForReceipt(
    hash: Hex,
    options: {
      expectedFrom: Address;
      expectedTo: Address;
      expectedData: Hex;
      timeoutMs?: number;
      pollIntervalMs?: number;
      signal?: AbortSignal;
    },
  ) {
    const started = Date.now();
    const timeoutMs = options.timeoutMs ?? 180_000;
    const pollIntervalMs = options.pollIntervalMs ?? 2_000;
    const deadlineAt = started + timeoutMs;
    const confirmationChain = assertRpcQuantity(
      await boundedProviderRequest<unknown>(
        this.confirmationProvider,
        { method: "eth_chainId" },
        {
          signal: options.signal,
          deadlineAt,
          label: "Independent chain confirmation request",
        },
      ),
      "Independent confirmation chain ID",
    );
    if (BigInt(confirmationChain) !== BigInt(ROBINHOOD_CHAIN_ID_HEX)) {
      throw new WalletFlowError(
        "Independent confirmation RPC is not on Robinhood Chain.",
      );
    }
    while (Date.now() - started < timeoutMs) {
      if (options.signal?.aborted) {
        throw new WalletFlowError("Receipt check cancelled.");
      }
      const value = await boundedProviderRequest<unknown>(
        this.confirmationProvider,
        { method: "eth_getTransactionReceipt", params: [hash] },
        {
          signal: options.signal,
          deadlineAt,
          label: "Independent receipt request",
        },
      );
      if (value) {
        const receipt = value as RpcTransactionReceipt;
        if (
          !isTransactionHash(receipt.transactionHash) ||
          receipt.transactionHash.toLowerCase() !== hash.toLowerCase() ||
          !isTransactionHash(receipt.blockHash) ||
          !isHexQuantity(receipt.status) ||
          !isHexQuantity(receipt.blockNumber) ||
          !isAddress(receipt.from) ||
          !sameAddress(receipt.from, options.expectedFrom) ||
          !receipt.to ||
          !isAddress(receipt.to) ||
          !sameAddress(receipt.to, options.expectedTo) ||
          !Array.isArray(receipt.logs)
        ) {
          throw new WalletFlowError("Wallet returned a mismatched transaction receipt.");
        }
        const [transactionValue, blockValue, headValue] = await Promise.all([
          boundedProviderRequest<unknown>(
            this.confirmationProvider,
            { method: "eth_getTransactionByHash", params: [hash] },
            {
              signal: options.signal,
              deadlineAt,
              label: "Independent transaction request",
            },
          ),
          boundedProviderRequest<unknown>(
            this.confirmationProvider,
            {
              method: "eth_getBlockByNumber",
              params: [receipt.blockNumber, false],
            },
            {
              signal: options.signal,
              deadlineAt,
              label: "Independent block request",
            },
          ),
          boundedProviderRequest<unknown>(
            this.confirmationProvider,
            { method: "eth_blockNumber" },
            {
              signal: options.signal,
              deadlineAt,
              label: "Independent head request",
            },
          ),
        ]);
        if (!transactionValue || !blockValue) {
          await abortableDelay(pollIntervalMs, options.signal);
          continue;
        }
        const transaction = transactionValue as {
          hash?: unknown;
          from?: unknown;
          to?: unknown;
          input?: unknown;
          value?: unknown;
          blockHash?: unknown;
          blockNumber?: unknown;
        };
        if (
          typeof transaction.hash !== "string" ||
          !isTransactionHash(transaction.hash) ||
          transaction.hash.toLowerCase() !== hash.toLowerCase() ||
          typeof transaction.from !== "string" ||
          !isAddress(transaction.from) ||
          !sameAddress(transaction.from, options.expectedFrom) ||
          typeof transaction.to !== "string" ||
          !isAddress(transaction.to) ||
          !sameAddress(transaction.to, options.expectedTo) ||
          typeof transaction.input !== "string" ||
          !isHexData(transaction.input) ||
          transaction.input.toLowerCase() !== options.expectedData.toLowerCase() ||
          typeof transaction.value !== "string" ||
          !isHexQuantity(transaction.value) ||
          BigInt(transaction.value) !== ZERO ||
          typeof transaction.blockHash !== "string" ||
          transaction.blockHash.toLowerCase() !== receipt.blockHash.toLowerCase() ||
          typeof transaction.blockNumber !== "string" ||
          transaction.blockNumber.toLowerCase() !== receipt.blockNumber.toLowerCase()
        ) {
          throw new WalletFlowError(
            "Canonical transaction input, value, sender, target, or block did not match the submitted intent.",
          );
        }

        const block = blockValue as {
          hash?: unknown;
          number?: unknown;
          transactions?: unknown;
        };
        if (
          typeof block.hash !== "string" ||
          !isTransactionHash(block.hash) ||
          block.hash.toLowerCase() !== receipt.blockHash.toLowerCase() ||
          typeof block.number !== "string" ||
          !isHexQuantity(block.number) ||
          BigInt(block.number) !== BigInt(receipt.blockNumber) ||
          !Array.isArray(block.transactions) ||
          !block.transactions.some(
            (transactionHash) =>
              typeof transactionHash === "string" &&
              isTransactionHash(transactionHash) &&
              transactionHash.toLowerCase() === hash.toLowerCase(),
          )
        ) {
          throw new WalletFlowError(
            "Receipt block is not the canonical block containing the transaction.",
          );
        }
        const head = BigInt(
          assertRpcQuantity(headValue, "Independent confirmation head"),
        );
        const receiptBlock = BigInt(receipt.blockNumber);
        if (
          head < receiptBlock ||
          head - receiptBlock + ONE < TRADE_CONFIRMATION_BLOCKS
        ) {
          await abortableDelay(pollIntervalMs, options.signal);
          continue;
        }
        if (BigInt(receipt.status) !== ONE) {
          throw new CanonicalTradeRevertedError();
        }
        return receipt;
      }
      await abortableDelay(pollIntervalMs, options.signal);
    }
    throw new WalletFlowError(
      "Transaction is still pending. Check the explorer before trying again.",
    );
  }

  async confirmApproval(
    pending: PendingTradeApproval,
    owner: Address,
    options: {
      signal?: AbortSignal;
      timeoutMs?: number;
      pollIntervalMs?: number;
    } = {},
  ): Promise<ConfirmedTradeApproval> {
    const timeoutMs = options.timeoutMs ?? 180_000;
    const deadlineAt = Date.now() + timeoutMs;
    const receipt = await this.waitForReceipt(pending.hash, {
      expectedFrom: owner,
      expectedTo: pending.token,
      expectedData: encodeApproveCall(
        this.manifest.contracts.swapRouter.address,
        pending.amount,
      ),
      signal: options.signal,
      timeoutMs,
      pollIntervalMs: options.pollIntervalMs,
    });
    const allowance = decodeUint(
      await this.call(
        pending.token,
        encodeAllowanceCall(
          owner,
          this.manifest.contracts.swapRouter.address,
        ),
        receipt.blockNumber,
        owner,
        this.confirmationProvider,
        { signal: options.signal, deadlineAt },
      ),
    );
    return {
      receipt,
      allowance,
      allowanceMatchesIntent: allowance === pending.amount,
    };
  }

  async confirmTrade(
    pending: PendingTrade,
    quote: TradeQuote,
    options: {
      signal?: AbortSignal;
      timeoutMs?: number;
      pollIntervalMs?: number;
    } = {},
  ): Promise<ConfirmedTrade> {
    const timeoutMs = options.timeoutMs ?? 180_000;
    const deadlineAt = Date.now() + timeoutMs;
    const pool = resolveVerifiedTradePool(this.manifest, this.identity);
    const expectedData = encodeLaypipeTradeCall({
      side: quote.side,
      pool,
      inputAmount: quote.inputAmount,
      minimumOutput: quote.minimumOutput,
      recipient: quote.owner,
      deadlineBlock: quote.deadlineBlock,
    });
    const receipt = await this.waitForReceipt(pending.hash, {
      expectedFrom: quote.owner,
      expectedTo: this.manifest.contracts.swapRouter.address,
      expectedData,
      signal: options.signal,
      timeoutMs,
      pollIntervalMs: options.pollIntervalMs,
    });
    const amounts = matchingTradeLog(
      receipt,
      this.manifest.contracts.swapRouter.address,
      quote,
    );
    const inputToken = inputTokenFor(this.manifest, this.identity, quote.side);
    const allowance = decodeUint(
      await this.call(
        inputToken,
        encodeAllowanceCall(
          quote.owner,
          this.manifest.contracts.swapRouter.address,
        ),
        receipt.blockNumber,
        quote.owner,
        this.confirmationProvider,
        { signal: options.signal, deadlineAt },
      ),
    );
    return {
      receipt,
      ...amounts,
      allowanceCleared: allowance === ZERO,
    };
  }
}

export function __testExpectedCloneRuntime(implementation: Address) {
  return expectedCloneRuntime(implementation);
}

export function __testTradeEventTopic(side: TradeSide) {
  return tradeEventTopic(side);
}

export function __testAddressTopic(value: Address) {
  return addressTopic(value);
}
