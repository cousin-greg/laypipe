import { createHmac, timingSafeEqual } from "node:crypto";
import type { DbClient, DbRow } from "../db/neon";
import {
  LAYPIPE_CHAIN_ID,
  type IndexerWatermark,
  type LiveMarketToken,
  type LiveTokenDetailResponse,
  type LiveTokenListResponse,
  type PipedogPriceRatio,
} from "../../market/live";
import { normalizeAddress, normalizeBytes32, normalizeUint256 } from "../indexer/model";

export const TOKEN_LIST_DEFAULT_LIMIT = 20;
export const TOKEN_LIST_MAX_LIMIT = 50;
const INDEXER_STREAM = "laypipe";
const CURSOR_DOMAIN = "laypipe.market.cursor.v1";

export class MarketInputError extends Error {}

interface CursorValue {
  blockNumber: string;
  logIndex: number;
  tokenAddress: `0x${string}`;
}

export function readMarketCursorSecret() {
  const secret = process.env.WALLET_CHALLENGE_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error("WALLET_CHALLENGE_SECRET is required for live market cursors.");
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

const TOKEN_METRICS_CTES = `
, latest_swap AS (
  SELECT DISTINCT ON (s.pool_id)
    s.pool_id, s.pipedog_amount::text AS last_pipedog_amount,
    s.token_amount::text AS last_token_amount, s.block_timestamp::text AS last_trade_at
  FROM swaps s
  JOIN selected p ON p.pool_id = s.pool_id AND p.chain_id = s.chain_id
  WHERE s.token_amount > 0
  ORDER BY s.pool_id, s.block_number DESC, s.log_index DESC
), baseline_swap AS (
  SELECT DISTINCT ON (s.pool_id)
    s.pool_id, s.pipedog_amount::text AS baseline_pipedog_amount,
    s.token_amount::text AS baseline_token_amount
  FROM swaps s
  JOIN selected p ON p.pool_id = s.pool_id AND p.chain_id = s.chain_id
  WHERE s.token_amount > 0 AND s.block_timestamp >= now() - interval '24 hours'
  ORDER BY s.pool_id, s.block_number ASC, s.log_index ASC
), swap_stats AS (
  SELECT s.pool_id,
    count(*)::text AS total_trades,
    count(*) FILTER (WHERE s.block_timestamp >= now() - interval '24 hours')::text AS trades_24h,
    coalesce(sum(s.pipedog_amount) FILTER (
      WHERE s.block_timestamp >= now() - interval '24 hours'
    ), 0)::text AS volume_24h_pipedog
  FROM swaps s
  JOIN selected p ON p.pool_id = s.pool_id AND p.chain_id = s.chain_id
  GROUP BY s.pool_id
)
SELECT p.chain_id::text, p.token_address, p.pool_id, p.creator_address,
  p.config_id::text, p.first_buy_in::text, p.first_buy_out::text,
  p.hook_address, p.fee_recipient_address, p.fee_mode, p.name, p.symbol,
  p.description, p.logo_uri, p.metadata_uri, p.socials,
  p.block_number::text, p.log_index, p.launched_at::text,
  ls.last_pipedog_amount, ls.last_token_amount, ls.last_trade_at,
  bs.baseline_pipedog_amount, bs.baseline_token_amount,
  coalesce(ss.volume_24h_pipedog, '0') AS volume_24h_pipedog,
  coalesce(ss.trades_24h, '0') AS trades_24h,
  coalesce(ss.total_trades, '0') AS total_trades
FROM selected p
LEFT JOIN latest_swap ls ON ls.pool_id = p.pool_id
LEFT JOIN baseline_swap bs ON bs.pool_id = p.pool_id
LEFT JOIN swap_stats ss ON ss.pool_id = p.pool_id`;

export const TOKEN_LIST_SQL = `
WITH selected AS (
  SELECT l.*
  FROM launches l
  WHERE l.chain_id = $1::bigint
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
WITH selected AS (
  SELECT l.*
  FROM launches l
  WHERE l.chain_id = $1::bigint AND l.token_address = $2::evm_address
  LIMIT 1
)
${TOKEN_METRICS_CTES}`;

export const INDEXER_WATERMARK_SQL = `
SELECT stream, next_block::text, last_processed_block::text,
  last_processed_hash, updated_at::text
FROM indexer_cursors
WHERE chain_id = $1::bigint AND stream = $2::text`;

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

interface WatermarkRow extends DbRow {
  stream: string;
  next_block: string;
  last_processed_block: string | null;
  last_processed_hash: string | null;
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

function nullableText(value: unknown, label: string) {
  if (value === null) return null;
  if (typeof value !== "string") throw new Error(`${label} is not text.`);
  return value;
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
        value: normalizeUint256(row.volume_24h_pipedog, "Indexed 24-hour volume"),
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

async function loadWatermark(database: DbClient): Promise<IndexerWatermark | null> {
  const rows = await database.query<WatermarkRow>(INDEXER_WATERMARK_SQL, [
    LAYPIPE_CHAIN_ID,
    INDEXER_STREAM,
  ]);
  const row = rows[0];
  if (!row) return null;
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
  };
}

export async function listLiveTokens(
  database: DbClient,
  options: { limit: number; cursor: CursorValue | null },
  cursorSecret = readMarketCursorSecret(),
): Promise<LiveTokenListResponse> {
  const limit = options.limit;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > TOKEN_LIST_MAX_LIMIT) {
    throw new MarketInputError(`limit must be between 1 and ${TOKEN_LIST_MAX_LIMIT}.`);
  }
  const cursor = options.cursor;
  const [rows, indexer] = await Promise.all([
    database.query<TokenRow>(TOKEN_LIST_SQL, [
      LAYPIPE_CHAIN_ID,
      cursor?.blockNumber ?? null,
      cursor?.logIndex ?? null,
      cursor?.tokenAddress ?? null,
      limit + 1,
    ]),
    loadWatermark(database),
  ]);
  const visible = rows.slice(0, limit);
  const last = visible.at(-1);
  return {
    source: "live",
    chainId: LAYPIPE_CHAIN_ID,
    tokens: visible.map(mapToken),
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
): Promise<LiveTokenDetailResponse | null> {
  const address = parseLiveTokenSlug(slug);
  const [rows, indexer] = await Promise.all([
    database.query<TokenRow>(TOKEN_DETAIL_SQL, [LAYPIPE_CHAIN_ID, address]),
    loadWatermark(database),
  ]);
  const row = rows[0];
  if (!row) return null;
  return {
    source: "live",
    chainId: LAYPIPE_CHAIN_ID,
    token: mapToken(row),
    indexer,
  };
}

export async function getMarketHealth(database: DbClient) {
  return loadWatermark(database);
}
