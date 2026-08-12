import { encodeAbiParameters, toFunctionSelector } from "viem";

import type { DbClient, DbRow } from "../db/neon";
import type { AuditedDeploymentManifest } from "../../web3/deployment-manifest";
import type {
  Address,
  Eip1193Provider,
  Eip1193RequestArguments,
  Hex,
} from "../../web3/types";

const STREAM = "laypipe";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const ZERO = BigInt(0);
const MAX_UINT256 = (BigInt(1) << BigInt(256)) - BigInt(1);
const MAX_REPORTED_MISMATCHES = 25;
const DB_TIMEOUT_MS = 10_000;

const SELECTORS = {
  balanceOf: toFunctionSelector("balanceOf(address)"),
  operationsTab: toFunctionSelector("operationsTab()"),
  pending: toFunctionSelector("pending(bytes32)"),
  platformTab: toFunctionSelector("platformTab()"),
  sequesterTank: toFunctionSelector("sequesterTank()"),
  tab: toFunctionSelector("tab(bytes32)"),
  totalKeeperBounties: toFunctionSelector("totalKeeperBounties()"),
  totalMigrated: toFunctionSelector("totalMigrated()"),
  totalPipedogOperationsCollected: toFunctionSelector(
    "totalPipedogOperationsCollected()",
  ),
  totalPipedogSequestered: toFunctionSelector("totalPipedogSequestered()"),
  totalPipedogTreasuryRouted: toFunctionSelector(
    "totalPipedogTreasuryRouted()",
  ),
  totalRevenueAllocated: toFunctionSelector("totalRevenueAllocated()"),
  totalSupply: toFunctionSelector("totalSupply()"),
  treasuryTank: toFunctionSelector("treasuryTank()"),
  unallocated: toFunctionSelector("unallocated()"),
  unburned: toFunctionSelector("unburned(bytes32)"),
} as const;

const CURSOR_SQL = `/* reconcile:cursor */
SELECT start_block::text, next_block::text, last_processed_block::text,
       last_processed_hash, observed_safe_head::text
FROM indexer_cursors
WHERE chain_id = $1::bigint AND stream = $2::text`;

const BLOCK_SQL = `/* reconcile:block */
SELECT block_number::text, block_hash
FROM chain_blocks
WHERE chain_id = $1::bigint AND block_number = $2::bigint`;

const POOLS_SQL = `/* reconcile:pools */
WITH fee_totals AS (
  SELECT pool_id,
    COALESCE(sum(amount) FILTER (WHERE fee_kind = 'accrued'), 0) AS accrued,
    COALESCE(sum(creator_amount) FILTER (WHERE fee_kind = 'swept'), 0) AS swept_creator,
    COALESCE(sum(platform_amount) FILTER (WHERE fee_kind = 'swept'), 0) AS swept_platform,
    COALESCE(sum(amount) FILTER (WHERE fee_kind = 'creator-claimed'), 0) AS creator_claimed,
    COALESCE(sum(amount) FILTER (
      WHERE fee_kind = 'creator-claimed' AND recipient_address = $4::evm_address
    ), 0) AS self_burner_claimed,
    count(*) FILTER (
      WHERE fee_kind = 'creator-claimed' AND recipient_address <> $4::evm_address
    ) AS non_burner_claims
  FROM fee_events
  WHERE chain_id = $1::bigint AND block_number <= $2::bigint AND pool_id IS NOT NULL
  GROUP BY pool_id
), burn_totals AS (
  SELECT pool_id,
    COALESCE(sum(pipedog_in), 0) AS pipedog_in,
    COALESCE(sum(tokens_burned), 0) AS tokens_burned,
    COALESCE(sum(pipedog_bounty), 0) AS pipedog_bounty,
    count(*) AS burn_count
  FROM burn_events
  WHERE chain_id = $1::bigint AND block_number <= $2::bigint
  GROUP BY pool_id
), transfer_totals AS (
  SELECT token_address,
    COALESCE(sum(amount) FILTER (WHERE from_address = '${ZERO_ADDRESS}'), 0) AS minted,
    COALESCE(sum(amount) FILTER (WHERE to_address = '${ZERO_ADDRESS}'), 0) AS burned
  FROM token_transfers
  WHERE chain_id = $1::bigint AND block_number <= $2::bigint
  GROUP BY token_address
)
SELECT l.pool_id, l.token_address, l.fee_mode,
  COALESCE(f.accrued, 0)::text AS accrued,
  COALESCE(f.swept_creator, 0)::text AS swept_creator,
  COALESCE(f.swept_platform, 0)::text AS swept_platform,
  COALESCE(f.creator_claimed, 0)::text AS creator_claimed,
  COALESCE(f.self_burner_claimed, 0)::text AS self_burner_claimed,
  COALESCE(f.non_burner_claims, 0)::text AS non_burner_claims,
  COALESCE(b.pipedog_in, 0)::text AS pipedog_in,
  COALESCE(b.tokens_burned, 0)::text AS tokens_burned,
  COALESCE(b.pipedog_bounty, 0)::text AS pipedog_bounty,
  COALESCE(b.burn_count, 0)::text AS burn_count,
  COALESCE(t.minted, 0)::text AS minted,
  COALESCE(t.burned, 0)::text AS burned
FROM launches l
LEFT JOIN fee_totals f ON f.pool_id = l.pool_id
LEFT JOIN burn_totals b ON b.pool_id = l.pool_id
LEFT JOIN transfer_totals t ON t.token_address = l.token_address
WHERE l.chain_id = $1::bigint AND l.block_number <= $2::bigint
ORDER BY l.pool_id
LIMIT $3::integer`;

