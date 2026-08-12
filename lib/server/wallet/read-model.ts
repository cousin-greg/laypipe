import { createHmac, timingSafeEqual } from "node:crypto";
import { ipfsCidFromUri, resolveIpfsGatewayUrl } from "../../ipfs/gateway";
import { LAYPIPE_CHAIN_ID, type IndexerWatermark } from "../../market/live";
import type { WalletPortfolioResponse, WalletTokenPosition } from "../../wallet/live";
import type { Address } from "../../web3/types";
import type { DbClient, DbRow } from "../db/neon";
import { databaseFetchOptions } from "../db/neon";
import { normalizeAddress, normalizeBytes32, normalizeUint256 } from "../indexer/model";
import {
  assessIndexerFreshness,
  MARKET_INDEXER_MAX_BLOCK_LAG,
  MARKET_INDEXER_MAX_CLOCK_SKEW_MS,
  MARKET_INDEXER_STALE_AFTER_MS,
  MarketInputError,
  readMarketCursorSecret,
} from "../market/read-model";

export const WALLET_POSITION_DEFAULT_LIMIT = 12;
export const WALLET_POSITION_MAX_LIMIT = 20;
const INDEXER_STREAM = "laypipe";
const CURSOR_DOMAIN = "laypipe.wallet.positions.cursor.v1";
const DB_TIMEOUT_MS = 5_000;

export const WALLET_WATERMARK_SQL = `/* wallet:watermark */
SELECT stream, next_block::text, last_processed_block::text,
  last_processed_hash, observed_safe_head::text, observed_at::text,
  last_run_status, updated_at::text
FROM indexer_cursors
WHERE chain_id = $1::bigint AND stream = $2::text`;

export const WALLET_POSITIONS_SQL = `/* wallet:positions */
WITH watermark AS MATERIALIZED (
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
    AND observed_at <= statement_timestamp() + interval '${MARKET_INDEXER_MAX_CLOCK_SKEW_MS / 1_000} seconds'
), wallet_balances AS (
  SELECT token_address, balance
  FROM token_holder_balance_state
  WHERE chain_id = $1::bigint AND holder_address = $2::evm_address
    AND EXISTS (SELECT 1 FROM watermark)
), creator_candidate_pools AS MATERIALIZED (
  SELECT a.details->>'poolId' AS pool_id
  FROM admin_events a
  JOIN launches source_launch
    ON source_launch.chain_id = a.chain_id
    AND source_launch.hook_address = a.contract_address
    AND source_launch.pool_id::text = a.details->>'poolId'
  WHERE a.chain_id = $1::bigint
    AND EXISTS (SELECT 1 FROM watermark)
    AND a.block_number <= (SELECT last_processed_block FROM watermark)
    AND a.event_name = 'CreatorUpdated'
    AND a.details ? 'poolId' AND a.subject_address IS NOT NULL
    AND a.subject_address = $2::evm_address
  ORDER BY a.block_number DESC, a.log_index DESC
), candidate_tokens AS MATERIALIZED (
  SELECT b.token_address
  FROM wallet_balances b
  WHERE b.balance <> 0
  UNION
  SELECT l.token_address
  FROM launches l
  CROSS JOIN watermark
  WHERE l.chain_id = $1::bigint
    AND l.creator_address = $2::evm_address
    AND l.block_number <= watermark.last_processed_block
  UNION
  SELECT l.token_address
  FROM launches l
  JOIN creator_candidate_pools p ON p.pool_id = l.pool_id::text
  CROSS JOIN watermark
  WHERE l.chain_id = $1::bigint
    AND l.block_number <= watermark.last_processed_block
), candidates AS MATERIALIZED (
  SELECT l.*,
    CASE
      WHEN l.fee_mode = 'creator' THEN COALESCE(u.creator_address, l.creator_address)
      ELSE l.creator_address
    END AS current_creator,
    COALESCE(b.balance, 0) AS wallet_balance
  FROM candidate_tokens candidate
  JOIN launches l
    ON l.chain_id = $1::bigint AND l.token_address = candidate.token_address
  CROSS JOIN watermark
  LEFT JOIN wallet_balances b ON b.token_address = l.token_address
  LEFT JOIN LATERAL (
    SELECT a.subject_address AS creator_address
    FROM admin_events a
    WHERE a.chain_id = l.chain_id
      AND a.event_name = 'CreatorUpdated'
      AND a.details ? 'poolId'
      AND a.subject_address IS NOT NULL
      AND a.details->>'poolId' = l.pool_id::text
      AND a.contract_address = l.hook_address
      AND a.block_number <= watermark.last_processed_block
    ORDER BY a.block_number DESC, a.log_index DESC
    LIMIT 1
  ) u ON true
  WHERE l.block_number <= watermark.last_processed_block
    AND (
      COALESCE(b.balance, 0) <> 0 OR l.creator_address = $2::evm_address
      OR CASE
        WHEN l.fee_mode = 'creator' THEN COALESCE(u.creator_address, l.creator_address)
        ELSE l.creator_address
      END = $2::evm_address
    )
    AND (
      $3::bigint IS NULL OR (l.block_number, l.log_index, l.token_address)
        < ($3::bigint, $4::integer, $5::evm_address)
    )
  ORDER BY l.block_number DESC, l.log_index DESC, l.token_address DESC
  LIMIT $6::integer
), claimed AS (
  SELECT f.pool_id, COALESCE(sum(f.amount), 0) AS amount
  FROM fee_events f
  JOIN candidates c ON c.pool_id = f.pool_id AND c.chain_id = f.chain_id
  CROSS JOIN watermark
  WHERE f.fee_kind = 'creator-claimed'
    AND f.recipient_address = $2::evm_address
    AND f.block_number <= watermark.last_processed_block
  GROUP BY f.pool_id
), burned AS (
  SELECT b.pool_id, COALESCE(sum(b.tokens_burned), 0) AS amount
  FROM burn_events b
  JOIN candidates c ON c.pool_id = b.pool_id AND c.chain_id = b.chain_id
  CROSS JOIN watermark
  WHERE b.block_number <= watermark.last_processed_block
  GROUP BY b.pool_id
)
SELECT c.token_address, c.pool_id, c.name, c.symbol, c.logo_uri,
  approved_artwork.image_cid AS approved_logo_cid, c.fee_mode,
  c.launched_at::text, c.block_number::text, c.log_index,
  c.creator_address, c.current_creator, c.wallet_balance::text,
  (c.creator_address = $2::evm_address) AS launched_by_wallet,
  COALESCE(claimed.amount, 0)::text AS claimed_pipedog,
  COALESCE(burned.amount, 0)::text AS burned_tokens
FROM candidates c
LEFT JOIN LATERAL (
  SELECT promotion.image_cid
  FROM ipfs_promotions promotion
  WHERE promotion.status = 'completed'
    AND promotion.image_cid = substring(c.logo_uri FROM 8)
    AND promotion.metadata_cid = substring(c.metadata_uri FROM 8)
    AND c.logo_uri = 'ipfs://' || promotion.image_cid
    AND c.metadata_uri = 'ipfs://' || promotion.metadata_cid
  LIMIT 1
) approved_artwork ON true
LEFT JOIN claimed ON claimed.pool_id = c.pool_id
LEFT JOIN burned ON burned.pool_id = c.pool_id
ORDER BY c.block_number DESC, c.log_index DESC, c.token_address DESC`;

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

