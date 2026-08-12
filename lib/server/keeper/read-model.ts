import type {
  IndexedKeeperAction,
  KeeperRewardsResponse,
  KeeperSweepCandidate,
} from "../../keeper/live";
import { LAYPIPE_CHAIN_ID, type IndexerWatermark } from "../../market/live";
import type { Address } from "../../web3/types";
import {
  DATABASE_READ_TIMEOUT_MS,
  databaseFetchOptions,
  type DbClient,
  type DbRow,
} from "../db/neon";
import { normalizeAddress, normalizeBytes32, normalizeUint256 } from "../indexer/model";
import {
  assessIndexerFreshness,
  MARKET_INDEXER_MAX_BLOCK_LAG,
  MARKET_INDEXER_MAX_CLOCK_SKEW_MS,
  MARKET_INDEXER_STALE_AFTER_MS,
  MarketInputError,
} from "../market/read-model";

const INDEXER_STREAM = "laypipe";
const SWEEP_CANDIDATE_LIMIT = 20;
const RECENT_ACTION_LIMIT = 20;

const FRESH_WATERMARK = `
  SELECT last_processed_block
  FROM indexer_cursors
  WHERE chain_id = $1::bigint AND stream = '${INDEXER_STREAM}'
    AND last_processed_block IS NOT NULL
    AND last_processed_hash IS NOT NULL
    AND observed_safe_head IS NOT NULL
    AND observed_at IS NOT NULL
    AND last_run_status = 'caught-up'
    AND observed_safe_head >= last_processed_block
    AND observed_safe_head - last_processed_block <= ${MARKET_INDEXER_MAX_BLOCK_LAG}
    AND observed_at >= statement_timestamp() - interval '${MARKET_INDEXER_STALE_AFTER_MS / 1_000} seconds'
    AND observed_at <= statement_timestamp() + interval '${MARKET_INDEXER_MAX_CLOCK_SKEW_MS / 1_000} seconds'`;

export const KEEPER_WATERMARK_SQL = `/* keeper:watermark */
SELECT stream, next_block::text, last_processed_block::text,
  last_processed_hash, observed_safe_head::text, observed_at::text,
  last_run_status, updated_at::text
FROM indexer_cursors
WHERE chain_id = $1::bigint AND stream = $2::text`;

/**
 * Exact canonical bounty accounting. The projection is transactionally
 * maintained from revenue/fee event INSERT and DELETE transition tables, so a
 * request is one bounded primary-key lookup. Only events whose ABI carries a
 * caller can credit that caller; platform collection remains unattributed.
 */
export const KEEPER_ACCOUNTING_SQL = `/* keeper:accounting */
WITH watermark AS MATERIALIZED (${FRESH_WATERMARK})
SELECT
  (COALESCE(accounting.sequester_bounty, 0)
    + COALESCE(accounting.treasury_bounty, 0))::text AS total_bounty,
  COALESCE(accounting.sequester_bounty, 0)::text AS sequester_bounty,
  COALESCE(accounting.treasury_bounty, 0)::text AS treasury_bounty,
  COALESCE(accounting.sequester_calls, 0)::text AS sequester_calls,
  COALESCE(accounting.treasury_calls, 0)::text AS treasury_calls,
  COALESCE(accounting.sweep_calls, 0)::text AS sweep_calls
FROM watermark
LEFT JOIN keeper_caller_accounting accounting
  ON accounting.chain_id = $1::bigint
  AND accounting.caller_address = $2::evm_address`;

export const KEEPER_RECENT_ACTIONS_SQL = `/* keeper:recent-actions */
WITH watermark AS MATERIALIZED (${FRESH_WATERMARK}), actions AS (
  SELECT r.route_kind AS kind, r.transaction_hash, r.block_number,
    r.block_timestamp, r.amount + r.bounty AS processed,
    r.amount AS routed, r.bounty, NULL::evm_bytes32 AS pool_id,
    r.log_index
  FROM revenue_events r CROSS JOIN watermark w
  WHERE r.chain_id = $1::bigint
    AND r.caller_address = $2::evm_address
    AND r.route_kind IN ('sequestered', 'treasury')
    AND r.block_number <= w.last_processed_block
  UNION ALL
  SELECT 'sweep'::text, f.transaction_hash, f.block_number,
    f.block_timestamp, f.creator_amount + f.platform_amount AS processed,
    f.creator_amount + f.platform_amount AS routed, 0::numeric,
    f.pool_id, f.log_index
  FROM fee_events f CROSS JOIN watermark w
  WHERE f.chain_id = $1::bigint
    AND f.fee_kind = 'swept'
    AND f.actor_address = $2::evm_address
    AND f.block_number <= w.last_processed_block
)
SELECT kind, transaction_hash, block_number::text, block_timestamp::text,
  processed::text, routed::text, bounty::text, pool_id
FROM actions
ORDER BY block_number DESC, log_index DESC, transaction_hash DESC
LIMIT ${RECENT_ACTION_LIMIT}`;