const GLOBAL_FEES_SQL = `/* reconcile:global-fees */
SELECT
  COALESCE(sum(amount) FILTER (WHERE fee_kind = 'platform-deferred'), 0)::text
    AS platform_deferred,
  COALESCE(sum(amount) FILTER (WHERE fee_kind = 'platform-collected'), 0)::text
    AS platform_collected,
  COALESCE(sum(amount) FILTER (WHERE fee_kind = 'launch-fee'), 0)::text
    AS launch_fees
FROM fee_events
WHERE chain_id = $1::bigint AND block_number <= $2::bigint`;

const REVENUE_SQL = `/* reconcile:revenue */
SELECT
  COALESCE(sum(amount) FILTER (WHERE route_kind = 'allocated'), 0)::text AS allocated,
  COALESCE(sum(sequester_amount) FILTER (WHERE route_kind = 'allocated'), 0)::text
    AS allocated_sequester,
  COALESCE(sum(treasury_amount) FILTER (WHERE route_kind = 'allocated'), 0)::text
    AS allocated_treasury,
  COALESCE(sum(operations_amount) FILTER (WHERE route_kind = 'allocated'), 0)::text
    AS allocated_operations,
  COALESCE(sum(amount) FILTER (WHERE route_kind = 'sequestered'), 0)::text AS sequestered,
  COALESCE(sum(bounty) FILTER (WHERE route_kind = 'sequestered'), 0)::text
    AS sequester_bounties,
  COALESCE(sum(amount) FILTER (WHERE route_kind = 'treasury'), 0)::text
    AS treasury_routed,
  COALESCE(sum(bounty) FILTER (WHERE route_kind = 'treasury'), 0)::text
    AS treasury_bounties,
  COALESCE(sum(amount) FILTER (WHERE route_kind = 'operations'), 0)::text
    AS operations_collected
FROM revenue_events
WHERE chain_id = $1::bigint AND block_number <= $2::bigint`;

const BURN_INTEGRITY_SQL = `/* reconcile:burn-integrity */
WITH event_burns AS (
  SELECT b.transaction_hash, b.token_address,
    sum(b.tokens_burned) AS amount, count(*) AS item_count,
    bool_and(l.fee_mode = 'self-burn' AND l.token_address = b.token_address) AS binding_ok
  FROM burn_events b
  JOIN launches l ON l.chain_id = b.chain_id AND l.pool_id = b.pool_id
  WHERE b.chain_id = $1::bigint AND b.block_number <= $2::bigint
  GROUP BY b.transaction_hash, b.token_address
), transfer_burns AS (
  SELECT transaction_hash, token_address, sum(amount) AS amount, count(*) AS item_count
  FROM token_transfers
  WHERE chain_id = $1::bigint AND block_number <= $2::bigint
    AND from_address = $3::evm_address AND to_address = '${ZERO_ADDRESS}'
  GROUP BY transaction_hash, token_address
), compared AS (
  SELECT e.transaction_hash AS event_tx, t.transaction_hash AS transfer_tx,
    e.amount AS event_amount, t.amount AS transfer_amount,
    e.item_count AS event_count, t.item_count AS transfer_count,
    e.binding_ok
  FROM event_burns e
  FULL OUTER JOIN transfer_burns t
    ON t.transaction_hash = e.transaction_hash AND t.token_address = e.token_address
)
SELECT count(*) FILTER (
  WHERE event_tx IS NULL OR transfer_tx IS NULL OR event_amount <> transfer_amount
    OR event_count <> transfer_count OR binding_ok IS NOT TRUE
)::text AS mismatch_count
FROM compared`;

const MIGRATION_SQL = `/* reconcile:migration */
SELECT count(*)::text AS migration_count
FROM admin_events
WHERE chain_id = $1::bigint AND block_number <= $2::bigint
  AND contract_address = $3::evm_address AND event_name = 'Migrated'`;

interface CursorRow extends DbRow {
  start_block: unknown;
  next_block: unknown;
  last_processed_block: unknown;
  last_processed_hash: unknown;
  observed_safe_head: unknown;
}

interface BlockRow extends DbRow {
  block_number: unknown;
  block_hash: unknown;
}

interface PoolRow extends DbRow {
  pool_id: unknown;
  token_address: unknown;
  fee_mode: unknown;
  accrued: unknown;
  swept_creator: unknown;
  swept_platform: unknown;
  creator_claimed: unknown;
  self_burner_claimed: unknown;
  non_burner_claims: unknown;
  pipedog_in: unknown;
  tokens_burned: unknown;
  pipedog_bounty: unknown;
  burn_count: unknown;
  minted: unknown;
  burned: unknown;
}

interface GlobalFeeRow extends DbRow {
  platform_deferred: unknown;
  platform_collected: unknown;
  launch_fees: unknown;
}

