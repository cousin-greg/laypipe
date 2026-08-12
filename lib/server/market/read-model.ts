import { createHmac, timingSafeEqual } from "node:crypto";
import {
  DATABASE_READ_TIMEOUT_MS,
  databaseFetchOptions,
  type DbClient,
  type DbRow,
} from "../db/neon";
import {
  LAYPIPE_CHAIN_ID,
  type IndexerWatermark,
  type LiveMarketToken,
  type LiveTokenDetailResponse,
  type LiveTokenListResponse,
  type PipedogPriceRatio,
} from "../../market/live";
import { normalizeAddress, normalizeBytes32, normalizeUint256 } from "../indexer/model";
import { ipfsCidFromUri, resolveIpfsGatewayUrl } from "../../ipfs/gateway";

export const TOKEN_LIST_DEFAULT_LIMIT = 20;
export const TOKEN_LIST_MAX_LIMIT = 50;
export const MARKET_INDEXER_STALE_AFTER_MS = 5 * 60 * 1_000;
export const MARKET_INDEXER_MAX_CLOCK_SKEW_MS = 30 * 1_000;
export const MARKET_INDEXER_MAX_BLOCK_LAG = 2;
export const MARKET_AGGREGATE_MAX_DECIMAL_DIGITS = 156;
const INDEXER_STREAM = "laypipe";
const CURSOR_DOMAIN = "laypipe.market.cursor.v1";
const MARKET_LEADER_KINDS = [
  "most-traded",
  "newest",
  "biggest-mover",
] as const;
type MarketLeaderKind = (typeof MARKET_LEADER_KINDS)[number];

export class MarketInputError extends Error {}

interface CursorValue {
  blockNumber: string;
  logIndex: number;
  tokenAddress: `0x${string}`;
}

export function readMarketCursorSecret() {
  const secret = process.env.MARKET_CURSOR_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error("MARKET_CURSOR_SECRET is required for live market cursors.");
  }
  return secret;
}

function cursorSignature(payload: string, secret: string) {
  return createHmac("sha256", secret)
    .update(CURSOR_DOMAIN, "utf8")
    .update("\0", "utf8")
    .update(payload, "utf8")
    .digest();
}

export function parseTokenListRequest(
  requestUrl: string,
  cursorSecret = readMarketCursorSecret(),
) {
  const url = new URL(requestUrl);
  const allowed = new Set(["limit", "cursor"]);
  for (const key of url.searchParams.keys()) {
    if (!allowed.has(key)) throw new MarketInputError(`Unsupported query parameter: ${key}`);
  }
  for (const key of allowed) {
    if (url.searchParams.getAll(key).length > 1) {
      throw new MarketInputError(`${key} may only be provided once.`);
    }
  }

  const rawLimit = url.searchParams.get("limit");
  const limit = rawLimit === null ? TOKEN_LIST_DEFAULT_LIMIT : Number(rawLimit);
  if (!/^\d+$/.test(rawLimit ?? String(TOKEN_LIST_DEFAULT_LIMIT))) {
    throw new MarketInputError("limit must be an integer.");
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > TOKEN_LIST_MAX_LIMIT) {
    throw new MarketInputError(`limit must be between 1 and ${TOKEN_LIST_MAX_LIMIT}.`);
  }

  const rawCursor = url.searchParams.get("cursor");
  return {
    limit,
    cursor: rawCursor ? decodeTokenCursor(rawCursor, cursorSecret) : null,
  };
}

export function encodeTokenCursor(
  cursor: CursorValue,
  cursorSecret = readMarketCursorSecret(),
) {
  const payload = JSON.stringify({
    v: 1,
    b: normalizeUint256(cursor.blockNumber, "Cursor block"),
    l: postgresInteger(cursor.logIndex, "Cursor log index"),
    a: normalizeAddress(cursor.tokenAddress, "Cursor token"),
  });
  const encodedPayload = Buffer.from(payload, "utf8").toString("base64url");
  const signature = cursorSignature(encodedPayload, cursorSecret).toString("base64url");
  return Buffer.from(
    JSON.stringify({ p: encodedPayload, s: signature }),
    "utf8",
  ).toString("base64url");
}