/**
 * Bounded discovery only. `keeper_pool_fee_state` is maintained in the same
 * canonical ingest/rollback transactions as `fee_events`, so this request
 * never aggregates an unbounded fee history. A browser must still read
 * pending(poolId) at an audited snapshot and successfully simulate before a
 * candidate becomes an actionable job.
 */
export const KEEPER_SWEEP_CANDIDATES_SQL = `/* keeper:sweep-candidates */
WITH watermark AS MATERIALIZED (${FRESH_WATERMARK})
SELECT candidate.pool_id, candidate.token_address, candidate.name,
  candidate.symbol, candidate.indexed_pending::text AS indexed_pending
FROM watermark w
CROSS JOIN LATERAL (
  SELECT state.pool_id, state.token_address, state.name, state.symbol,
    state.indexed_pending
  FROM keeper_pool_fee_state state
  WHERE state.chain_id = $1::bigint
    AND state.indexed_pending > 0
    AND w.last_processed_block IS NOT NULL
  ORDER BY state.indexed_pending DESC, state.pool_id ASC
  LIMIT ${SWEEP_CANDIDATE_LIMIT}
) candidate
ORDER BY candidate.indexed_pending DESC, candidate.pool_id ASC`;

interface WatermarkRow extends DbRow {
  stream: unknown;
  next_block: unknown;
  last_processed_block: unknown;
  last_processed_hash: unknown;
  observed_safe_head: unknown;
  observed_at: unknown;
  last_run_status: unknown;
  updated_at: unknown;
}

interface AccountingRow extends DbRow {
  total_bounty: unknown;
  sequester_bounty: unknown;
  treasury_bounty: unknown;
  sequester_calls: unknown;
  treasury_calls: unknown;
  sweep_calls: unknown;
}

interface RecentActionRow extends DbRow {
  kind: unknown;
  transaction_hash: unknown;
  block_number: unknown;
  block_timestamp: unknown;
  processed: unknown;
  routed: unknown;
  bounty: unknown;
  pool_id: unknown;
}

interface SweepCandidateRow extends DbRow {
  pool_id: unknown;
  token_address: unknown;
  name: unknown;
  symbol: unknown;
  indexed_pending: unknown;
}

function text(value: unknown, label: string) {
  if (typeof value !== "string") throw new Error(`${label} is invalid.`);
  return value;
}

function nullableText(value: unknown, label: string) {
  if (value === null) return null;
  return text(value, label);
}

function timestamp(value: unknown, label: string) {
  const parsed = new Date(text(value, label));
  if (!Number.isFinite(parsed.getTime())) throw new Error(`${label} is invalid.`);
  return parsed.toISOString();
}

function cumulative(value: unknown, label: string) {
  const parsed = text(value, label);
  if (!/^(0|[1-9]\d*)$/.test(parsed)) {
    throw new Error(`${label} is invalid.`);
  }
  return parsed;
}

function mapWatermark(row: WatermarkRow): IndexerWatermark {
  const status = row.last_run_status;
  if (status !== "caught-up" && status !== "bounded" && status !== "deadline") {
    throw new Error("Indexer observation status is invalid.");
  }
  return {
    stream: text(row.stream, "Indexer stream"),
    nextBlock: normalizeUint256(text(row.next_block, "Indexer next block")),
    lastProcessedBlock: normalizeUint256(text(row.last_processed_block, "Indexer last block")),
    lastProcessedHash: normalizeBytes32(text(row.last_processed_hash, "Indexer last hash")),
    observedSafeHead: normalizeUint256(text(row.observed_safe_head, "Indexer safe head")),
    observedAt: timestamp(row.observed_at, "Indexer observation time"),
    lastRunStatus: status,
    updatedAt: timestamp(row.updated_at, "Indexer update time"),
  };
}

function mapAction(row: RecentActionRow): IndexedKeeperAction {
  const kind = text(row.kind, "Keeper action kind");
  if (kind !== "sweep" && kind !== "sequestered" && kind !== "treasury") {
    throw new Error("Keeper action kind is invalid.");
  }
  const mappedKind = kind === "sequestered" ? "sequester" : kind;
  const poolId = row.pool_id === null
    ? null
    : normalizeBytes32(text(row.pool_id, "Keeper action pool"));
  if ((mappedKind === "sweep") !== (poolId !== null)) {
    throw new Error("Keeper action pool binding is invalid.");
  }
  const bounty = normalizeUint256(text(row.bounty, "Keeper bounty"));
  const processed = normalizeUint256(text(row.processed, "Keeper processed amount"));
  const routed = normalizeUint256(text(row.routed, "Keeper routed amount"));
  if (mappedKind === "sweep" && bounty !== "0") {
    throw new Error("A hook sweep cannot carry a keeper bounty.");
  }
  if (BigInt(processed) !== BigInt(routed) + BigInt(bounty)) {
    throw new Error("Keeper action processed amount is not conserved.");
  }
  return {
    kind: mappedKind,
    transactionHash: normalizeBytes32(text(row.transaction_hash, "Keeper transaction")),
    blockNumber: normalizeUint256(text(row.block_number, "Keeper block")),
    blockTimestamp: timestamp(row.block_timestamp, "Keeper block time"),
    processedPipedog: processed,
    routedPipedog: routed,
    bountyPipedog: bounty,
    poolId,
  };
}