interface RevenueRow extends DbRow {
  allocated: unknown;
  allocated_sequester: unknown;
  allocated_treasury: unknown;
  allocated_operations: unknown;
  sequestered: unknown;
  sequester_bounties: unknown;
  treasury_routed: unknown;
  treasury_bounties: unknown;
  operations_collected: unknown;
}

interface CountRow extends DbRow {
  mismatch_count?: unknown;
  migration_count?: unknown;
}

interface PoolAccounting {
  poolId: Hex;
  tokenAddress: Address;
  feeMode: "creator" | "self-burn";
  accrued: bigint;
  sweptCreator: bigint;
  sweptPlatform: bigint;
  creatorClaimed: bigint;
  selfBurnerClaimed: bigint;
  nonBurnerClaims: bigint;
  pipedogIn: bigint;
  tokensBurned: bigint;
  pipedogBounty: bigint;
  burnCount: bigint;
  minted: bigint;
  burned: bigint;
}

interface RevenueAccounting {
  allocated: bigint;
  allocatedSequester: bigint;
  allocatedTreasury: bigint;
  allocatedOperations: bigint;
  sequestered: bigint;
  sequesterBounties: bigint;
  treasuryRouted: bigint;
  treasuryBounties: bigint;
  operationsCollected: bigint;
}

export interface ReconciliationMismatch {
  scope: "database" | "hook" | "revenue" | "self-burn" | "token-supply";
  key: string;
  field: string;
  indexed: string;
  onchain: string;
}

export interface ReconciliationReport {
  ok: boolean;
  chain: {
    chainId: number;
    pinnedBlock: string;
    pinnedBlockHash: Hex;
    observedHead: string;
    finalityBlocks: number;
    sourceCommit: string;
  };
  coverage: {
    pools: number;
    selfBurnPools: number;
    burnEvents: string;
    rpcCalls: number;
    mismatchCount: number;
  };
  accounting: {
    hook: {
      accrued: string;
      pending: string;
      creatorOwed: string;
      platformDeferred: string;
      launchFees: string;
    };
    revenue: {
      allocated: string;
      sequestered: string;
      treasuryRouted: string;
      operationsCollected: string;
      keeperBounties: string;
      sequesterTank: string;
      treasuryTank: string;
      operationsTab: string;
    };
    selfBurn: {
      pipedogSpent: string;
      pipedogBounties: string;
      tokensBurned: string;
      unburned: string;
    };
    tokenSupply: {
      minted: string;
      burned: string;
      current: string;
    };
  };
  mismatches: ReconciliationMismatch[];
  omissions: readonly string[];
}

export class ReconciliationGateError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ReconciliationGateError";
  }
}

export interface ReconciliationOptions {
  database: DbClient;
  rpc: Eip1193Provider;
  manifest: AuditedDeploymentManifest;
  pinnedBlock: bigint;
  finalityBlocks: number;
  maxPools: number;
  rpcConcurrency: number;
  verifyManifestSnapshot: (
    provider: Eip1193Provider,
    manifest: AuditedDeploymentManifest,
  ) => Promise<unknown>;
}

export function readReconciliationConfig(env: NodeJS.ProcessEnv = process.env) {
  return {
    pinnedBlock: requiredBigint(env.RECONCILIATION_BLOCK_NUMBER, "RECONCILIATION_BLOCK_NUMBER"),
    finalityBlocks: integerSetting(
      env.INDEXER_FINALITY_BLOCKS,
      "INDEXER_FINALITY_BLOCKS",
      1,
      10_000,
    ),
    maxPools: integerSetting(
      env.RECONCILIATION_MAX_POOLS,
      "RECONCILIATION_MAX_POOLS",
      1,
      2_500,
      100,
    ),
    rpcConcurrency: integerSetting(
      env.RECONCILIATION_RPC_CONCURRENCY,
      "RECONCILIATION_RPC_CONCURRENCY",
      1,
      16,
      8,
    ),
    timeoutMs: integerSetting(
      env.RECONCILIATION_TIMEOUT_MS,
      "RECONCILIATION_TIMEOUT_MS",
      5_000,
      120_000,
      45_000,
    ),
  };
}

function integerSetting(
  value: string | undefined,
  label: string,
  minimum: number,
  maximum: number,
  fallback?: number,
) {
  const candidate = value?.trim() || (fallback === undefined ? "" : String(fallback));
  if (!/^\d+$/.test(candidate)) {
    throw new ReconciliationGateError("CONFIG_INVALID", `${label} must be configured.`);
  }
  const parsed = Number(candidate);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new ReconciliationGateError(
      "CONFIG_INVALID",
      `${label} must be between ${minimum} and ${maximum}.`,
    );
  }
  return parsed;
}

function requiredBigint(value: string | undefined, label: string) {
  const candidate = value?.trim() ?? "";
  if (!/^(0|[1-9]\d*)$/.test(candidate)) {
    throw new ReconciliationGateError(
      "CONFIG_INVALID",
      `${label} must be an explicit base-10 block number.`,
    );
  }
  return BigInt(candidate);
}

function rowText(value: unknown, label: string) {
  if (typeof value !== "string" || value.length === 0) {
    throw new ReconciliationGateError("DATABASE_INVALID", `${label} was malformed.`);
  }
  return value;
}