export function decodeTokenCursor(
  value: string,
  cursorSecret = readMarketCursorSecret(),
): CursorValue {
  if (!/^[A-Za-z0-9_-]{1,512}$/.test(value)) {
    throw new MarketInputError("cursor is malformed.");
  }
  try {
    const envelopeBytes = Buffer.from(value, "base64url");
    if (envelopeBytes.toString("base64url") !== value) {
      throw new Error("non-canonical envelope");
    }
    const envelope = JSON.parse(envelopeBytes.toString("utf8")) as {
      p?: unknown;
      s?: unknown;
    };
    if (
      Object.keys(envelope).sort().join(",") !== "p,s" ||
      typeof envelope.p !== "string" ||
      typeof envelope.s !== "string" ||
      !/^[A-Za-z0-9_-]{1,384}$/.test(envelope.p) ||
      !/^[A-Za-z0-9_-]{43}$/.test(envelope.s)
    ) {
      throw new Error("invalid envelope");
    }
    const suppliedSignature = Buffer.from(envelope.s, "base64url");
    if (
      suppliedSignature.toString("base64url") !== envelope.s ||
      suppliedSignature.length !== 32
    ) {
      throw new Error("invalid signature encoding");
    }
    const expectedSignature = cursorSignature(envelope.p, cursorSecret);
    if (!timingSafeEqual(suppliedSignature, expectedSignature)) {
      throw new Error("invalid signature");
    }
    const payloadBytes = Buffer.from(envelope.p, "base64url");
    if (payloadBytes.toString("base64url") !== envelope.p) {
      throw new Error("non-canonical payload");
    }
    const parsed = JSON.parse(payloadBytes.toString("utf8")) as {
      v?: unknown;
      b?: unknown;
      l?: unknown;
      a?: unknown;
    };
    if (
      parsed.v !== 1 ||
      typeof parsed.b !== "string" ||
      typeof parsed.l !== "number" ||
      typeof parsed.a !== "string"
    ) {
      throw new Error("invalid shape");
    }
    return {
      blockNumber: normalizeUint256(parsed.b, "Cursor block"),
      logIndex: postgresInteger(parsed.l, "Cursor log index"),
      tokenAddress: normalizeAddress(parsed.a, "Cursor token"),
    };
  } catch (error) {
    if (error instanceof MarketInputError) throw error;
    throw new MarketInputError("cursor is malformed.");
  }
}

export function parseLiveTokenSlug(value: string) {
  try {
    return normalizeAddress(decodeURIComponent(value), "Token slug");
  } catch {
    throw new MarketInputError("Live token slug must be a token contract address.");
  }
}

const MARKET_SNAPSHOT_WATERMARK_CTE = `watermark AS MATERIALIZED (
  SELECT c.last_processed_block, b.block_timestamp AS last_processed_at
  FROM indexer_cursors c
  JOIN chain_blocks b
    ON b.chain_id = c.chain_id
    AND b.block_number = c.last_processed_block
    AND b.block_hash = c.last_processed_hash
  WHERE c.chain_id = $1::bigint AND c.stream = '${INDEXER_STREAM}'
    AND c.last_processed_block IS NOT NULL
    AND c.last_processed_hash IS NOT NULL
    AND c.observed_safe_head IS NOT NULL
    AND c.observed_at IS NOT NULL
    AND c.last_run_status = 'caught-up'
    AND c.observed_safe_head >= c.last_processed_block
    AND c.observed_safe_head - c.last_processed_block <= ${MARKET_INDEXER_MAX_BLOCK_LAG}
    AND c.observed_at >= transaction_timestamp() - interval '${MARKET_INDEXER_STALE_AFTER_MS / 1_000} seconds'
    AND c.observed_at <= transaction_timestamp() + interval '${MARKET_INDEXER_MAX_CLOCK_SKEW_MS / 1_000} seconds'
)`;

function tokenMetricsCtes(extraSelectedColumns = "") {
  return `
, latest_swap AS (
  SELECT DISTINCT ON (s.pool_id)
    s.pool_id, s.pipedog_amount::text AS last_pipedog_amount,
    s.token_amount::text AS last_token_amount, s.block_timestamp::text AS last_trade_at
  FROM swaps s
  JOIN selected p ON p.pool_id = s.pool_id AND p.chain_id = s.chain_id
  CROSS JOIN watermark w
  WHERE s.token_amount > 0
    AND s.block_number <= w.last_processed_block
    AND s.block_timestamp <= w.last_processed_at
  ORDER BY s.pool_id, s.block_number DESC, s.log_index DESC
), baseline_swap AS (
  SELECT DISTINCT ON (s.pool_id)
    s.pool_id, s.pipedog_amount::text AS baseline_pipedog_amount,
    s.token_amount::text AS baseline_token_amount
  FROM swaps s
  JOIN selected p ON p.pool_id = s.pool_id AND p.chain_id = s.chain_id
  CROSS JOIN watermark w
  WHERE s.token_amount > 0
    AND s.block_number <= w.last_processed_block
    AND s.block_timestamp > w.last_processed_at - interval '24 hours'
    AND s.block_timestamp <= w.last_processed_at
  ORDER BY s.pool_id, s.block_number ASC, s.log_index ASC
), swap_stats AS (
  SELECT s.pool_id,
    count(*)::text AS trades_24h,
    coalesce(sum(s.pipedog_amount), 0)::text AS volume_24h_pipedog
  FROM swaps s
  JOIN selected p ON p.pool_id = s.pool_id AND p.chain_id = s.chain_id
  CROSS JOIN watermark w
  WHERE s.token_amount > 0
    AND s.block_number <= w.last_processed_block
    AND s.block_timestamp > w.last_processed_at - interval '24 hours'
    AND s.block_timestamp <= w.last_processed_at
  GROUP BY s.pool_id
)
SELECT ${extraSelectedColumns}p.chain_id::text, p.token_address, p.pool_id, p.creator_address,
  p.config_id::text, p.first_buy_in::text, p.first_buy_out::text,
  p.hook_address, p.fee_recipient_address, p.fee_mode, p.name, p.symbol,
  p.description, p.logo_uri, p.metadata_uri, approved_artwork.image_cid AS approved_logo_cid,
  p.socials,
  p.block_number::text, p.log_index, p.launched_at::text,
  ls.last_pipedog_amount, ls.last_token_amount, ls.last_trade_at,
  bs.baseline_pipedog_amount, bs.baseline_token_amount,
  coalesce(ss.volume_24h_pipedog, '0') AS volume_24h_pipedog,
  coalesce(ss.trades_24h, '0') AS trades_24h,
  coalesce(mt.total_trades::text, '0') AS total_trades
FROM selected p
LEFT JOIN LATERAL (
  SELECT promotion.image_cid
  FROM ipfs_promotions promotion
  WHERE promotion.status = 'completed'
    AND promotion.wallet_address = p.creator_address
    AND promotion.image_cid = substring(p.logo_uri FROM 8)
    AND promotion.metadata_cid = substring(p.metadata_uri FROM 8)
    AND p.logo_uri = 'ipfs://' || promotion.image_cid
    AND p.metadata_uri = 'ipfs://' || promotion.metadata_cid
  LIMIT 1
) approved_artwork ON true
LEFT JOIN latest_swap ls ON ls.pool_id = p.pool_id
LEFT JOIN baseline_swap bs ON bs.pool_id = p.pool_id
LEFT JOIN swap_stats ss ON ss.pool_id = p.pool_id
LEFT JOIN pool_market_totals mt
  ON mt.chain_id = p.chain_id AND mt.pool_id = p.pool_id`;
}

