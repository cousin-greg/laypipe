import {
  decodeEventLog,
  decodeFunctionResult,
  encodeFunctionData,
  parseAbi,
} from "viem";

import {
  assertAuditedMaintenanceDeployment,
  type AuditedDeploymentManifest,
} from "./deployment-manifest";
import {
  abortableDelay,
  describeWalletError,
  ensureRobinhoodChain,
  WalletFlowError,
} from "./launch-client";
import {
  ROBINHOOD_CHAIN_ID_HEX,
  ROBINHOOD_PUBLIC_RPC_URL,
} from "./chains";
import type {
  Address,
  Eip1193RequestArguments,
  Eip1193Provider,
  Hex,
  RpcTransactionReceipt,
  RpcTransactionRequest,
} from "./types";
import {
  isAddress,
  isHexData,
  isHexQuantity,
  isTransactionHash,
  sameAddress,
} from "./types";

const BPS_DENOMINATOR = BigInt(10_000);
const CLAIM_CONFIRMATION_BLOCKS = BigInt(2);
const CLAIM_ABI = parseAbi([
  "function pending(bytes32 poolId) view returns (uint256)",
  "function tab(bytes32 poolId) view returns (uint256)",
  "function poolConfigs(bytes32 poolId) view returns (address creator, uint40 launchTime, uint16 creatorFeeBps, uint24 baseFeeRate, uint24 launchFeeRate, uint32 launchFeeDecay, bool exists)",
  "function claim(bytes32 poolId) returns (uint256 amount)",
  "event CreatorFeesClaimed(bytes32 indexed poolId, address indexed creator, uint256 amount)",
]);

export interface CreatorClaimState {
  creator: Address;
  pending: bigint;
  swept: bigint;
  pendingCreatorShare: bigint;
  claimable: bigint;
  blockNumber: bigint;
  blockTag: Hex;
}

type MaintenanceVerifier = typeof assertAuditedMaintenanceDeployment;

export interface ClaimClientDependencies {
  confirmationProvider?: Eip1193Provider;
}

export interface ClaimSubmissionCallbacks {
  onSubmissionInvoked?: () => void;
  onSubmitted?: (hash: Hex) => void;
}

export class ClaimSubmissionIndeterminateError extends WalletFlowError {
  constructor(message: string, code?: number | string, causeData?: unknown) {
    super(message, code, causeData);
    this.name = "ClaimSubmissionIndeterminateError";
  }
}

export function isClaimSubmissionIndeterminate(error: unknown) {
  return error instanceof ClaimSubmissionIndeterminateError;
}

export class CanonicalClaimRevertedError extends WalletFlowError {
  constructor(message = "The claim reverted on-chain after canonical confirmation.") {
    super(message);
    this.name = "CanonicalClaimRevertedError";
  }
}

export function isCanonicalClaimReverted(error: unknown) {
  return error instanceof CanonicalClaimRevertedError;
}

function errorCode(error: unknown) {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "number" || typeof code === "string" ? code : undefined;
}

function explicitWalletRejection(error: unknown) {
  const code = errorCode(error);
  return code === 4001 || code === "4001";
}

export function createRobinhoodClaimConfirmationProvider(
  fetcher: typeof fetch = fetch,
): Eip1193Provider {
  let requestId = 0;
  return {
    async request<T>(args: Eip1193RequestArguments) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);
      try {
        const response = await fetcher(ROBINHOOD_PUBLIC_RPC_URL, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: (requestId += 1),
            method: args.method,
            ...(args.params === undefined ? {} : { params: args.params }),
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
        clearTimeout(timer);
      }
    },
  };
}

function rpcData(value: unknown, label: string): Hex {
  if (typeof value !== "string" || !isHexData(value)) {
    throw new WalletFlowError(`${label} returned malformed RPC data.`);
  }
  return value;
}

async function currentAccount(provider: Eip1193Provider, expected: Address) {
  const accounts = await provider.request<unknown>({ method: "eth_accounts" });
  if (
    !Array.isArray(accounts) ||
    typeof accounts[0] !== "string" ||
    !isAddress(accounts[0]) ||
    !sameAddress(accounts[0], expected)
  ) {
    throw new WalletFlowError("The active wallet account changed. Reconnect and try again.");
  }
}