function rowUint(value: unknown, label: string) {
  const text = rowText(value, label);
  if (!/^(0|[1-9]\d*)$/.test(text)) {
    throw new ReconciliationGateError("DATABASE_INVALID", `${label} was malformed.`);
  }
  const parsed = BigInt(text);
  if (parsed > MAX_UINT256) {
    throw new ReconciliationGateError("DATABASE_INVALID", `${label} exceeded uint256.`);
  }
  return parsed;
}

function rowAddress(value: unknown, label: string) {
  const text = rowText(value, label);
  if (!/^0x[0-9a-f]{40}$/.test(text)) {
    throw new ReconciliationGateError("DATABASE_INVALID", `${label} was malformed.`);
  }
  return text as Address;
}

function rowBytes32(value: unknown, label: string) {
  const text = rowText(value, label);
  if (!/^0x[0-9a-f]{64}$/.test(text)) {
    throw new ReconciliationGateError("DATABASE_INVALID", `${label} was malformed.`);
  }
  return text as Hex;
}

function parsePool(row: PoolRow): PoolAccounting {
  const feeMode = rowText(row.fee_mode, "Pool fee mode");
  if (feeMode !== "creator" && feeMode !== "self-burn") {
    throw new ReconciliationGateError("DATABASE_INVALID", "Pool fee mode was malformed.");
  }
  return {
    poolId: rowBytes32(row.pool_id, "Pool id"),
    tokenAddress: rowAddress(row.token_address, "Token address"),
    feeMode,
    accrued: rowUint(row.accrued, "Accrued fees"),
    sweptCreator: rowUint(row.swept_creator, "Swept creator fees"),
    sweptPlatform: rowUint(row.swept_platform, "Swept platform fees"),
    creatorClaimed: rowUint(row.creator_claimed, "Creator claims"),
    selfBurnerClaimed: rowUint(row.self_burner_claimed, "Self-burner claims"),
    nonBurnerClaims: rowUint(row.non_burner_claims, "Non-burner claims"),
    pipedogIn: rowUint(row.pipedog_in, "Self-burn PIPEDOG input"),
    tokensBurned: rowUint(row.tokens_burned, "Self-burn token output"),
    pipedogBounty: rowUint(row.pipedog_bounty, "Self-burn bounty"),
    burnCount: rowUint(row.burn_count, "Self-burn count"),
    minted: rowUint(row.minted, "Minted token supply"),
    burned: rowUint(row.burned, "Burned token supply"),
  };
}

function parseRevenue(row: RevenueRow): RevenueAccounting {
  return {
    allocated: rowUint(row.allocated, "Allocated revenue"),
    allocatedSequester: rowUint(row.allocated_sequester, "Allocated sequester revenue"),
    allocatedTreasury: rowUint(row.allocated_treasury, "Allocated treasury revenue"),
    allocatedOperations: rowUint(row.allocated_operations, "Allocated operations revenue"),
    sequestered: rowUint(row.sequestered, "Sequestered revenue"),
    sequesterBounties: rowUint(row.sequester_bounties, "Sequester bounties"),
    treasuryRouted: rowUint(row.treasury_routed, "Treasury revenue"),
    treasuryBounties: rowUint(row.treasury_bounties, "Treasury bounties"),
    operationsCollected: rowUint(row.operations_collected, "Operations revenue"),
  };
}

function blockTag(block: bigint) {
  return `0x${block.toString(16)}` as Hex;
}

function uintCall(selector: Hex, type?: "address" | "bytes32", value?: Address | Hex) {
  if (!type) return selector;
  const encoded = encodeAbiParameters([{ type }], [value as never]);
  return `${selector}${encoded.slice(2)}` as Hex;
}

async function readUint(
  provider: Eip1193Provider,
  address: Address,
  data: Hex,
  atBlock: Hex,
) {
  const result = await provider.request<unknown>({
    method: "eth_call",
    params: [{ to: address, data }, atBlock],
  });
  if (typeof result !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(result)) {
    throw new ReconciliationGateError("RPC_INVALID", "Contract view returned malformed data.");
  }
  return BigInt(result);
}

function rpcQuantity(value: unknown, label: string) {
  if (typeof value !== "string" || !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(value)) {
    throw new ReconciliationGateError("RPC_INVALID", `${label} was malformed.`);
  }
  return BigInt(value);
}

interface RpcCounter {
  calls: number;
}

function cappedReadProvider(
  provider: Eip1193Provider,
  maxCalls: number,
  counter: RpcCounter,
): Eip1193Provider {
  const allowed = new Set([
    "eth_call",
    "eth_chainId",
    "eth_getBlockByNumber",
    "eth_getCode",
    "eth_getStorageAt",
    "eth_blockNumber",
  ]);
  return {
    async request<T = unknown>(args: Eip1193RequestArguments): Promise<T> {
      if (!allowed.has(args.method)) {
        throw new ReconciliationGateError("RPC_METHOD_REJECTED", "Non-read RPC method rejected.");
      }
      counter.calls += 1;
      if (counter.calls > maxCalls) {
        throw new ReconciliationGateError("RPC_CALL_LIMIT", "RPC call budget was exceeded.");
      }
      return provider.request<T>(args);
    },
  };
}