const TOKEN_METRICS_CTES = tokenMetricsCtes();

export const TOKEN_LIST_SQL = `
WITH ${MARKET_SNAPSHOT_WATERMARK_CTE}, selected AS (
  SELECT l.*
  FROM launches l
  CROSS JOIN watermark w
  WHERE l.chain_id = $1::bigint
    AND l.block_number <= w.last_processed_block
    AND (
      $2::bigint IS NULL
      OR (l.block_number, l.log_index, l.token_address)
        < ($2::bigint, $3::integer, $4::evm_address)
    )
  ORDER BY l.block_number DESC, l.log_index DESC, l.token_address DESC
  LIMIT $5::integer
)
${TOKEN_METRICS_CTES}
ORDER BY p.block_number DESC, p.log_index DESC, p.token_address DESC`;

export const TOKEN_DETAIL_SQL = `
WITH ${MARKET_SNAPSHOT_WATERMARK_CTE}, selected AS (
  SELECT l.*
  FROM launches l
  CROSS JOIN watermark w
  WHERE l.chain_id = $1::bigint AND l.token_address = $2::evm_address
    AND l.block_number <= w.last_processed_block
  LIMIT 1
)
${TOKEN_METRICS_CTES}`;

export const INDEXER_WATERMARK_SQL = `
SELECT stream, next_block::text, last_processed_block::text,
  last_processed_hash, observed_safe_head::text, observed_at::text,
  last_run_status, updated_at::text
FROM indexer_cursors
WHERE chain_id = $1::bigint AND stream = $2::text`;

export const MARKET_SNAPSHOT_WATERMARK_SQL = `
SELECT c.stream, c.next_block::text, c.last_processed_block::text,
  c.last_processed_hash, c.observed_safe_head::text, c.observed_at::text,
  c.last_run_status, c.updated_at::text
FROM indexer_cursors c
JOIN chain_blocks b
  ON b.chain_id = c.chain_id
  AND b.block_number = c.last_processed_block
  AND b.block_hash = c.last_processed_hash
WHERE c.chain_id = $1::bigint AND c.stream = $2::text
  AND c.last_processed_block IS NOT NULL
  AND c.last_processed_hash IS NOT NULL
  AND c.observed_safe_head IS NOT NULL
  AND c.observed_at IS NOT NULL
  AND c.last_run_status = 'caught-up'
  AND c.observed_safe_head >= c.last_processed_block
  AND c.observed_safe_head - c.last_processed_block <= ${MARKET_INDEXER_MAX_BLOCK_LAG}
  AND c.observed_at >= transaction_timestamp() - interval '${MARKET_INDEXER_STALE_AFTER_MS / 1_000} seconds'
  AND c.observed_at <= transaction_timestamp() + interval '${MARKET_INDEXER_MAX_CLOCK_SKEW_MS / 1_000} seconds'`;

const MARKET_LEADER_SNAPSHOT_PREDICATE = `
  snapshot.chain_id = $1::bigint
  AND cursor.stream = '${INDEXER_STREAM}'
  AND cursor.last_processed_block IS NOT NULL
  AND cursor.last_processed_hash IS NOT NULL
  AND cursor.observed_safe_head IS NOT NULL
  AND cursor.observed_at IS NOT NULL
  AND cursor.last_run_status = 'caught-up'
  AND snapshot.snapshot_block <= cursor.last_processed_block
  AND cursor.observed_safe_head >= cursor.last_processed_block
  AND cursor.observed_safe_head - cursor.last_processed_block <= ${MARKET_INDEXER_MAX_BLOCK_LAG}
  AND cursor.observed_at >= transaction_timestamp() - interval '${MARKET_INDEXER_STALE_AFTER_MS / 1_000} seconds'
  AND cursor.observed_at <= transaction_timestamp() + interval '${MARKET_INDEXER_MAX_CLOCK_SKEW_MS / 1_000} seconds'
  AND snapshot.snapshot_at >= transaction_timestamp() - interval '${MARKET_INDEXER_STALE_AFTER_MS / 1_000} seconds'
  AND snapshot.snapshot_at <= transaction_timestamp() + interval '${MARKET_INDEXER_MAX_CLOCK_SKEW_MS / 1_000} seconds'
  AND snapshot.refreshed_at >= transaction_timestamp() - interval '${MARKET_INDEXER_STALE_AFTER_MS / 1_000} seconds'
  AND snapshot.refreshed_at <= transaction_timestamp() + interval '${MARKET_INDEXER_MAX_CLOCK_SKEW_MS / 1_000} seconds'`;