async function assertSubmissionContext(
  provider: Eip1193Provider,
  expected: Address,
) {
  const [accounts, chainId] = await Promise.all([
    provider.request<unknown>({ method: "eth_accounts" }),
    provider.request<unknown>({ method: "eth_chainId" }),
  ]);
  if (
    typeof chainId !== "string" ||
    !isHexQuantity(chainId) ||
    BigInt(chainId) !== BigInt(ROBINHOOD_CHAIN_ID_HEX)
  ) {
    throw new WalletFlowError(
      "The active wallet chain changed. Switch back to Robinhood Chain.",
    );
  }
  if (
    !Array.isArray(accounts) ||
    typeof accounts[0] !== "string" ||
    !isAddress(accounts[0]) ||
    !sameAddress(accounts[0], expected)
  ) {
    throw new WalletFlowError(
      "The active wallet account changed. Reconnect and try again.",
    );
  }
}

async function hookRead(
  provider: Eip1193Provider,
  hook: Address,
  functionName: "poolConfigs" | "pending" | "tab",
  poolId: Hex,
  blockTag: Hex,
) {
  return rpcData(
    await provider.request<unknown>({
      method: "eth_call",
      params: [
        {
          to: hook,
          data: encodeFunctionData({
            abi: CLAIM_ABI,
            functionName,
            args: [poolId],
          }),
        },
        blockTag,
      ],
    }),
    `Hook ${functionName}`,
  );
}

function transactionReceipt(value: unknown): RpcTransactionReceipt | null {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new WalletFlowError("Wallet returned a malformed claim receipt.");
  }
  const receipt = value as Partial<RpcTransactionReceipt>;
  if (
    typeof receipt.transactionHash !== "string" ||
    !isTransactionHash(receipt.transactionHash) ||
    typeof receipt.blockHash !== "string" ||
    !isTransactionHash(receipt.blockHash) ||
    typeof receipt.blockNumber !== "string" ||
    !isHexQuantity(receipt.blockNumber) ||
    typeof receipt.status !== "string" ||
    !isHexQuantity(receipt.status) ||
    typeof receipt.from !== "string" ||
    !isAddress(receipt.from) ||
    (receipt.to !== null && (typeof receipt.to !== "string" || !isAddress(receipt.to))) ||
    !Array.isArray(receipt.logs)
  ) {
    throw new WalletFlowError("Wallet returned an incomplete claim receipt.");
  }
  return receipt as RpcTransactionReceipt;
}

function rpcQuantity(value: unknown, label: string): Hex {
  if (typeof value !== "string" || !isHexQuantity(value)) {
    throw new WalletFlowError(`${label} returned a malformed RPC quantity.`);
  }
  return value;
}

function assertCanonicalClaimTransaction(options: {
  transactionValue: unknown;
  blockValue: unknown;
  receipt: RpcTransactionReceipt;
  hash: Hex;
  account: Address;
  hook: Address;
  claimData: Hex;
}) {
  const {
    transactionValue,
    blockValue,
    receipt,
    hash,
    account,
    hook,
    claimData,
  } = options;
  if (
    !transactionValue ||
    typeof transactionValue !== "object" ||
    Array.isArray(transactionValue)
  ) {
    throw new WalletFlowError("Canonical claim transaction is malformed.");
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
    !sameAddress(transaction.from, account) ||
    typeof transaction.to !== "string" ||
    !isAddress(transaction.to) ||
    !sameAddress(transaction.to, hook) ||
    typeof transaction.input !== "string" ||
    !isHexData(transaction.input) ||
    transaction.input.toLowerCase() !== claimData.toLowerCase() ||
    typeof transaction.value !== "string" ||
    !isHexQuantity(transaction.value) ||
    BigInt(transaction.value) !== BigInt(0) ||
    typeof transaction.blockHash !== "string" ||
    transaction.blockHash.toLowerCase() !== receipt.blockHash.toLowerCase() ||
    typeof transaction.blockNumber !== "string" ||
    transaction.blockNumber.toLowerCase() !== receipt.blockNumber.toLowerCase()
  ) {
    throw new WalletFlowError(
      "Canonical claim input, value, sender, target, or block did not match the submitted intent.",
    );
  }

  if (!blockValue || typeof blockValue !== "object" || Array.isArray(blockValue)) {
    throw new WalletFlowError("Canonical claim block is malformed.");
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
      "Claim receipt block is not the canonical block containing the transaction.",
    );
  }
}

export class CreatorClaimClient {
  readonly provider: Eip1193Provider;
  readonly manifest: AuditedDeploymentManifest;
  private readonly verify: MaintenanceVerifier;
  private readonly confirmationProvider: Eip1193Provider;

