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
  createRobinhoodLaunchConfirmationProvider,
  describeWalletError,
  ensureRobinhoodChain,
  WalletFlowError,
} from "./launch-client";
import { ROBINHOOD_CHAIN_ID_HEX } from "./chains";
import type {
  Address,
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
const SEQUESTER_SHARE_BPS = BigInt(2_500);
const TREASURY_SHARE_BPS = BigInt(2_500);
const KEEPER_CONFIRMATION_BLOCKS = BigInt(2);
const SEQUESTER_SINK = "0x000000000000000000000000000000000000dEaD" as Address;

const KEEPER_ABI = parseAbi([
  "function pending(bytes32 poolId) view returns (uint256)",
  "function platformTab() view returns (uint256)",
  "function sweep(bytes32 poolId) returns (uint256 creatorAmount, uint256 platformAmount)",
  "function collectPlatform() returns (uint256 amount)",
  "function sequesterTank() view returns (uint256)",
  "function treasuryTank() view returns (uint256)",
  "function unallocated() view returns (uint256)",
  "function sequesterPipedog() returns (uint256 amount)",
  "function routeTreasuryPipedog() returns (uint256 amount)",
  "event FeesSwept(bytes32 indexed poolId, address indexed caller, uint256 creatorAmount, uint256 platformAmount)",
  "event PlatformPayoutCollected(address indexed treasury, uint256 amount)",
  "event PipedogSequestered(address indexed caller, uint256 pipedogSequestered, uint256 bounty, address indexed sink)",
  "event TreasuryPipedogRouted(address indexed caller, address indexed treasury, uint256 pipedogRouted, uint256 bounty)",
]);

const PLATFORM_TAB_CALL = encodeFunctionData({
  abi: KEEPER_ABI,
  functionName: "platformTab",
});
const SEQUESTER_TANK_CALL = encodeFunctionData({
  abi: KEEPER_ABI,
  functionName: "sequesterTank",
});
const TREASURY_TANK_CALL = encodeFunctionData({
  abi: KEEPER_ABI,
  functionName: "treasuryTank",
});
const UNALLOCATED_CALL = encodeFunctionData({
  abi: KEEPER_ABI,
  functionName: "unallocated",
});

export type KeeperAction =
  | { kind: "sweep"; poolId: Hex }
  | { kind: "collect-platform" }
  | { kind: "sequester" }
  | { kind: "route-treasury" };

export interface KeeperJobState {
  action: KeeperAction;
  target: Address;
  data: Hex;
  amountPipedog: bigint;
  bountyPipedog: bigint;
  routedPipedog: bigint;
  eligible: boolean;
  gasEstimate: bigint | null;
  reason: string | null;
  asOfBlock: bigint;
}

export interface KeeperSubmissionCallbacks {
  onSubmissionInvoked?: () => void | Promise<void>;
  onSubmitted?: (hash: Hex) => void | Promise<void>;
}

export interface KeeperClientDependencies {
  confirmationProvider?: Eip1193Provider;
  verifyDeployment?: typeof assertAuditedMaintenanceDeployment;
}

export class KeeperSubmissionIndeterminateError extends WalletFlowError {
  constructor(message: string, code?: number | string, causeData?: unknown) {
    super(message, code, causeData);
    this.name = "KeeperSubmissionIndeterminateError";
  }
}

export function isKeeperSubmissionIndeterminate(error: unknown) {
  return error instanceof KeeperSubmissionIndeterminateError;
}

export class CanonicalKeeperRevertedError extends WalletFlowError {
  constructor(message = "The keeper transaction reverted on-chain after canonical confirmation.") {
    super(message);
    this.name = "CanonicalKeeperRevertedError";
  }
}

export function isCanonicalKeeperReverted(error: unknown) {
  return error instanceof CanonicalKeeperRevertedError;
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

function poolId(value: string): Hex {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new WalletFlowError("Keeper pool ID is malformed.");
  }
  return value as Hex;
}

export function keeperActionData(action: KeeperAction): Hex {
  switch (action.kind) {
    case "sweep":
      return encodeFunctionData({
        abi: KEEPER_ABI,
        functionName: "sweep",
        args: [poolId(action.poolId)],
      });
    case "collect-platform":
      return encodeFunctionData({ abi: KEEPER_ABI, functionName: "collectPlatform" });
    case "sequester":
      return encodeFunctionData({ abi: KEEPER_ABI, functionName: "sequesterPipedog" });
    case "route-treasury":
      return encodeFunctionData({ abi: KEEPER_ABI, functionName: "routeTreasuryPipedog" });
  }
}

export function keeperActionCall(
  manifest: AuditedDeploymentManifest,
  action: KeeperAction,
): { target: Address; data: Hex } {
  const hookAction = action.kind === "sweep" || action.kind === "collect-platform";
  return {
    target: hookAction
      ? manifest.contracts.hook.address
      : manifest.contracts.revenueRouter.address,
    data: keeperActionData(action),
  };
}

function rpcData(value: unknown, label: string): Hex {
  if (typeof value !== "string" || !isHexData(value)) {
    throw new WalletFlowError(`${label} returned malformed RPC data.`);
  }
  return value;
}

function rpcQuantity(value: unknown, label: string): Hex {
  if (typeof value !== "string" || !isHexQuantity(value)) {
    throw new WalletFlowError(`${label} returned a malformed RPC quantity.`);
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
  minimumBlockNumber: bigint,
) {
  const [accounts, chainId, blockNumber] = await Promise.all([
    provider.request<unknown>({ method: "eth_accounts" }),
    provider.request<unknown>({ method: "eth_chainId" }),
    provider.request<unknown>({ method: "eth_blockNumber" }),
  ]);
  if (
    typeof chainId !== "string" ||
    !isHexQuantity(chainId) ||
    BigInt(chainId) !== BigInt(ROBINHOOD_CHAIN_ID_HEX)
  ) {
    throw new WalletFlowError("The active wallet chain changed. Switch back to Robinhood Chain.");
  }
  if (
    !Array.isArray(accounts) ||
    typeof accounts[0] !== "string" ||
    !isAddress(accounts[0]) ||
    !sameAddress(accounts[0], expected)
  ) {
    throw new WalletFlowError("The active wallet account changed. Reconnect and try again.");
  }
  const walletHead = BigInt(rpcQuantity(blockNumber, "Wallet block number"));
  if (walletHead < minimumBlockNumber) {
    throw new WalletFlowError(
      "The wallet RPC head is behind the final verified keeper snapshot. Wait for it to catch up and try again.",
    );
  }
}

async function readCall(
  provider: Eip1193Provider,
  target: Address,
  data: Hex,
  blockTag: Hex,
  label: string,
) {
  return rpcData(
    await provider.request<unknown>({
      method: "eth_call",
      params: [{ to: target, data }, blockTag],
    }),
    label,
  );
}

async function readPending(
  provider: Eip1193Provider,
  hook: Address,
  value: Hex,
  blockTag: Hex,
) {
  const data = await readCall(
    provider,
    hook,
    encodeFunctionData({
      abi: KEEPER_ABI,
      functionName: "pending",
      args: [poolId(value)],
    }),
    blockTag,
    "Hook pending",
  );
  return decodeFunctionResult({ abi: KEEPER_ABI, functionName: "pending", data });
}

async function readRouterState(
  provider: Eip1193Provider,
  router: Address,
  blockTag: Hex,
) {
  const [sequesterData, treasuryData, unallocatedData] = await Promise.all([
    readCall(provider, router, SEQUESTER_TANK_CALL, blockTag, "Sequester tank"),
    readCall(provider, router, TREASURY_TANK_CALL, blockTag, "Treasury tank"),
    readCall(provider, router, UNALLOCATED_CALL, blockTag, "Unallocated revenue"),
  ]);
  return {
    sequesterTank: decodeFunctionResult({
      abi: KEEPER_ABI,
      functionName: "sequesterTank",
      data: sequesterData,
    }),
    treasuryTank: decodeFunctionResult({
      abi: KEEPER_ABI,
      functionName: "treasuryTank",
      data: treasuryData,
    }),
    unallocated: decodeFunctionResult({
      abi: KEEPER_ABI,
      functionName: "unallocated",
      data: unallocatedData,
    }),
  };
}

async function estimate(
  provider: Eip1193Provider,
  transaction: RpcTransactionRequest,
) {
  return BigInt(
    rpcQuantity(
      await provider.request<unknown>({
        method: "eth_estimateGas",
        params: [transaction],
      }),
      "Keeper gas simulation",
    ),
  );
}

function baseJob(
  manifest: AuditedDeploymentManifest,
  action: KeeperAction,
  amountPipedog: bigint,
  bountyPipedog: bigint,
  asOfBlock: bigint,
): KeeperJobState {
  const call = keeperActionCall(manifest, action);
  return {
    action,
    ...call,
    amountPipedog,
    bountyPipedog,
    routedPipedog: amountPipedog >= bountyPipedog
      ? amountPipedog - bountyPipedog
      : BigInt(0),
    eligible: false,
    gasEstimate: null,
    reason: amountPipedog === BigInt(0) ? "Nothing is currently available to process." : null,
    asOfBlock,
  };
}

async function simulateJob(
  provider: Eip1193Provider,
  account: Address,
  job: KeeperJobState,
) {
  if (job.amountPipedog === BigInt(0)) return job;
  try {
    const gasEstimate = await estimate(provider, {
      from: account,
      to: job.target,
      data: job.data,
    });
    return { ...job, eligible: true, gasEstimate, reason: null };
  } catch (error) {
    return {
      ...job,
      eligible: false,
      gasEstimate: null,
      reason: `Current-state simulation failed: ${describeWalletError(error)}`,
    };
  }
}

function uniquePools(values: readonly Hex[]) {
  if (values.length > 20) throw new WalletFlowError("Too many sweep candidates were requested.");
  const result: Hex[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = poolId(value).toLowerCase();
    if (!seen.has(normalized)) {
      seen.add(normalized);
      result.push(value);
    }
  }
  return result;
}

function revenueJob(
  manifest: AuditedDeploymentManifest,
  action: Extract<KeeperAction, { kind: "sequester" | "route-treasury" }>,
  router: Awaited<ReturnType<typeof readRouterState>>,
  asOfBlock: bigint,
) {
  const isSequester = action.kind === "sequester";
  const fresh = isSequester
    ? (router.unallocated * SEQUESTER_SHARE_BPS) / BPS_DENOMINATOR
    : (router.unallocated * TREASURY_SHARE_BPS) / BPS_DENOMINATOR;
  const tank = (isSequester ? router.sequesterTank : router.treasuryTank) + fresh;
  const cap = isSequester
    ? manifest.routing.revenueMaxSequesterPerCall
    : manifest.routing.revenueMaxTreasuryRoutePerCall;
  const chunk = tank > cap ? cap : tank;
  const bounty = (chunk * BigInt(manifest.routing.revenueBountyBps)) / BPS_DENOMINATOR;
  return baseJob(manifest, action, chunk, bounty, asOfBlock);
}

function transactionReceipt(value: unknown): RpcTransactionReceipt | null {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new WalletFlowError("Independent RPC returned a malformed keeper receipt.");
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
    throw new WalletFlowError("Independent RPC returned an incomplete keeper receipt.");
  }
  return receipt as RpcTransactionReceipt;
}

function assertCanonicalTransaction(options: {
  transactionValue: unknown;
  blockValue: unknown;
  receipt: RpcTransactionReceipt;
  hash: Hex;
  account: Address;
  target: Address;
  data: Hex;
}) {
  const { transactionValue, blockValue, receipt, hash, account, target, data } = options;
  if (!transactionValue || typeof transactionValue !== "object" || Array.isArray(transactionValue)) {
    throw new WalletFlowError("Canonical keeper transaction is malformed.");
  }
  const transaction = transactionValue as Record<string, unknown>;
  if (
    typeof transaction.hash !== "string" ||
    !isTransactionHash(transaction.hash) ||
    transaction.hash.toLowerCase() !== hash.toLowerCase() ||
    typeof transaction.from !== "string" ||
    !isAddress(transaction.from) ||
    !sameAddress(transaction.from, account) ||
    typeof transaction.to !== "string" ||
    !isAddress(transaction.to) ||
    !sameAddress(transaction.to, target) ||
    typeof transaction.input !== "string" ||
    !isHexData(transaction.input) ||
    transaction.input.toLowerCase() !== data.toLowerCase() ||
    typeof transaction.value !== "string" ||
    !isHexQuantity(transaction.value) ||
    BigInt(transaction.value) !== BigInt(0) ||
    typeof transaction.blockHash !== "string" ||
    transaction.blockHash.toLowerCase() !== receipt.blockHash.toLowerCase() ||
    typeof transaction.blockNumber !== "string" ||
    transaction.blockNumber.toLowerCase() !== receipt.blockNumber.toLowerCase()
  ) {
    throw new WalletFlowError(
      "Canonical keeper input, value, sender, target, or block did not match the saved intent.",
    );
  }
  if (!blockValue || typeof blockValue !== "object" || Array.isArray(blockValue)) {
    throw new WalletFlowError("Canonical keeper block is malformed.");
  }
  const block = blockValue as Record<string, unknown>;
  if (
    typeof block.hash !== "string" ||
    !isTransactionHash(block.hash) ||
    block.hash.toLowerCase() !== receipt.blockHash.toLowerCase() ||
    typeof block.number !== "string" ||
    !isHexQuantity(block.number) ||
    BigInt(block.number) !== BigInt(receipt.blockNumber) ||
    !Array.isArray(block.transactions) ||
    !block.transactions.some(
      (entry) =>
        typeof entry === "string" &&
        isTransactionHash(entry) &&
        entry.toLowerCase() === hash.toLowerCase(),
    )
  ) {
    throw new WalletFlowError(
      "Keeper receipt block is not the canonical block containing the transaction.",
    );
  }
}

function effectFromReceipt(
  receipt: RpcTransactionReceipt,
  action: KeeperAction,
  account: Address,
  manifest: AuditedDeploymentManifest,
) {
  let matched = false;
  let amount = BigInt(0);
  let bounty = BigInt(0);
  for (const log of receipt.logs) {
    if (
      !log ||
      typeof log.address !== "string" ||
      !isAddress(log.address) ||
      typeof log.data !== "string" ||
      !isHexData(log.data) ||
      !Array.isArray(log.topics) ||
      log.topics.length === 0 ||
      log.topics.some((topic) => typeof topic !== "string" || !isHexData(topic))
    ) {
      continue;
    }
    const expectedTarget = keeperActionCall(manifest, action).target;
    if (!sameAddress(log.address, expectedTarget)) continue;
    try {
      if (action.kind === "sweep") {
        const decoded = decodeEventLog({
          abi: KEEPER_ABI,
          eventName: "FeesSwept",
          data: log.data,
          topics: log.topics as [Hex, ...Hex[]],
        });
        if (
          decoded.args.poolId.toLowerCase() === action.poolId.toLowerCase() &&
          sameAddress(decoded.args.caller, account)
        ) {
          matched = true;
          amount = decoded.args.creatorAmount + decoded.args.platformAmount;
        }
      } else if (action.kind === "collect-platform") {
        const decoded = decodeEventLog({
          abi: KEEPER_ABI,
          eventName: "PlatformPayoutCollected",
          data: log.data,
          topics: log.topics as [Hex, ...Hex[]],
        });
        if (sameAddress(decoded.args.treasury, manifest.contracts.revenueRouter.address)) {
          matched = true;
          amount = decoded.args.amount;
        }
      } else if (action.kind === "sequester") {
        const decoded = decodeEventLog({
          abi: KEEPER_ABI,
          eventName: "PipedogSequestered",
          data: log.data,
          topics: log.topics as [Hex, ...Hex[]],
        });
        if (
          sameAddress(decoded.args.caller, account) &&
          sameAddress(decoded.args.sink, SEQUESTER_SINK)
        ) {
          matched = true;
          amount = decoded.args.pipedogSequestered;
          bounty = decoded.args.bounty;
        }
      } else {
        const decoded = decodeEventLog({
          abi: KEEPER_ABI,
          eventName: "TreasuryPipedogRouted",
          data: log.data,
          topics: log.topics as [Hex, ...Hex[]],
        });
        if (
          sameAddress(decoded.args.caller, account) &&
          sameAddress(decoded.args.treasury, manifest.governance.treasury)
        ) {
          matched = true;
          amount = decoded.args.pipedogRouted;
          bounty = decoded.args.bounty;
        }
      }
    } catch {
      // Other audited events from the same transaction are intentionally ignored.
    }
  }
  if (!matched && (action.kind === "sequester" || action.kind === "route-treasury")) {
    throw new WalletFlowError("Confirmed revenue-router receipt is missing its exact keeper event.");
  }
  if (!matched && action.kind === "collect-platform") {
    throw new WalletFlowError("Confirmed platform collection is missing its exact payout event.");
  }
  // A sweep can become a canonical status-one no-op if another caller drains
  // pending fees between simulation and inclusion. It emits no FeesSwept event.
  return { amountPipedog: amount, bountyPipedog: bounty, noOp: !matched || amount === BigInt(0) };
}

export class KeeperClient {
  readonly provider: Eip1193Provider;
  readonly manifest: AuditedDeploymentManifest;
  private readonly confirmationProvider: Eip1193Provider;
  private readonly verify: typeof assertAuditedMaintenanceDeployment;

  constructor(
    provider: Eip1193Provider,
    manifest: AuditedDeploymentManifest,
    dependencies: KeeperClientDependencies = {},
  ) {
    this.provider = provider;
    this.manifest = manifest;
    this.confirmationProvider =
      dependencies.confirmationProvider ?? createRobinhoodLaunchConfirmationProvider();
    this.verify = dependencies.verifyDeployment ?? assertAuditedMaintenanceDeployment;
  }

  private async jobsAtVerifiedSnapshot(account: Address, sweepPools: readonly Hex[]) {
    await currentAccount(this.provider, account);
    const snapshot = await this.verify(this.provider, this.manifest);
    const pools = uniquePools(sweepPools);
    const [platformData, router, ...pendingValues] = await Promise.all([
      readCall(
        this.provider,
        this.manifest.contracts.hook.address,
        PLATFORM_TAB_CALL,
        snapshot.blockTag,
        "Hook platform tab",
      ),
      readRouterState(
        this.provider,
        this.manifest.contracts.revenueRouter.address,
        snapshot.blockTag,
      ),
      ...pools.map((pool) =>
        readPending(
          this.provider,
          this.manifest.contracts.hook.address,
          pool,
          snapshot.blockTag,
        ),
      ),
    ]);
    const platformTab = decodeFunctionResult({
      abi: KEEPER_ABI,
      functionName: "platformTab",
      data: platformData as Hex,
    });
    const jobs: KeeperJobState[] = [
      ...pools.map((pool, index) =>
        baseJob(
          this.manifest,
          { kind: "sweep", poolId: pool },
          pendingValues[index] as bigint,
          BigInt(0),
          snapshot.blockNumber,
        ),
      ),
      baseJob(
        this.manifest,
        { kind: "collect-platform" },
        platformTab,
        BigInt(0),
        snapshot.blockNumber,
      ),
      revenueJob(this.manifest, { kind: "sequester" }, router, snapshot.blockNumber),
      revenueJob(this.manifest, { kind: "route-treasury" }, router, snapshot.blockNumber),
    ];
    return Promise.all(jobs.map((job) => simulateJob(this.provider, account, job)));
  }

  async readJobs(account: Address, sweepPools: readonly Hex[]) {
    const jobs = await this.jobsAtVerifiedSnapshot(account, sweepPools);
    return { asOfBlock: jobs[0]?.asOfBlock ?? BigInt(0), jobs };
  }

  private async preflightAction(account: Address, action: KeeperAction) {
    const jobs = await this.jobsAtVerifiedSnapshot(
      account,
      action.kind === "sweep" ? [action.poolId] : [],
    );
    const job = jobs.find((candidate) => {
      if (candidate.action.kind !== action.kind) return false;
      return action.kind !== "sweep" ||
        (candidate.action.kind === "sweep" &&
          candidate.action.poolId.toLowerCase() === action.poolId.toLowerCase());
    });
    if (!job || !job.eligible) {
      throw new WalletFlowError(job?.reason ?? "This keeper action is not currently eligible.");
    }
    return job;
  }

  async submitAction(
    account: Address,
    action: KeeperAction,
    callbacks: KeeperSubmissionCallbacks = {},
  ) {
    await ensureRobinhoodChain(this.provider);
    await this.preflightAction(account, action);
    await ensureRobinhoodChain(this.provider);
    const final = await this.preflightAction(account, action);
    await ensureRobinhoodChain(this.provider);
    await assertSubmissionContext(this.provider, account, final.asOfBlock);
    const transaction = {
      from: account,
      to: final.target,
      data: final.data,
    } satisfies RpcTransactionRequest;
    await callbacks.onSubmissionInvoked?.();
    try {
      const hash = await this.provider.request<unknown>({
        method: "eth_sendTransaction",
        params: [transaction],
      });
      if (typeof hash !== "string" || !isTransactionHash(hash)) {
        throw new KeeperSubmissionIndeterminateError(
          "The wallet may have broadcast the keeper action but returned an invalid hash. Do not retry until wallet activity is reconciled.",
        );
      }
      await callbacks.onSubmitted?.(hash);
      return {
        hash,
        observedAmountPipedog: final.amountPipedog,
        observedBountyPipedog: final.bountyPipedog,
      };
    } catch (error) {
      if (explicitWalletRejection(error)) {
        throw new WalletFlowError("You rejected the wallet request.", errorCode(error), error);
      }
      if (isKeeperSubmissionIndeterminate(error)) throw error;
      throw new KeeperSubmissionIndeterminateError(
        "The wallet may have broadcast the keeper action. Do not retry until wallet activity is reconciled.",
        errorCode(error),
        error,
      );
    }
  }

  async confirmAction(
    hash: Hex,
    expected: { account: Address; action: KeeperAction },
    options: { timeoutMs?: number; pollIntervalMs?: number; signal?: AbortSignal } = {},
  ) {
    const timeoutMs = options.timeoutMs ?? 180_000;
    const pollIntervalMs = options.pollIntervalMs ?? 2_000;
    const started = Date.now();
    const call = keeperActionCall(this.manifest, expected.action);
    const chainId = rpcQuantity(
      await this.confirmationProvider.request<unknown>({ method: "eth_chainId" }),
      "Independent confirmation chain ID",
    );
    if (BigInt(chainId) !== BigInt(ROBINHOOD_CHAIN_ID_HEX)) {
      throw new WalletFlowError("Independent confirmation RPC is not on Robinhood Chain.");
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
      if (
        receipt.transactionHash.toLowerCase() !== hash.toLowerCase() ||
        !sameAddress(receipt.from, expected.account) ||
        !receipt.to ||
        !sameAddress(receipt.to, call.target)
      ) {
        throw new WalletFlowError("Keeper receipt does not match the saved wallet intent.");
      }
      const status = BigInt(receipt.status);
      if (status !== BigInt(0) && status !== BigInt(1)) {
        throw new WalletFlowError("Keeper receipt returned an invalid status value.");
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
      assertCanonicalTransaction({
        transactionValue,
        blockValue,
        receipt,
        hash,
        account: expected.account,
        target: call.target,
        data: call.data,
      });
      const head = BigInt(rpcQuantity(headValue, "Independent confirmation head"));
      const receiptBlock = BigInt(receipt.blockNumber);
      if (
        head < receiptBlock ||
        head - receiptBlock + BigInt(1) < KEEPER_CONFIRMATION_BLOCKS
      ) {
        await abortableDelay(pollIntervalMs, options.signal);
        continue;
      }
      if (status === BigInt(0)) throw new CanonicalKeeperRevertedError();
      return {
        receipt,
        ...effectFromReceipt(receipt, expected.action, expected.account, this.manifest),
      };
    }
    throw new WalletFlowError(
      "The keeper action is still pending. Check the explorer before trying again.",
    );
  }
}