export const MARKET_LEADER_SNAPSHOT_SQL = `
SELECT snapshot.chain_id::text, snapshot.snapshot_block::text,
  snapshot.snapshot_hash, snapshot.snapshot_at::text, snapshot.refreshed_at::text
FROM market_leader_snapshots snapshot
JOIN indexer_cursors cursor ON cursor.chain_id = snapshot.chain_id
JOIN chain_blocks block
  ON block.chain_id = snapshot.chain_id
  AND block.block_number = snapshot.snapshot_block
  AND block.block_hash = snapshot.snapshot_hash
WHERE ${MARKET_LEADER_SNAPSHOT_PREDICATE}`;

const MARKET_LEADER_WATERMARK_CTE = `watermark AS MATERIALIZED (
  SELECT snapshot.snapshot_block AS last_processed_block,
    block.block_timestamp AS last_processed_at
  FROM market_leader_snapshots snapshot
  JOIN indexer_cursors cursor ON cursor.chain_id = snapshot.chain_id
  JOIN chain_blocks block
    ON block.chain_id = snapshot.chain_id
    AND block.block_number = snapshot.snapshot_block
    AND block.block_hash = snapshot.snapshot_hash
  WHERE ${MARKET_LEADER_SNAPSHOT_PREDICATE}
)`;

export const MARKET_LEADERS_SQL = `
WITH leader_refs AS MATERIALIZED (
  SELECT entry.chain_id, entry.leader_kind, entry.token_address
  FROM market_leader_entries entry
  WHERE entry.chain_id = $1::bigint
    AND entry.leader_kind IN ('most-traded', 'newest', 'biggest-mover')
  ORDER BY CASE entry.leader_kind
    WHEN 'most-traded' THEN 1
    WHEN 'newest' THEN 2
    WHEN 'biggest-mover' THEN 3
    ELSE 4
  END
  LIMIT 3
), leader_metrics AS MATERIALIZED (
  WITH ${MARKET_LEADER_WATERMARK_CTE}, selected AS (
    SELECT launch.*
    FROM launches launch
    JOIN (
      SELECT DISTINCT chain_id, token_address
      FROM leader_refs
    ) leader_token
      ON leader_token.chain_id = launch.chain_id
      AND leader_token.token_address = launch.token_address
    CROSS JOIN watermark
    WHERE launch.block_number <= watermark.last_processed_block
  )
  ${TOKEN_METRICS_CTES}
)
SELECT leader_refs.leader_kind, leader_metrics.*
FROM leader_refs
JOIN leader_metrics
  ON leader_metrics.chain_id::bigint = leader_refs.chain_id
  AND leader_metrics.token_address = leader_refs.token_address
ORDER BY CASE leader_refs.leader_kind
  WHEN 'most-traded' THEN 1
  WHEN 'newest' THEN 2
  WHEN 'biggest-mover' THEN 3
  ELSE 4
END`;

interface TokenRow extends DbRow {
  chain_id: string;
  token_address: string;
  pool_id: string;
  creator_address: string;
  config_id: string;
  first_buy_in: string;
  first_buy_out: string;
  hook_address: string;
  fee_recipient_address: string;
  fee_mode: string;
  name: string | null;
  symbol: string | null;
  description: string | null;
  logo_uri: string | null;
  metadata_uri: string | null;
  approved_logo_cid: string | null;
  socials: unknown;
  block_number: string;
  log_index: number;
  launched_at: string;
  last_pipedog_amount: string | null;
  last_token_amount: string | null;
  last_trade_at: string | null;
  baseline_pipedog_amount: string | null;
  baseline_token_amount: string | null;
  volume_24h_pipedog: string;
  trades_24h: string;
  total_trades: string;
}

interface LeaderTokenRow extends TokenRow {
  leader_kind: string;
}

interface LeaderSnapshotRow extends DbRow {
  chain_id: string;
  snapshot_block: string;
  snapshot_hash: string;
  snapshot_at: string;
  refreshed_at: string;
}

export interface MarketLeaderSnapshot {
  chainId: number;
  blockNumber: string;
  blockHash: `0x${string}`;
  snapshotAt: string;
  refreshedAt: string;
}

interface WatermarkRow extends DbRow {
  stream: string;
  next_block: string;
  last_processed_block: string | null;
  last_processed_hash: string | null;
  observed_safe_head: string | null;
  observed_at: string | null;
  last_run_status: string | null;
  updated_at: string;
}