  constructor(
    provider: Eip1193Provider,
    manifest: AuditedDeploymentManifest,
    verify: MaintenanceVerifier = assertAuditedMaintenanceDeployment,
    dependencies: ClaimClientDependencies = {},
  ) {
    this.provider = provider;
    this.manifest = manifest;
    this.verify = verify;
    this.confirmationProvider =
      dependencies.confirmationProvider ??
      createRobinhoodClaimConfirmationProvider();
  }

  async readClaimState(account: Address, poolId: Hex): Promise<CreatorClaimState> {
    await currentAccount(this.provider, account);
    const snapshot = await this.verify(this.provider, this.manifest);
    const hook = this.manifest.contracts.hook.address;
    const configData = await hookRead(
      this.provider,
      hook,
      "poolConfigs",
      poolId,
      snapshot.blockTag,
    );
    const [creator, , creatorFeeBps, , , , exists] = decodeFunctionResult({
      abi: CLAIM_ABI,
      functionName: "poolConfigs",
      data: configData,
    });
    if (!exists || !sameAddress(creator, account)) {
      throw new WalletFlowError("This wallet is not the current creator for that pool.");
    }
    const [pendingData, tabData] = await Promise.all([
      hookRead(this.provider, hook, "pending", poolId, snapshot.blockTag),
      hookRead(this.provider, hook, "tab", poolId, snapshot.blockTag),
    ]);
    const pending = decodeFunctionResult({
      abi: CLAIM_ABI,
      functionName: "pending",
      data: pendingData,
    });
    const swept = decodeFunctionResult({
      abi: CLAIM_ABI,
      functionName: "tab",
      data: tabData,
    });
    const pendingCreatorShare =
      (pending * BigInt(creatorFeeBps)) / BPS_DENOMINATOR;
    return {
      creator,
      pending,
      swept,
      pendingCreatorShare,
      claimable: swept + pendingCreatorShare,
      blockNumber: snapshot.blockNumber,
      blockTag: snapshot.blockTag,
    };
  }

  async claim(
    account: Address,
    poolId: Hex,
    callbacks: ClaimSubmissionCallbacks = {},
  ) {
    await ensureRobinhoodChain(this.provider);
    const initial = await this.readClaimState(account, poolId);
    if (initial.claimable === BigInt(0)) {
      throw new WalletFlowError("There is no claimable PIPEDOG for this pool.");
    }
    const transaction = {
      from: account,
      to: this.manifest.contracts.hook.address,
      data: encodeFunctionData({ abi: CLAIM_ABI, functionName: "claim", args: [poolId] }),
    } satisfies RpcTransactionRequest;
    try {
      const estimate = await this.provider.request<unknown>({
        method: "eth_estimateGas",
        params: [transaction],
      });
      if (typeof estimate !== "string" || !isHexQuantity(estimate)) {
        throw new WalletFlowError("Gas simulation returned a malformed quantity.");
      }
    } catch (error) {
      if (error instanceof WalletFlowError) throw error;
      throw new WalletFlowError(`Simulation failed: ${describeWalletError(error)}`);
    }

    await ensureRobinhoodChain(this.provider);
    const final = await this.readClaimState(account, poolId);
    if (final.claimable === BigInt(0)) {
      throw new WalletFlowError("The claimable balance changed to zero before submission.");
    }
    // These checks intentionally run after the last full manifest/state snapshot
    // so account or chain drift cannot hide in another long verification pass.
    await ensureRobinhoodChain(this.provider);
    await assertSubmissionContext(this.provider, account);
    callbacks.onSubmissionInvoked?.();
    try {
      const hash = await this.provider.request<unknown>({
        method: "eth_sendTransaction",
        params: [transaction],
      });
      if (typeof hash !== "string" || !isTransactionHash(hash)) {
        throw new ClaimSubmissionIndeterminateError(
          "The wallet may have broadcast the claim but returned an invalid hash. Do not retry until wallet activity is reconciled.",
        );
      }
      callbacks.onSubmitted?.(hash);
      return { hash, observedClaimable: final.claimable };
    } catch (error) {
      if (explicitWalletRejection(error)) {
        throw new WalletFlowError(
          "You rejected the wallet request.",
          errorCode(error),
          error,
        );
      }
      if (isClaimSubmissionIndeterminate(error)) throw error;
      throw new ClaimSubmissionIndeterminateError(
        "The wallet may have broadcast the claim. Do not retry until wallet activity is reconciled.",
        errorCode(error),
        error,
      );
    }
  }