interface PositionRow extends DbRow {
  token_address: unknown;
  pool_id: unknown;
  name: unknown;
  symbol: unknown;
  logo_uri: unknown;
  approved_logo_cid: unknown;
  fee_mode: unknown;
  launched_at: unknown;
  block_number: unknown;
  log_index: unknown;
  creator_address: unknown;
  current_creator: unknown;
  wallet_balance: unknown;
  launched_by_wallet: unknown;
  claimed_pipedog: unknown;
  burned_tokens: unknown;
}

interface WalletCursor {
  wallet: Address;
  blockNumber: string;
  logIndex: number;
  tokenAddress: Address;
}

export interface WalletPortfolioOptions {
  wallet: Address;
  limit: number;
  cursor: WalletCursor | null;
}

export interface WalletReadDependencies {
  now?: () => number;
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

function postgresInteger(value: unknown, label: string) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function mapWatermark(row: WatermarkRow): IndexerWatermark {
  const status = row.last_run_status;
  if (status !== "caught-up" && status !== "bounded" && status !== "deadline") {
    throw new Error("Indexer observation status is invalid.");
  }
  return {
    stream: text(row.stream, "Indexer stream"),
    nextBlock: normalizeUint256(text(row.next_block, "Indexer next block")),
    lastProcessedBlock: normalizeUint256(
      text(row.last_processed_block, "Indexer last block"),
    ),
    lastProcessedHash: normalizeBytes32(
      text(row.last_processed_hash, "Indexer last hash"),
    ),
    observedSafeHead: normalizeUint256(
      text(row.observed_safe_head, "Indexer safe head"),
    ),
    observedAt: timestamp(row.observed_at, "Indexer observation time"),
    lastRunStatus: status,
    updatedAt: timestamp(row.updated_at, "Indexer update time"),
  };
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

function mapPosition(row: PositionRow): Omit<WalletTokenPosition, "isCurrentCreator" | "claimablePipedog"> & {
  blockNumber: string;
  logIndex: number;
} {
  const feeMode = text(row.fee_mode, "Fee mode");
  if (feeMode !== "creator" && feeMode !== "self-burn") {
    throw new Error("Fee mode is invalid.");
  }
  if (typeof row.launched_by_wallet !== "boolean") {
    throw new Error("Creator flag is invalid.");
  }
  return {
    tokenAddress: normalizeAddress(text(row.token_address, "Token address")),
    poolId: normalizeBytes32(text(row.pool_id, "Pool id")),
    name: nullableText(row.name, "Token name"),
    symbol: nullableText(row.symbol, "Token symbol"),
    logoGatewayUrl: approvedLogoGatewayUrl(row.approved_logo_cid),
    feeMode,
    launchedAt: timestamp(row.launched_at, "Launch time"),
    balance: normalizeUint256(text(row.wallet_balance, "Wallet balance")),
    originalCreator: normalizeAddress(text(row.creator_address, "Original creator")),
    currentCreator: normalizeAddress(text(row.current_creator, "Current creator")),
    launchedByWallet: row.launched_by_wallet,
    lifetimeCreatorClaimedPipedog: normalizeUint256(
      text(row.claimed_pipedog, "Claimed PIPEDOG"),
    ),
    lifetimeSelfBurnedTokens: normalizeUint256(
      text(row.burned_tokens, "Burned tokens"),
    ),
    blockNumber: normalizeUint256(text(row.block_number, "Launch block")),
    logIndex: postgresInteger(row.log_index, "Launch log index"),
  };
}

function cursorSignature(payload: string, secret: string) {
  return createHmac("sha256", secret)
    .update(CURSOR_DOMAIN, "utf8")
    .update("\0", "utf8")
    .update(payload, "utf8")
    .digest();
}

export function encodeWalletCursor(cursor: WalletCursor, secret = readMarketCursorSecret()) {
  const payload = Buffer.from(
    JSON.stringify({
      v: 1,
      w: normalizeAddress(cursor.wallet),
      b: normalizeUint256(cursor.blockNumber),
      l: postgresInteger(cursor.logIndex, "Cursor log index"),
      a: normalizeAddress(cursor.tokenAddress),
    }),
    "utf8",
  ).toString("base64url");
  return Buffer.from(
    JSON.stringify({ p: payload, s: cursorSignature(payload, secret).toString("base64url") }),
    "utf8",
  ).toString("base64url");
}

export function decodeWalletCursor(
  value: string,
  wallet: Address,
  secret = readMarketCursorSecret(),
): WalletCursor {
  if (!/^[A-Za-z0-9_-]{1,768}$/.test(value)) throw new MarketInputError("cursor is malformed.");
  try {
    const envelopeBytes = Buffer.from(value, "base64url");
    if (envelopeBytes.toString("base64url") !== value) throw new Error("encoding");
    const envelope = JSON.parse(envelopeBytes.toString("utf8")) as { p?: unknown; s?: unknown };
    if (typeof envelope.p !== "string" || typeof envelope.s !== "string") throw new Error("shape");
    const supplied = Buffer.from(envelope.s, "base64url");
    const expected = cursorSignature(envelope.p, secret);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      throw new Error("signature");
    }
    const payloadBytes = Buffer.from(envelope.p, "base64url");
    if (payloadBytes.toString("base64url") !== envelope.p) throw new Error("payload");
    const parsed = JSON.parse(payloadBytes.toString("utf8")) as Record<string, unknown>;
    const cursorWallet = normalizeAddress(text(parsed.w, "Cursor wallet"));
    if (parsed.v !== 1 || cursorWallet !== wallet) throw new Error("wallet");
    return {
      wallet: cursorWallet,
      blockNumber: normalizeUint256(text(parsed.b, "Cursor block")),
      logIndex: postgresInteger(parsed.l, "Cursor log index"),
      tokenAddress: normalizeAddress(text(parsed.a, "Cursor token")),
    };
  } catch {
    throw new MarketInputError("cursor is malformed or belongs to another wallet.");
  }
}

export function parseWalletPortfolioRequest(
  value: unknown,
  secret = readMarketCursorSecret(),
): WalletPortfolioOptions {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new MarketInputError("Request body must be a JSON object.");
  }
  const body = value as Record<string, unknown>;
  const allowed = new Set(["wallet", "limit", "cursor"]);
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) throw new MarketInputError(`Unsupported request field: ${key}`);
  }
  let wallet: Address;
  try {
    wallet = normalizeAddress(typeof body.wallet === "string" ? body.wallet : "", "Wallet");
  } catch {
    throw new MarketInputError("wallet must be a valid EVM address.");
  }
  const rawLimit = body.limit;
  const limit = rawLimit === undefined ? WALLET_POSITION_DEFAULT_LIMIT : rawLimit;
  if (typeof limit !== "number" || !Number.isInteger(limit)) {
    throw new MarketInputError("limit must be an integer.");
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > WALLET_POSITION_MAX_LIMIT) {
    throw new MarketInputError(`limit must be between 1 and ${WALLET_POSITION_MAX_LIMIT}.`);
  }
  const rawCursor = body.cursor;
  if (rawCursor !== undefined && rawCursor !== null && typeof rawCursor !== "string") {
    throw new MarketInputError("cursor must be a string.");
  }
  return {
    wallet,
    limit,
    cursor: rawCursor ? decodeWalletCursor(rawCursor, wallet, secret) : null,
  };
}