function postgresInteger(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 2_147_483_647) {
    throw new MarketInputError(`${label} is outside the supported range.`);
  }
  return value;
}

function count(value: string, label: string) {
  const normalized = normalizeUint256(value, label);
  const numeric = Number(normalized);
  if (!Number.isSafeInteger(numeric)) throw new Error(`${label} is too large to serialize.`);
  return numeric;
}

export function normalizeUnsignedAggregate(value: unknown, label: string) {
  if (
    typeof value !== "string" ||
    !new RegExp(`^(0|[1-9][0-9]{0,${MARKET_AGGREGATE_MAX_DECIMAL_DIGITS - 1}})$`).test(value)
  ) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function nullableText(value: unknown, label: string) {
  if (value === null) return null;
  if (typeof value !== "string") throw new Error(`${label} is not text.`);
  return value;
}

function approvedLogoGatewayUrl(value: unknown) {
  const cid = nullableText(value, "Approved artwork CID");
  if (!cid) return null;
  if (ipfsCidFromUri(`ipfs://${cid}`) !== cid) {
    throw new Error("Approved artwork CID is invalid.");
  }
  return resolveIpfsGatewayUrl({
    cid,
    configured: process.env.IPFS_GATEWAY_BASE_URL,
    requireConfigured: process.env.NODE_ENV === "production",
  });
}

function timestamp(value: string, label: string) {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error(`${label} is invalid.`);
  return parsed.toISOString();
}

function socials(value: unknown) {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Indexed token socials are invalid.");
  }
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string") throw new Error("Indexed token socials are invalid.");
    result[key] = entry;
  }
  return result;
}

function priceMetric(
  pipedogAmount: string | null,
  tokenAmount: string | null,
  basis: string,
) {
  if (pipedogAmount === null || tokenAmount === null || tokenAmount === "0") {
    return {
      status: "unavailable" as const,
      value: null,
      reason: "No qualifying indexed swap exists for this price point.",
    };
  }
  const value: PipedogPriceRatio = {
    pipedogAmount: normalizeUint256(pipedogAmount, "Indexed PIPEDOG amount"),
    tokenAmount: normalizeUint256(tokenAmount, "Indexed token amount"),
  };
  return { status: "observed" as const, value, basis };
}

function mapToken(row: TokenRow): LiveMarketToken {
  const chainId = count(row.chain_id, "Indexed chain ID");
  if (chainId !== LAYPIPE_CHAIN_ID) throw new Error("Unexpected indexed chain ID.");
  if (row.fee_mode !== "creator" && row.fee_mode !== "self-burn") {
    throw new Error("Indexed fee mode is invalid.");
  }
  const tokenAddress = normalizeAddress(row.token_address, "Indexed token");
  return {
    source: "live",
    chainId,
    slug: tokenAddress,
    tokenAddress,
    poolId: normalizeBytes32(row.pool_id, "Indexed pool"),
    creatorAddress: normalizeAddress(row.creator_address, "Indexed creator"),
    hookAddress: normalizeAddress(row.hook_address, "Indexed hook"),
    feeRecipientAddress: normalizeAddress(row.fee_recipient_address, "Indexed fee recipient"),
    feeMode: row.fee_mode,
    configId: normalizeUint256(row.config_id, "Indexed config ID"),
    firstBuyPipedogIn: normalizeUint256(row.first_buy_in, "Indexed first buy input"),
    firstBuyTokenOut: normalizeUint256(row.first_buy_out, "Indexed first buy output"),
    name: nullableText(row.name, "Indexed token name"),
    symbol: nullableText(row.symbol, "Indexed token symbol"),
    description: nullableText(row.description, "Indexed token description"),
    logoUri: nullableText(row.logo_uri, "Indexed logo URI"),
    logoGatewayUrl: approvedLogoGatewayUrl(row.approved_logo_cid),
    metadataUri: nullableText(row.metadata_uri, "Indexed metadata URI"),
    socials: socials(row.socials),
    blockNumber: normalizeUint256(row.block_number, "Indexed launch block"),
    launchedAt: timestamp(row.launched_at, "Indexed launch time"),
    lastTradeAt: row.last_trade_at ? timestamp(row.last_trade_at, "Indexed trade time") : null,
    metrics: {
      lastPricePipedog: priceMetric(
        row.last_pipedog_amount,
        row.last_token_amount,
        "Exact PIPEDOG/token ratio from the newest indexed swap.",
      ),
      baselinePrice24hPipedog: priceMetric(
        row.baseline_pipedog_amount,
        row.baseline_token_amount,
        "Exact PIPEDOG/token ratio from the earliest indexed swap in the trailing 24-hour window.",
      ),
      volume24hPipedog: {
        status: "observed",
        value: normalizeUnsignedAggregate(
          row.volume_24h_pipedog,
          "Indexed 24-hour volume",
        ),
        basis: "Sum of PIPEDOG amounts in indexed swaps during the trailing 24 hours; zero means no such swaps were observed.",
      },
      trades24h: {
        status: "observed",
        value: count(row.trades_24h, "Indexed 24-hour trade count"),
        basis: "Count of indexed swaps during the trailing 24 hours; zero means none were observed.",
      },
      totalTrades: {
        status: "observed",
        value: count(row.total_trades, "Indexed trade count"),
        basis: "Count of all swaps indexed for this LayPipe pool.",
      },
      marketCapUsd: {
        status: "unavailable",
        value: null,
        reason: "No trusted PIPEDOG/USD oracle is part of the indexed read model.",
      },
      liquidityUsd: {
        status: "unavailable",
        value: null,
        reason: "The indexer does not currently derive a trusted USD liquidity value.",
      },
      holders: {
        status: "unavailable",
        value: null,
        reason: "Holder aggregation is not enabled in this bounded market endpoint.",
      },
    },
  };
}