export function pinnedReadProvider(provider: Eip1193Provider, pinned: Hex): Eip1193Provider {
  return {
    async request<T = unknown>(args: Eip1193RequestArguments): Promise<T> {
      if (args.method === "eth_blockNumber") return pinned as T;
      if (args.method === "eth_chainId") return provider.request<T>(args);
      const params = Array.isArray(args.params) ? args.params : [];
      const blockParameter =
        args.method === "eth_call" || args.method === "eth_getCode"
          ? params[1]
          : args.method === "eth_getStorageAt"
            ? params[2]
            : undefined;
      if (blockParameter !== pinned) {
        throw new ReconciliationGateError(
          "RPC_BLOCK_UNPINNED",
          "Audited deployment read was not pinned to the reconciliation block.",
        );
      }
      return provider.request<T>(args);
    },
  };
}

async function mapConcurrent<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>,
) {
  const results = new Array<R>(values.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (true) {
        const index = next++;
        if (index >= values.length) return;
        results[index] = await mapper(values[index]);
      }
    }),
  );
  return results;
}

function subtract(left: bigint, right: bigint) {
  return left >= right ? left - right : null;
}

function sum(values: readonly bigint[]) {
  return values.reduce((total, value) => total + value, ZERO);
}

function dbSignal() {
  return { fetchOptions: { signal: AbortSignal.timeout(DB_TIMEOUT_MS) } };
}

async function loadSnapshot(options: ReconciliationOptions) {
  try {
    const params = [options.manifest.chain.chainId, options.pinnedBlock.toString()] as const;
    return await options.database.transaction(
      (transaction) => [
        transaction.query<CursorRow>(CURSOR_SQL, [params[0], STREAM], dbSignal()),
        transaction.query<BlockRow>(BLOCK_SQL, params, dbSignal()),
        transaction.query<PoolRow>(
          POOLS_SQL,
          [
            params[0],
            params[1],
            options.maxPools + 1,
            options.manifest.contracts.selfBurner.address.toLowerCase(),
          ],
          dbSignal(),
        ),
        transaction.query<GlobalFeeRow>(GLOBAL_FEES_SQL, params, dbSignal()),
        transaction.query<RevenueRow>(REVENUE_SQL, params, dbSignal()),
        transaction.query<CountRow>(
          BURN_INTEGRITY_SQL,
          [
            params[0],
            params[1],
            options.manifest.contracts.selfBurner.address.toLowerCase(),
          ],
          dbSignal(),
        ),
        transaction.query<CountRow>(
          MIGRATION_SQL,
          [
            params[0],
            params[1],
            options.manifest.contracts.revenueRouter.address.toLowerCase(),
          ],
          dbSignal(),
        ),
      ] as const,
      {
        isolationLevel: "RepeatableRead",
        readOnly: true,
        deferrable: true,
        fetchOptions: { signal: AbortSignal.timeout(DB_TIMEOUT_MS) },
      },
    );
  } catch (error) {
    if (error instanceof ReconciliationGateError) throw error;
    throw new ReconciliationGateError(
      "DATABASE_READ_FAILED",
      "The read-only reconciliation snapshot could not be loaded.",
    );
  }
}

function exactlyOne<T>(rows: readonly T[], label: string) {
  if (rows.length !== 1) {
    throw new ReconciliationGateError("DATABASE_INCOMPLETE", `${label} was not unique.`);
  }
  return rows[0];
}