export async function loadWalletPortfolio(
  database: DbClient,
  request: WalletPortfolioOptions,
  cursorSecret = readMarketCursorSecret(),
  dependencies: WalletReadDependencies = {},
): Promise<WalletPortfolioResponse> {
  const precheckRows = await database.query<WatermarkRow>(
    WALLET_WATERMARK_SQL,
    [LAYPIPE_CHAIN_ID, INDEXER_STREAM],
    databaseFetchOptions(DB_TIMEOUT_MS),
  );
  if (precheckRows.length !== 1) {
    throw new Error("Indexer watermark is unavailable.");
  }
  if (
    assessIndexerFreshness(
      mapWatermark(precheckRows[0]),
      (dependencies.now ?? Date.now)(),
    ).status !== "fresh"
  ) {
    throw new Error("Wallet read model is stale.");
  }

  const [watermarkRows, positionRows] = await database.transaction(
    (transaction) => [
      transaction.query<WatermarkRow>(
        WALLET_WATERMARK_SQL,
        [LAYPIPE_CHAIN_ID, INDEXER_STREAM],
        databaseFetchOptions(DB_TIMEOUT_MS),
      ),
      transaction.query<PositionRow>(
        WALLET_POSITIONS_SQL,
        [
          LAYPIPE_CHAIN_ID,
          request.wallet,
          request.cursor?.blockNumber ?? null,
          request.cursor?.logIndex ?? null,
          request.cursor?.tokenAddress ?? null,
          request.limit + 1,
        ],
        databaseFetchOptions(DB_TIMEOUT_MS),
      ),
    ] as const,
    {
      isolationLevel: "RepeatableRead",
      readOnly: true,
      deferrable: true,
      fetchOptions: { signal: AbortSignal.timeout(DB_TIMEOUT_MS) },
    },
  );
  if (watermarkRows.length !== 1) throw new Error("Indexer watermark is unavailable.");
  const indexer = mapWatermark(watermarkRows[0]);
  if (assessIndexerFreshness(indexer, (dependencies.now ?? Date.now)()).status !== "fresh") {
    throw new Error("Wallet read model is stale.");
  }
  const visibleRows = positionRows.slice(0, request.limit);
  const positions = visibleRows.map(mapPosition);
  const onchainUnavailable =
    "Connect a wallet to verify current creator rewards against the audited hook.";
  const hydrated: WalletTokenPosition[] = positions.map((position) => {
    return {
      tokenAddress: position.tokenAddress,
      poolId: position.poolId,
      name: position.name,
      symbol: position.symbol,
      logoGatewayUrl: position.logoGatewayUrl,
      feeMode: position.feeMode,
      launchedAt: position.launchedAt,
      balance: position.balance,
      originalCreator: position.originalCreator,
      currentCreator: position.currentCreator,
      launchedByWallet: position.launchedByWallet,
      isCurrentCreator:
        position.currentCreator.toLowerCase() === request.wallet.toLowerCase(),
      lifetimeCreatorClaimedPipedog: position.lifetimeCreatorClaimedPipedog,
      lifetimeSelfBurnedTokens: position.lifetimeSelfBurnedTokens,
      claimablePipedog: {
        status: "unavailable",
        value: null,
        reason: onchainUnavailable,
      },
    };
  });
  const last = visibleRows.at(-1);
  return {
    source: "live",
    chainId: LAYPIPE_CHAIN_ID,
    wallet: request.wallet,
    asOfBlock: indexer.lastProcessedBlock!,
    onchainClaims: { status: "unavailable", reason: onchainUnavailable },
    positions: hydrated,
    page: {
      limit: request.limit,
      nextCursor:
        positionRows.length > request.limit && last
          ? encodeWalletCursor(
              {
                wallet: request.wallet,
                blockNumber: normalizeUint256(text(last.block_number, "Launch block")),
                logIndex: postgresInteger(last.log_index, "Launch log index"),
                tokenAddress: normalizeAddress(text(last.token_address, "Token address")),
              },
              cursorSecret,
            )
          : null,
    },
    indexer,
  };
}