function mapWatermark(row: WatermarkRow): IndexerWatermark {
  const hasLastBlock = row.last_processed_block !== null;
  const hasLastHash = row.last_processed_hash !== null;
  if (hasLastBlock !== hasLastHash) {
    throw new Error("Indexer watermark is internally inconsistent.");
  }
  let lastRunStatus: IndexerWatermark["lastRunStatus"];
  if (
    row.last_run_status === "caught-up" ||
    row.last_run_status === "bounded" ||
    row.last_run_status === "deadline"
  ) {
    lastRunStatus = row.last_run_status;
  } else if (row.last_run_status === null) {
    lastRunStatus = null;
  } else {
    throw new Error("Indexer run status is invalid.");
  }
  return {
    stream: row.stream,
    nextBlock: normalizeUint256(row.next_block, "Indexer next block"),
    lastProcessedBlock:
      row.last_processed_block === null
        ? null
        : normalizeUint256(row.last_processed_block, "Indexer last block"),
    lastProcessedHash:
      row.last_processed_hash === null
        ? null
        : normalizeBytes32(row.last_processed_hash, "Indexer last hash"),
    updatedAt: timestamp(row.updated_at, "Indexer update time"),
    observedSafeHead:
      row.observed_safe_head === null
        ? null
        : normalizeUint256(row.observed_safe_head, "Observed safe head"),
    observedAt:
      row.observed_at === null
        ? null
        : timestamp(row.observed_at, "Indexer observation time"),
    lastRunStatus,
  };
}

function requireLeaderSnapshot(
  row: LeaderSnapshotRow,
  indexer: IndexerWatermark,
  nowMs: number,
): MarketLeaderSnapshot {
  const chainId = count(row.chain_id, "Market leader snapshot chain ID");
  const snapshotBlock = normalizeUint256(
    row.snapshot_block,
    "Market leader snapshot block",
  );
  const snapshotHash = normalizeBytes32(
    row.snapshot_hash,
    "Market leader snapshot hash",
  );
  const snapshotAt = timestamp(row.snapshot_at, "Market leader snapshot time");
  const refreshedAt = timestamp(row.refreshed_at, "Market leader refresh time");
  if (
    chainId !== LAYPIPE_CHAIN_ID ||
    indexer.lastProcessedBlock === null ||
    BigInt(snapshotBlock) > BigInt(indexer.lastProcessedBlock)
  ) {
    throw new Error("Live market leader snapshot is not canonical.");
  }
  for (const value of [snapshotAt, refreshedAt]) {
    const ageMs = nowMs - new Date(value).getTime();
    if (
      ageMs > MARKET_INDEXER_STALE_AFTER_MS ||
      ageMs < -MARKET_INDEXER_MAX_CLOCK_SKEW_MS
    ) {
      throw new Error("Live market leader snapshot is not fresh.");
    }
  }
  return {
    chainId,
    blockNumber: snapshotBlock,
    blockHash: snapshotHash,
    snapshotAt,
    refreshedAt,
  };
}

function isMarketLeaderKind(value: string): value is MarketLeaderKind {
  return (MARKET_LEADER_KINDS as readonly string[]).includes(value);
}

function mapMarketLeaders(rows: LeaderTokenRow[]) {
  if (rows.length > MARKET_LEADER_KINDS.length) {
    throw new Error("Live market leader snapshot is invalid.");
  }
  const leaders: LiveTokenListResponse["leaders"] = {
    mostTraded: null,
    newest: null,
    biggestMover: null,
  };
  const seen = new Set<MarketLeaderKind>();
  for (const row of rows) {
    if (!isMarketLeaderKind(row.leader_kind) || seen.has(row.leader_kind)) {
      throw new Error("Live market leader snapshot is invalid.");
    }
    seen.add(row.leader_kind);
    const token = mapToken(row);
    if (row.leader_kind === "most-traded") leaders.mostTraded = token;
    else if (row.leader_kind === "newest") leaders.newest = token;
    else leaders.biggestMover = token;
  }
  return leaders;
}

async function loadWatermark(database: DbClient): Promise<IndexerWatermark | null> {
  const rows = await database.query<WatermarkRow>(
    INDEXER_WATERMARK_SQL,
    [LAYPIPE_CHAIN_ID, INDEXER_STREAM],
    databaseFetchOptions(DATABASE_READ_TIMEOUT_MS),
  );
  const row = rows[0];
  return row ? mapWatermark(row) : null;
}