  async confirmClaim(
    hash: Hex,
    expected: { account: Address; poolId: Hex },
    options: { timeoutMs?: number; pollIntervalMs?: number; signal?: AbortSignal } = {},
  ) {
    const timeoutMs = options.timeoutMs ?? 180_000;
    const pollIntervalMs = options.pollIntervalMs ?? 2_000;
    const started = Date.now();
    const claimData = encodeFunctionData({
      abi: CLAIM_ABI,
      functionName: "claim",
      args: [expected.poolId],
    });
    const confirmationChain = rpcQuantity(
      await this.confirmationProvider.request<unknown>({ method: "eth_chainId" }),
      "Independent confirmation chain ID",
    );
    if (BigInt(confirmationChain) !== BigInt(ROBINHOOD_CHAIN_ID_HEX)) {
      throw new WalletFlowError(
        "Independent confirmation RPC is not on Robinhood Chain.",
      );
    }
    while (Date.now() - started < timeoutMs) {
      if (options.signal?.aborted) throw new WalletFlowError("Receipt check cancelled.");
      const receipt = transactionReceipt(
        await this.confirmationProvider.request<unknown>({
          method: "eth_getTransactionReceipt",
          params: [hash],
        }),
      );
      if (!receipt) {
        await abortableDelay(pollIntervalMs, options.signal);
        continue;
      }
      if (!sameAddress(receipt.transactionHash, hash)) {
        throw new WalletFlowError("Wallet returned a receipt for a different transaction.");
      }
      if (!sameAddress(receipt.from, expected.account)) {
        throw new WalletFlowError("Claim receipt sender does not match the connected wallet.");
      }
      if (!receipt.to || !sameAddress(receipt.to, this.manifest.contracts.hook.address)) {
        throw new WalletFlowError("Claim receipt target does not match the audited hook.");
      }
      const receiptStatus = BigInt(receipt.status);
      if (receiptStatus !== BigInt(0) && receiptStatus !== BigInt(1)) {
        throw new WalletFlowError("Claim receipt returned an invalid status value.");
      }

      const [transactionValue, blockValue, headValue] = await Promise.all([
        this.confirmationProvider.request<unknown>({
          method: "eth_getTransactionByHash",
          params: [hash],
        }),
        this.confirmationProvider.request<unknown>({
          method: "eth_getBlockByNumber",
          params: [receipt.blockNumber, false],
        }),
        this.confirmationProvider.request<unknown>({ method: "eth_blockNumber" }),
      ]);
      if (!transactionValue || !blockValue) {
        await abortableDelay(pollIntervalMs, options.signal);
        continue;
      }
      assertCanonicalClaimTransaction({
        transactionValue,
        blockValue,
        receipt,
        hash,
        account: expected.account,
        hook: this.manifest.contracts.hook.address,
        claimData,
      });
      const head = BigInt(rpcQuantity(headValue, "Independent confirmation head"));
      const receiptBlock = BigInt(receipt.blockNumber);
      if (
        head < receiptBlock ||
        head - receiptBlock + BigInt(1) < CLAIM_CONFIRMATION_BLOCKS
      ) {
        await abortableDelay(pollIntervalMs, options.signal);
        continue;
      }
      if (receiptStatus === BigInt(0)) {
        throw new CanonicalClaimRevertedError();
      }
      let claimedAmount: bigint | null = null;
      for (const log of receipt.logs) {
        if (
          !log ||
          typeof log !== "object" ||
          typeof log.address !== "string" ||
          !isAddress(log.address) ||
          typeof log.data !== "string" ||
          !isHexData(log.data) ||
          !Array.isArray(log.topics) ||
          log.topics.length === 0 ||
          log.topics.some((topic) => typeof topic !== "string" || !isHexData(topic)) ||
          !sameAddress(log.address, this.manifest.contracts.hook.address)
        ) {
          continue;
        }
        try {
          const decoded = decodeEventLog({
            abi: CLAIM_ABI,
            eventName: "CreatorFeesClaimed",
            data: log.data,
            topics: log.topics as [Hex, ...Hex[]],
          });
          if (
            sameAddress(decoded.args.poolId, expected.poolId) &&
            sameAddress(decoded.args.creator, expected.account)
          ) {
            claimedAmount = decoded.args.amount;
            break;
          }
        } catch {
          // Other audited-hook events in the receipt are expected during sweep.
        }
      }
      if (claimedAmount === null) {
        throw new WalletFlowError("Confirmed receipt is missing the creator claim event.");
      }
      if (claimedAmount === BigInt(0)) {
        throw new WalletFlowError(
          "The confirmed claim paid zero PIPEDOG. Do not report it as a successful payout.",
        );
      }
      return { receipt, claimedAmount };
    }
    throw new WalletFlowError(
      "The claim is still pending. Check the explorer before trying again.",
    );
  }
}