export async function runReadOnlyReconciliation(
  options: ReconciliationOptions,
): Promise<ReconciliationReport> {
  if (options.manifest.environment !== "robinhood-production" || options.manifest.testOnly) {
    throw new ReconciliationGateError(
      "MANIFEST_INVALID",
      "Only the audited Robinhood production manifest can be reconciled.",
    );
  }
  if (options.pinnedBlock < options.manifest.deploymentBlock) {
    throw new ReconciliationGateError(
      "BLOCK_BEFORE_DEPLOYMENT",
      "Reconciliation block predates the audited deployment.",
    );
  }
  if (!Number.isSafeInteger(options.finalityBlocks) || options.finalityBlocks < 1) {
    throw new ReconciliationGateError("CONFIG_INVALID", "Finality depth is invalid.");
  }
  if (!Number.isSafeInteger(options.maxPools) || options.maxPools < 1 || options.maxPools > 2_500) {
    throw new ReconciliationGateError("CONFIG_INVALID", "Pool bound is invalid.");
  }
  if (
    !Number.isSafeInteger(options.rpcConcurrency) ||
    options.rpcConcurrency < 1 ||
    options.rpcConcurrency > 16
  ) {
    throw new ReconciliationGateError("CONFIG_INVALID", "RPC concurrency is invalid.");
  }

  const counter: RpcCounter = { calls: 0 };
  const rpc = cappedReadProvider(options.rpc, 4 * options.maxPools + 96, counter);
  let observedHead: bigint;
  let canonicalHash: Hex;
  try {
    const [chainResult, headResult] = await Promise.all([
      rpc.request<unknown>({ method: "eth_chainId" }),
      rpc.request<unknown>({ method: "eth_blockNumber" }),
    ]);
    const chainId = rpcQuantity(chainResult, "RPC chain id");
    if (chainId !== BigInt(options.manifest.chain.chainId)) {
      throw new ReconciliationGateError("CHAIN_MISMATCH", "RPC chain did not match the manifest.");
    }
    observedHead = rpcQuantity(headResult, "RPC head");
    const depth = BigInt(options.finalityBlocks);
    if (observedHead < depth || options.pinnedBlock > observedHead - depth) {
      throw new ReconciliationGateError(
        "BLOCK_NOT_FINALIZED",
        "Reconciliation block is above the configured finalized safe head.",
      );
    }
    const block = await rpc.request<unknown>({
      method: "eth_getBlockByNumber",
      params: [blockTag(options.pinnedBlock), false],
    });
    if (!block || typeof block !== "object" || Array.isArray(block)) {
      throw new ReconciliationGateError("RPC_INVALID", "Pinned block was unavailable.");
    }
    const candidate = block as { number?: unknown; hash?: unknown };
    if (rpcQuantity(candidate.number, "Pinned block number") !== options.pinnedBlock) {
      throw new ReconciliationGateError("RPC_INVALID", "Pinned block number did not match.");
    }
    if (typeof candidate.hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(candidate.hash)) {
      throw new ReconciliationGateError("RPC_INVALID", "Pinned block hash was malformed.");
    }
    canonicalHash = candidate.hash.toLowerCase() as Hex;
  } catch (error) {
    if (error instanceof ReconciliationGateError) throw error;
    throw new ReconciliationGateError("RPC_READ_FAILED", "Canonical chain snapshot failed.");
  }

  const pinned = blockTag(options.pinnedBlock);
  try {
    await options.verifyManifestSnapshot(pinnedReadProvider(rpc, pinned), options.manifest);
  } catch (error) {
    if (error instanceof ReconciliationGateError) throw error;
    throw new ReconciliationGateError(
      "MANIFEST_MISMATCH",
      "Audited deployment identity or configuration did not match at the pinned block.",
    );
  }

  const [cursorRows, blockRows, rawPoolRows, globalRows, revenueRows, burnRows, migrationRows] =
    await loadSnapshot(options);
  const cursor = exactlyOne(cursorRows, "Indexer cursor");
  const storedBlock = exactlyOne(blockRows, "Pinned database block");
  const global = exactlyOne(globalRows, "Global fee accounting");
  const revenue = parseRevenue(exactlyOne(revenueRows, "Revenue accounting"));
  const burnIntegrityCount = rowUint(
    exactlyOne(burnRows, "Burn integrity").mismatch_count,
    "Burn integrity mismatch count",
  );
  const migrationCount = rowUint(
    exactlyOne(migrationRows, "Revenue migration").migration_count,
    "Revenue migration count",
  );

  const lastProcessed = rowUint(cursor.last_processed_block, "Cursor last processed block");
  const startBlock = rowUint(cursor.start_block, "Cursor start block");
  const observedSafeHead = rowUint(
    cursor.observed_safe_head,
    "Cursor observed safe head",
  );
  if (startBlock > options.pinnedBlock) {
    throw new ReconciliationGateError(
      "DATABASE_START_AFTER_BLOCK",
      "Indexer cursor starts after the pinned reconciliation block.",
    );
  }
  if (lastProcessed < options.pinnedBlock) {
    throw new ReconciliationGateError(
      "DATABASE_BEHIND",
      "Indexer cursor has not processed the pinned block.",
    );
  }
  if (observedSafeHead < options.pinnedBlock) {
    throw new ReconciliationGateError(
      "DATABASE_OBSERVATION_BEHIND",
      "Indexer has not observed the pinned block as finalized.",
    );
  }
  if (rowUint(storedBlock.block_number, "Stored block number") !== options.pinnedBlock) {
    throw new ReconciliationGateError("DATABASE_INVALID", "Stored block number did not match.");
  }
  const storedHash = rowBytes32(storedBlock.block_hash, "Stored block hash");
  if (storedHash !== canonicalHash) {
    throw new ReconciliationGateError(
      "DATABASE_REORGED",
      "Database block hash did not match the canonical pinned block.",
    );
  }
  if (rawPoolRows.length > options.maxPools) {
    throw new ReconciliationGateError(
      "POOL_LIMIT_EXCEEDED",
      "Indexed launch count exceeded the configured reconciliation bound.",
    );
  }
  const pools = rawPoolRows.map(parsePool);
  const selfBurnPools = pools.filter((pool) => pool.feeMode === "self-burn");

  const mismatches: ReconciliationMismatch[] = [];
  let mismatchCount = 0;
  const mismatch = (value: ReconciliationMismatch) => {
    mismatchCount += 1;
    if (mismatches.length < MAX_REPORTED_MISMATCHES) mismatches.push(value);
  };
  const compare = (
    scope: ReconciliationMismatch["scope"],
    key: string,
    field: string,
    indexed: bigint | null,
    onchain: bigint,
  ) => {
    if (indexed === null || indexed !== onchain) {
      mismatch({
        scope,
        key,
        field,
        indexed: indexed === null ? "underflow" : indexed.toString(),
        onchain: onchain.toString(),
      });
    }
  };

  if (burnIntegrityCount > ZERO) {
    mismatch({
      scope: "self-burn",
      key: "all",
      field: "burn-event-transfer-mismatches",
      indexed: burnIntegrityCount.toString(),
      onchain: "0",
    });
  }

  const platformDeferred = rowUint(global.platform_deferred, "Deferred platform fees");
  const platformCollected = rowUint(global.platform_collected, "Collected platform fees");
  const launchFees = rowUint(global.launch_fees, "Launch fees");
  const expectedPlatformTab = subtract(platformDeferred, platformCollected);

  const poolViews = await mapConcurrent(pools, options.rpcConcurrency, async (pool) => {
    const [pending, tab, totalSupply] = await Promise.all([
      readUint(
        rpc,
        options.manifest.contracts.hook.address,
        uintCall(SELECTORS.pending, "bytes32", pool.poolId),
        pinned,
      ),
      readUint(
        rpc,
        options.manifest.contracts.hook.address,
        uintCall(SELECTORS.tab, "bytes32", pool.poolId),
        pinned,
      ),
      readUint(rpc, pool.tokenAddress, SELECTORS.totalSupply, pinned),
    ]);
    const unburned =
      pool.feeMode === "self-burn"
        ? await readUint(
            rpc,
            options.manifest.contracts.selfBurner.address,
            uintCall(SELECTORS.unburned, "bytes32", pool.poolId),
            pinned,
          )
        : null;
    return { pending, tab, totalSupply, unburned };
  });

  for (let index = 0; index < pools.length; index += 1) {
    const pool = pools[index];
    const views = poolViews[index];
    compare(
      "hook",
      pool.poolId,
      "pending",
      subtract(pool.accrued, pool.sweptCreator + pool.sweptPlatform),
      views.pending,
    );
    compare(
      "hook",
      pool.poolId,
      "creator-tab",
      subtract(pool.sweptCreator, pool.creatorClaimed),
      views.tab,
    );
    compare(
      "token-supply",
      pool.tokenAddress,
      "total-supply",
      subtract(pool.minted, pool.burned),
      views.totalSupply,
    );
    if (pool.feeMode === "self-burn") {
      compare(
        "self-burn",
        pool.poolId,
        "unburned-pipedog",
        subtract(pool.selfBurnerClaimed, pool.pipedogIn + pool.pipedogBounty),
        views.unburned ?? ZERO,
      );
      if (pool.nonBurnerClaims > ZERO) {
        mismatch({
          scope: "self-burn",
          key: pool.poolId,
          field: "claims-to-non-burner",
          indexed: pool.nonBurnerClaims.toString(),
          onchain: "0",
        });
      }
    } else if (pool.burnCount > ZERO) {
      mismatch({
        scope: "self-burn",
        key: pool.poolId,
        field: "burns-on-creator-pool",
        indexed: pool.burnCount.toString(),
        onchain: "0",
      });
    }
  }

  const staticReads = await Promise.all([
    readUint(rpc, options.manifest.contracts.hook.address, SELECTORS.platformTab, pinned),
    readUint(
      rpc,
      options.manifest.contracts.pipedog.address,
      uintCall(SELECTORS.balanceOf, "address", options.manifest.contracts.hook.address),
      pinned,
    ),
    readUint(rpc, options.manifest.contracts.revenueRouter.address, SELECTORS.sequesterTank, pinned),
    readUint(rpc, options.manifest.contracts.revenueRouter.address, SELECTORS.treasuryTank, pinned),
    readUint(rpc, options.manifest.contracts.revenueRouter.address, SELECTORS.operationsTab, pinned),
    readUint(
      rpc,
      options.manifest.contracts.revenueRouter.address,
      SELECTORS.totalRevenueAllocated,
      pinned,
    ),
    readUint(
      rpc,
      options.manifest.contracts.revenueRouter.address,
      SELECTORS.totalPipedogSequestered,
      pinned,
    ),
    readUint(
      rpc,
      options.manifest.contracts.revenueRouter.address,
      SELECTORS.totalPipedogTreasuryRouted,
      pinned,
    ),
    readUint(
      rpc,
      options.manifest.contracts.revenueRouter.address,
      SELECTORS.totalPipedogOperationsCollected,
      pinned,
    ),
    readUint(
      rpc,
      options.manifest.contracts.revenueRouter.address,
      SELECTORS.totalKeeperBounties,
      pinned,
    ),
    readUint(rpc, options.manifest.contracts.revenueRouter.address, SELECTORS.totalMigrated, pinned),
    readUint(rpc, options.manifest.contracts.revenueRouter.address, SELECTORS.unallocated, pinned),
    readUint(
      rpc,
      options.manifest.contracts.pipedog.address,
      uintCall(SELECTORS.balanceOf, "address", options.manifest.contracts.revenueRouter.address),
      pinned,
    ),
    readUint(
      rpc,
      options.manifest.contracts.pipedog.address,
      uintCall(SELECTORS.balanceOf, "address", options.manifest.contracts.selfBurner.address),
      pinned,
    ),
  ]);
  const [
    platformTab,
    hookBalance,
    sequesterTank,
    treasuryTank,
    operationsTab,
    totalRevenueAllocated,
    totalPipedogSequestered,
    totalPipedogTreasuryRouted,
    totalPipedogOperationsCollected,
    totalKeeperBounties,
    totalMigrated,
    unallocated,
    revenueBalance,
    selfBurnerBalance,
  ] = staticReads;

  compare("hook", "global", "platform-tab", expectedPlatformTab, platformTab);
  const totalExpectedTabs = sum(
    pools.map((pool) => subtract(pool.sweptCreator, pool.creatorClaimed) ?? ZERO),
  );
  compare("hook", "global", "pipedog-balance", totalExpectedTabs + platformTab, hookBalance);

  compare("revenue", "global", "total-revenue-allocated", revenue.allocated, totalRevenueAllocated);
  compare("revenue", "global", "total-pipedog-sequestered", revenue.sequestered, totalPipedogSequestered);
  compare(
    "revenue",
    "global",
    "total-pipedog-treasury-routed",
    revenue.treasuryRouted,
    totalPipedogTreasuryRouted,
  );
  compare(
    "revenue",
    "global",
    "total-pipedog-operations-collected",
    revenue.operationsCollected,
    totalPipedogOperationsCollected,
  );
  compare(
    "revenue",
    "global",
    "total-keeper-bounties",
    revenue.sequesterBounties + revenue.treasuryBounties,
    totalKeeperBounties,
  );

  if (migrationCount > ZERO || totalMigrated > ZERO) {
    mismatch({
      scope: "revenue",
      key: "global",
      field: "unsupported-router-migration",
      indexed: migrationCount.toString(),
      onchain: totalMigrated.toString(),
    });
  } else {
    compare(
      "revenue",
      "global",
      "sequester-tank",
      subtract(revenue.allocatedSequester, revenue.sequestered + revenue.sequesterBounties),
      sequesterTank,
    );
    compare(
      "revenue",
      "global",
      "treasury-tank",
      subtract(revenue.allocatedTreasury, revenue.treasuryRouted + revenue.treasuryBounties),
      treasuryTank,
    );
    compare(
      "revenue",
      "global",
      "operations-tab",
      subtract(revenue.allocatedOperations, revenue.operationsCollected),
      operationsTab,
    );
  }
  compare("revenue", "global", "unallocated-pipedog", ZERO, unallocated);
  compare(
    "revenue",
    "global",
    "pipedog-balance",
    sequesterTank + treasuryTank + operationsTab + unallocated,
    revenueBalance,
  );

  const expectedUnburned = sum(
    selfBurnPools.map(
      (pool) => subtract(pool.selfBurnerClaimed, pool.pipedogIn + pool.pipedogBounty) ?? ZERO,
    ),
  );
  compare("self-burn", "global", "pipedog-balance", expectedUnburned, selfBurnerBalance);

  const totals = {
    accrued: sum(pools.map((pool) => pool.accrued)),
    pending: sum(poolViews.map((views) => views.pending)),
    creatorOwed: sum(poolViews.map((views) => views.tab)),
    pipedogSpent: sum(pools.map((pool) => pool.pipedogIn)),
    pipedogBounties: sum(pools.map((pool) => pool.pipedogBounty)),
    tokensBurned: sum(pools.map((pool) => pool.tokensBurned)),
    burnEvents: sum(pools.map((pool) => pool.burnCount)),
    minted: sum(pools.map((pool) => pool.minted)),
    burned: sum(pools.map((pool) => pool.burned)),
    currentSupply: sum(poolViews.map((views) => views.totalSupply)),
  };

  return {
    ok: mismatchCount === 0,
    chain: {
      chainId: options.manifest.chain.chainId,
      pinnedBlock: options.pinnedBlock.toString(),
      pinnedBlockHash: canonicalHash,
      observedHead: observedHead.toString(),
      finalityBlocks: options.finalityBlocks,
      sourceCommit: options.manifest.release.sourceCommit,
    },
    coverage: {
      pools: pools.length,
      selfBurnPools: selfBurnPools.length,
      burnEvents: totals.burnEvents.toString(),
      rpcCalls: counter.calls,
      mismatchCount,
    },
    accounting: {
      hook: {
        accrued: totals.accrued.toString(),
        pending: totals.pending.toString(),
        creatorOwed: totals.creatorOwed.toString(),
        platformDeferred: platformTab.toString(),
        launchFees: launchFees.toString(),
      },
      revenue: {
        allocated: revenue.allocated.toString(),
        sequestered: revenue.sequestered.toString(),
        treasuryRouted: revenue.treasuryRouted.toString(),
        operationsCollected: revenue.operationsCollected.toString(),
        keeperBounties: (revenue.sequesterBounties + revenue.treasuryBounties).toString(),
        sequesterTank: sequesterTank.toString(),
        treasuryTank: treasuryTank.toString(),
        operationsTab: operationsTab.toString(),
      },
      selfBurn: {
        pipedogSpent: totals.pipedogSpent.toString(),
        pipedogBounties: totals.pipedogBounties.toString(),
        tokensBurned: totals.tokensBurned.toString(),
        unburned: expectedUnburned.toString(),
      },
      tokenSupply: {
        minted: totals.minted.toString(),
        burned: totals.burned.toString(),
        current: totals.currentSupply.toString(),
      },
    },
    mismatches,
    omissions: [
      "Historical destination-wallet balances are not cumulative counters and are not compared.",
      "PIPEDOG sources entering the revenue router are not attributed beyond allocation events.",
      "A router migration requires a new manifest and purpose-built carry-forward reconciliation.",
    ],
  };
}