async function requireFreshMarketPrecheck(database: DbClient, nowMs: number) {
  const indexer = await loadWatermark(database);
  if (!indexer || assessIndexerFreshness(indexer, nowMs).status !== "fresh") {
    throw new Error("Live market indexer is not ready.");
  }
}

const MARKET_SNAPSHOT_TRANSACTION_OPTIONS = {
  isolationLevel: "RepeatableRead",
  readOnly: true,
  deferrable: true,
} as const;

export async function listLiveTokens(
  database: DbClient,
  options: { limit: number; cursor: CursorValue | null },
  cursorSecret = readMarketCursorSecret(),
  nowMs = Date.now(),
): Promise<LiveTokenListResponse> {
  const limit = options.limit;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > TOKEN_LIST_MAX_LIMIT) {
    throw new MarketInputError(`limit must be between 1 and ${TOKEN_LIST_MAX_LIMIT}.`);
  }
  const cursor = options.cursor;
  await requireFreshMarketPrecheck(database, nowMs);
  const [watermarkRows, leaderSnapshotRows, rows, leaderRows] = await database.transaction(
    (transaction) => [
      transaction.query<WatermarkRow>(
        MARKET_SNAPSHOT_WATERMARK_SQL,
        [LAYPIPE_CHAIN_ID, INDEXER_STREAM],
        databaseFetchOptions(DATABASE_READ_TIMEOUT_MS),
      ),
      transaction.query<LeaderSnapshotRow>(
        MARKET_LEADER_SNAPSHOT_SQL,
        [LAYPIPE_CHAIN_ID],
        databaseFetchOptions(DATABASE_READ_TIMEOUT_MS),
      ),
      transaction.query<TokenRow>(
        TOKEN_LIST_SQL,
        [
          LAYPIPE_CHAIN_ID,
          cursor?.blockNumber ?? null,
          cursor?.logIndex ?? null,
          cursor?.tokenAddress ?? null,
          limit + 1,
        ],
        databaseFetchOptions(DATABASE_READ_TIMEOUT_MS),
      ),
      transaction.query<LeaderTokenRow>(
        MARKET_LEADERS_SQL,
        [LAYPIPE_CHAIN_ID],
        databaseFetchOptions(DATABASE_READ_TIMEOUT_MS),
      ),
    ] as const,
    {
      ...MARKET_SNAPSHOT_TRANSACTION_OPTIONS,
      fetchOptions: { signal: AbortSignal.timeout(DATABASE_READ_TIMEOUT_MS) },
    },
  );
  if (watermarkRows.length !== 1) {
    throw new Error("Live market indexer is not ready.");
  }
  const indexer = mapWatermark(watermarkRows[0]);
  if (assessIndexerFreshness(indexer, nowMs).status !== "fresh") {
    throw new Error("Live market indexer is not ready.");
  }
  if (leaderSnapshotRows.length !== 1) {
    throw new Error("Live market leader snapshot is not ready.");
  }
  requireLeaderSnapshot(leaderSnapshotRows[0], indexer, nowMs);
  const visible = rows.slice(0, limit);
  const last = visible.at(-1);
  return {
    source: "live",
    chainId: LAYPIPE_CHAIN_ID,
    tokens: visible.map(mapToken),
    leaders: mapMarketLeaders(leaderRows),
    page: {
      limit,
      nextCursor:
        rows.length > limit && last
          ? encodeTokenCursor({
              blockNumber: last.block_number,
              logIndex: last.log_index,
              tokenAddress: normalizeAddress(last.token_address),
            }, cursorSecret)
          : null,
    },
    indexer,
  };
}

export async function getLiveToken(
  database: DbClient,
  slug: string,
  nowMs = Date.now(),
): Promise<LiveTokenDetailResponse | null> {
  const address = parseLiveTokenSlug(slug);
  await requireFreshMarketPrecheck(database, nowMs);
  const [watermarkRows, rows] = await database.transaction(
    (transaction) => [
      transaction.query<WatermarkRow>(
        MARKET_SNAPSHOT_WATERMARK_SQL,
        [LAYPIPE_CHAIN_ID, INDEXER_STREAM],
        databaseFetchOptions(DATABASE_READ_TIMEOUT_MS),
      ),
      transaction.query<TokenRow>(
        TOKEN_DETAIL_SQL,
        [LAYPIPE_CHAIN_ID, address],
        databaseFetchOptions(DATABASE_READ_TIMEOUT_MS),
      ),
    ] as const,
    {
      ...MARKET_SNAPSHOT_TRANSACTION_OPTIONS,
      fetchOptions: { signal: AbortSignal.timeout(DATABASE_READ_TIMEOUT_MS) },
    },
  );
  if (watermarkRows.length !== 1) {
    throw new Error("Live market indexer is not ready.");
  }
  const indexer = mapWatermark(watermarkRows[0]);
  if (assessIndexerFreshness(indexer, nowMs).status !== "fresh") {
    throw new Error("Live market indexer is not ready.");
  }
  const row = rows[0];
  if (!row) return null;
  return {
    source: "live",
    chainId: LAYPIPE_CHAIN_ID,
    token: mapToken(row),
    indexer,
  };
}