function mapCandidate(row: SweepCandidateRow): KeeperSweepCandidate {
  const pending = normalizeUint256(text(row.indexed_pending, "Indexed pending fee"));
  if (pending === "0") throw new Error("Indexed sweep candidate has no pending fees.");
  return {
    poolId: normalizeBytes32(text(row.pool_id, "Sweep pool")),
    tokenAddress: normalizeAddress(text(row.token_address, "Sweep token")),
    name: nullableText(row.name, "Sweep token name"),
    symbol: nullableText(row.symbol, "Sweep token symbol"),
    indexedPendingPipedog: pending,
  };
}

export function parseKeeperRewardsRequest(value: unknown): { wallet: Address } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new MarketInputError("Request body must be a JSON object.");
  }
  const body = value as Record<string, unknown>;
  if (Object.keys(body).length !== 1 || !("wallet" in body)) {
    throw new MarketInputError("Request body must contain only wallet.");
  }
  try {
    return {
      wallet: normalizeAddress(typeof body.wallet === "string" ? body.wallet : "", "Wallet"),
    };
  } catch {
    throw new MarketInputError("wallet must be a valid EVM address.");
  }
}

export async function loadKeeperRewards(
  database: DbClient,
  request: { wallet: Address },
  dependencies: { now?: () => number } = {},
): Promise<KeeperRewardsResponse> {
  const timeout = databaseFetchOptions(DATABASE_READ_TIMEOUT_MS);
  const precheckRows = await database.query<WatermarkRow>(
    KEEPER_WATERMARK_SQL,
    [LAYPIPE_CHAIN_ID, INDEXER_STREAM],
    timeout,
  );
  if (
    precheckRows.length !== 1 ||
    assessIndexerFreshness(
      mapWatermark(precheckRows[0]!),
      (dependencies.now ?? Date.now)(),
    ).status !== "fresh"
  ) {
    throw new Error("Keeper read model is stale.");
  }

  const [watermarkRows, accountingRows, recentRows, candidateRows] =
    await database.transaction(
      (transaction) => [
        transaction.query<WatermarkRow>(
          KEEPER_WATERMARK_SQL,
          [LAYPIPE_CHAIN_ID, INDEXER_STREAM],
          timeout,
        ),
        transaction.query<AccountingRow>(
          KEEPER_ACCOUNTING_SQL,
          [LAYPIPE_CHAIN_ID, request.wallet],
          timeout,
        ),
        transaction.query<RecentActionRow>(
          KEEPER_RECENT_ACTIONS_SQL,
          [LAYPIPE_CHAIN_ID, request.wallet],
          timeout,
        ),
        transaction.query<SweepCandidateRow>(
          KEEPER_SWEEP_CANDIDATES_SQL,
          [LAYPIPE_CHAIN_ID],
          timeout,
        ),
      ] as const,
      {
        isolationLevel: "RepeatableRead",
        readOnly: true,
        deferrable: true,
        fetchOptions: { signal: AbortSignal.timeout(DATABASE_READ_TIMEOUT_MS) },
      },
    );

  if (watermarkRows.length !== 1 || accountingRows.length !== 1) {
    throw new Error("Keeper read-model watermark is unavailable.");
  }
  const indexer = mapWatermark(watermarkRows[0]!);
  if (
    assessIndexerFreshness(indexer, (dependencies.now ?? Date.now)()).status !== "fresh"
  ) {
    throw new Error("Keeper read model is stale.");
  }
  const accounting = accountingRows[0]!;
  const sequesterBounty = cumulative(
    accounting.sequester_bounty,
    "Sequester bounty",
  );
  const treasuryBounty = cumulative(
    accounting.treasury_bounty,
    "Treasury bounty",
  );
  const totalBounty = cumulative(accounting.total_bounty, "Total bounty");
  if (BigInt(totalBounty) !== BigInt(sequesterBounty) + BigInt(treasuryBounty)) {
    throw new Error("Indexed keeper bounty totals are inconsistent.");
  }

  return {
    source: "live",
    chainId: 4_663,
    wallet: request.wallet,
    asOfBlock: indexer.lastProcessedBlock!,
    accounting: {
      totalBountyPipedog: totalBounty,
      sequesterBountyPipedog: sequesterBounty,
      treasuryBountyPipedog: treasuryBounty,
      sequesterCalls: cumulative(accounting.sequester_calls, "Sequester call count"),
      treasuryCalls: cumulative(accounting.treasury_calls, "Treasury call count"),
      sweepCalls: cumulative(accounting.sweep_calls, "Sweep call count"),
    },
    recentActions: recentRows.map(mapAction),
    sweepCandidates: candidateRows.map(mapCandidate),
    eligibility: {
      status: "wallet-verification-required",
      reason:
        "Indexed candidates are not executable proof. The connected wallet must verify the audited manifest, read current contract state, and simulate each call.",
    },
    indexer,
  };
}