export async function getMarketHealth(
  database: DbClient,
  nowMs = Date.now(),
) {
  const [watermarkRows, leaderSnapshotRows] = await database.transaction(
    (transaction) => [
      transaction.query<WatermarkRow>(
        INDEXER_WATERMARK_SQL,
        [LAYPIPE_CHAIN_ID, INDEXER_STREAM],
        databaseFetchOptions(DATABASE_READ_TIMEOUT_MS),
      ),
      transaction.query<LeaderSnapshotRow>(
        MARKET_LEADER_SNAPSHOT_SQL,
        [LAYPIPE_CHAIN_ID],
        databaseFetchOptions(DATABASE_READ_TIMEOUT_MS),
      ),
    ] as const,
    {
      ...MARKET_SNAPSHOT_TRANSACTION_OPTIONS,
      fetchOptions: { signal: AbortSignal.timeout(DATABASE_READ_TIMEOUT_MS) },
    },
  );
  if (watermarkRows.length > 1 || leaderSnapshotRows.length > 1) {
    throw new Error("Live market readiness state is invalid.");
  }
  const watermarkRow = watermarkRows[0];
  const indexer = watermarkRow ? mapWatermark(watermarkRow) : null;
  if (!indexer || assessIndexerFreshness(indexer, nowMs).status !== "fresh") {
    return { indexer, leaderSnapshot: null };
  }
  const leaderSnapshotRow = leaderSnapshotRows[0];
  return {
    indexer,
    leaderSnapshot: leaderSnapshotRow
      ? requireLeaderSnapshot(leaderSnapshotRow, indexer, nowMs)
      : null,
  };
}

export type IndexerFreshness =
  | {
      status: "fresh";
      ageSeconds: number;
      staleAfterSeconds: number;
      blockLag: number;
      maxBlockLag: number;
    }
  | {
      status: "stale";
      ageSeconds: number;
      staleAfterSeconds: number;
      blockLag: number | null;
      maxBlockLag: number;
      reason:
        | "cursor_uninitialized"
        | "observation_missing"
        | "observation_too_old"
        | "observation_from_future"
        | "observation_behind_cursor"
        | "indexer_not_caught_up"
        | "block_lag_too_high";
    };

export function assessIndexerFreshness(
  watermark: IndexerWatermark,
  nowMs = Date.now(),
): IndexerFreshness {
  if (!Number.isFinite(nowMs)) throw new Error("Indexer freshness clock is invalid.");
  const observedAtMs = watermark.observedAt
    ? new Date(watermark.observedAt).getTime()
    : Number.NaN;
  const ageMs = nowMs - observedAtMs;
  const ageSeconds = Number.isFinite(ageMs)
    ? Math.max(0, Math.floor(ageMs / 1_000))
    : 0;
  const staleAfterSeconds = MARKET_INDEXER_STALE_AFTER_MS / 1_000;
  const maxBlockLag = MARKET_INDEXER_MAX_BLOCK_LAG;
  if (
    watermark.lastProcessedBlock === null ||
    watermark.lastProcessedHash === null
  ) {
    return {
      status: "stale",
      ageSeconds,
      staleAfterSeconds,
      blockLag: null,
      maxBlockLag,
      reason: "cursor_uninitialized",
    };
  }
  if (
    watermark.observedSafeHead === null ||
    watermark.observedAt === null ||
    watermark.lastRunStatus === null ||
    !Number.isFinite(observedAtMs)
  ) {
    return {
      status: "stale",
      ageSeconds: 0,
      staleAfterSeconds,
      blockLag: null,
      maxBlockLag,
      reason: "observation_missing",
    };
  }
  const rawLag = BigInt(watermark.observedSafeHead) - BigInt(watermark.lastProcessedBlock);
  if (rawLag < BigInt(0)) {
    return {
      status: "stale",
      ageSeconds,
      staleAfterSeconds,
      blockLag: null,
      maxBlockLag,
      reason: "observation_behind_cursor",
    };
  }
  const blockLag = rawLag > BigInt(Number.MAX_SAFE_INTEGER)
    ? Number.MAX_SAFE_INTEGER
    : Number(rawLag);
  if (ageMs < -MARKET_INDEXER_MAX_CLOCK_SKEW_MS) {
    return {
      status: "stale",
      ageSeconds,
      staleAfterSeconds,
      blockLag,
      maxBlockLag,
      reason: "observation_from_future",
    };
  }
  if (ageMs > MARKET_INDEXER_STALE_AFTER_MS) {
    return {
      status: "stale",
      ageSeconds,
      staleAfterSeconds,
      blockLag,
      maxBlockLag,
      reason: "observation_too_old",
    };
  }
  if (watermark.lastRunStatus !== "caught-up") {
    return {
      status: "stale",
      ageSeconds,
      staleAfterSeconds,
      blockLag,
      maxBlockLag,
      reason: "indexer_not_caught_up",
    };
  }
  if (blockLag > maxBlockLag) {
    return {
      status: "stale",
      ageSeconds,
      staleAfterSeconds,
      blockLag,
      maxBlockLag,
      reason: "block_lag_too_high",
    };
  }
  return { status: "fresh", ageSeconds, staleAfterSeconds, blockLag, maxBlockLag };
}
