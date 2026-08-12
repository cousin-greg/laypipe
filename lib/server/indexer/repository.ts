import {
  DATABASE_READ_TIMEOUT_MS,
  DATABASE_WRITE_TIMEOUT_MS,
  databaseFetchOptions,
  getDatabase,
  type DbClient,
  type DbParameter,
  type DbQueryPromise,
  type DbRow,
  type DbTransactionQuery,
} from "../db/neon";
import {
  jsonSafe,
  normalizeAddress,
  normalizeBytes32,
  normalizeCanonicalBatch,
  normalizeSignedInteger,
  normalizeUint256,
  type AdminProjection,
  type BurnProjection,
  type CanonicalBatchInput,
  type EventSource,
  type FeeProjection,
  type IndexerProjection,
  type LaunchProjection,
  type RevenueProjection,
  type SwapProjection,
  type TransferProjection,
} from "./model";

const BLOCKS_UPSERT = `
WITH incoming AS (
  SELECT * FROM jsonb_to_recordset($1::jsonb) AS row(
    block_number text,
    block_hash text,
    parent_hash text,
    block_timestamp text
  )
)
INSERT INTO chain_blocks (
  chain_id, block_number, block_hash, parent_hash, block_timestamp
)
SELECT $2::bigint, block_number::bigint, block_hash, parent_hash,
       block_timestamp::timestamptz
FROM incoming
ON CONFLICT (chain_id, block_number) DO UPDATE SET
  block_hash = EXCLUDED.block_hash,
  parent_hash = EXCLUDED.parent_hash,
  block_timestamp = EXCLUDED.block_timestamp`;

const EVENTS_UPSERT = `
WITH incoming AS (
  SELECT * FROM jsonb_to_recordset($1::jsonb) AS row(
    block_number text,
    transaction_hash text,
    transaction_index integer,
    log_index integer,
    contract_address text,
    topic0 text,
    topics jsonb,
    data text,
    event_name text,
    decoded_args jsonb
  )
)
INSERT INTO chain_events (
  chain_id, block_number, transaction_hash, transaction_index, log_index,
  contract_address, topic0, topics, data, event_name, decoded_args
)
SELECT $2::bigint, block_number::bigint, transaction_hash, transaction_index,
       log_index, contract_address, topic0, topics, data, event_name, decoded_args
FROM incoming
ON CONFLICT (chain_id, transaction_hash, log_index) DO UPDATE SET
  block_number = EXCLUDED.block_number,
  transaction_index = EXCLUDED.transaction_index,
  contract_address = EXCLUDED.contract_address,
  topic0 = EXCLUDED.topic0,
  topics = EXCLUDED.topics,
  data = EXCLUDED.data,
  event_name = EXCLUDED.event_name,
  decoded_args = EXCLUDED.decoded_args`;

const LAUNCHES_UPSERT = `
WITH incoming AS (
  SELECT * FROM jsonb_to_recordset($1::jsonb) AS row(
    transaction_hash text, log_index integer, token_address text, pool_id text,
    creator_address text, config_id text, first_buy_in text, first_buy_out text,
    hook_address text, fee_recipient_address text, fee_mode text, name text,
    symbol text, description text, logo_uri text, metadata_uri text, socials jsonb
  )
)
INSERT INTO launches (
  chain_id, token_address, pool_id, creator_address, config_id, first_buy_in,
  first_buy_out, hook_address, fee_recipient_address, fee_mode, name, symbol,
  description, logo_uri, metadata_uri, socials, block_number, launched_at,
  transaction_hash, log_index
)
SELECT $2::bigint, i.token_address, i.pool_id, i.creator_address,
       i.config_id::numeric, i.first_buy_in::numeric, i.first_buy_out::numeric,
       i.hook_address, i.fee_recipient_address, i.fee_mode, i.name, i.symbol,
       i.description, i.logo_uri, i.metadata_uri, i.socials, e.block_number,
       b.block_timestamp, i.transaction_hash, i.log_index
FROM incoming i
JOIN chain_events e ON e.chain_id = $2::bigint
  AND e.transaction_hash = i.transaction_hash AND e.log_index = i.log_index
JOIN chain_blocks b ON b.chain_id = e.chain_id AND b.block_number = e.block_number
ON CONFLICT (chain_id, transaction_hash, log_index) DO UPDATE SET
  token_address = EXCLUDED.token_address, pool_id = EXCLUDED.pool_id,
  creator_address = EXCLUDED.creator_address, config_id = EXCLUDED.config_id,
  first_buy_in = EXCLUDED.first_buy_in, first_buy_out = EXCLUDED.first_buy_out,
  hook_address = EXCLUDED.hook_address,
  fee_recipient_address = EXCLUDED.fee_recipient_address,
  fee_mode = EXCLUDED.fee_mode, name = EXCLUDED.name, symbol = EXCLUDED.symbol,
  description = EXCLUDED.description, logo_uri = EXCLUDED.logo_uri,
  metadata_uri = EXCLUDED.metadata_uri, socials = EXCLUDED.socials,
  block_number = EXCLUDED.block_number, launched_at = EXCLUDED.launched_at`;

const SWAPS_UPSERT = `
WITH incoming AS (
  SELECT * FROM jsonb_to_recordset($1::jsonb) AS row(
    transaction_hash text, log_index integer, pool_id text, sender_address text,
    side text, amount0 text, amount1 text, sqrt_price_x96 text, liquidity text,
    tick integer, fee_pips integer, pipedog_amount text, token_amount text
  )
)
INSERT INTO swaps (
  chain_id, pool_id, sender_address, side, amount0, amount1, sqrt_price_x96,
  liquidity, tick, fee_pips, pipedog_amount, token_amount, block_number,
  block_timestamp, transaction_hash, log_index
)
SELECT $2::bigint, i.pool_id, i.sender_address, i.side, i.amount0::numeric,
       i.amount1::numeric, i.sqrt_price_x96::numeric, i.liquidity::numeric,
       i.tick, i.fee_pips, i.pipedog_amount::numeric, i.token_amount::numeric,
       e.block_number, b.block_timestamp, i.transaction_hash, i.log_index
FROM incoming i
JOIN chain_events e ON e.chain_id = $2::bigint
  AND e.transaction_hash = i.transaction_hash AND e.log_index = i.log_index
JOIN chain_blocks b ON b.chain_id = e.chain_id AND b.block_number = e.block_number
ON CONFLICT (chain_id, transaction_hash, log_index) DO UPDATE SET
  pool_id = EXCLUDED.pool_id, sender_address = EXCLUDED.sender_address,
  side = EXCLUDED.side, amount0 = EXCLUDED.amount0, amount1 = EXCLUDED.amount1,
  sqrt_price_x96 = EXCLUDED.sqrt_price_x96, liquidity = EXCLUDED.liquidity,
  tick = EXCLUDED.tick, fee_pips = EXCLUDED.fee_pips,
  pipedog_amount = EXCLUDED.pipedog_amount, token_amount = EXCLUDED.token_amount,
  block_number = EXCLUDED.block_number, block_timestamp = EXCLUDED.block_timestamp`;

const FEES_UPSERT = `
WITH incoming AS (
  SELECT * FROM jsonb_to_recordset($1::jsonb) AS row(
    transaction_hash text, log_index integer, fee_kind text, pool_id text,
    actor_address text, creator_address text, recipient_address text, amount text,
    creator_amount text, platform_amount text
  )
)
INSERT INTO fee_events (
  chain_id, fee_kind, pool_id, actor_address, creator_address,
  recipient_address, amount, creator_amount, platform_amount, block_number, block_timestamp,
  transaction_hash, log_index
)
SELECT $2::bigint, i.fee_kind, i.pool_id, i.actor_address, i.creator_address,
       i.recipient_address, i.amount::numeric, i.creator_amount::numeric, i.platform_amount::numeric,
       e.block_number, b.block_timestamp, i.transaction_hash, i.log_index
FROM incoming i
JOIN chain_events e ON e.chain_id = $2::bigint
  AND e.transaction_hash = i.transaction_hash AND e.log_index = i.log_index
JOIN chain_blocks b ON b.chain_id = e.chain_id AND b.block_number = e.block_number
ON CONFLICT (chain_id, transaction_hash, log_index) DO UPDATE SET
  fee_kind = EXCLUDED.fee_kind, pool_id = EXCLUDED.pool_id,
  actor_address = EXCLUDED.actor_address, creator_address = EXCLUDED.creator_address,
  recipient_address = EXCLUDED.recipient_address, amount = EXCLUDED.amount,
  creator_amount = EXCLUDED.creator_amount,
  platform_amount = EXCLUDED.platform_amount, block_number = EXCLUDED.block_number,
  block_timestamp = EXCLUDED.block_timestamp`;

const BURNS_UPSERT = `
WITH incoming AS (
  SELECT * FROM jsonb_to_recordset($1::jsonb) AS row(
    transaction_hash text, log_index integer, pool_id text, token_address text,
    pipedog_in text, tokens_burned text, pipedog_bounty text
  )
)
INSERT INTO burn_events (
  chain_id, pool_id, token_address, pipedog_in, tokens_burned, pipedog_bounty,
  block_number, block_timestamp, transaction_hash, log_index
)
SELECT $2::bigint, i.pool_id, i.token_address, i.pipedog_in::numeric,
       i.tokens_burned::numeric, i.pipedog_bounty::numeric, e.block_number,
       b.block_timestamp, i.transaction_hash, i.log_index
FROM incoming i
JOIN chain_events e ON e.chain_id = $2::bigint
  AND e.transaction_hash = i.transaction_hash AND e.log_index = i.log_index
JOIN chain_blocks b ON b.chain_id = e.chain_id AND b.block_number = e.block_number
ON CONFLICT (chain_id, transaction_hash, log_index) DO UPDATE SET
  pool_id = EXCLUDED.pool_id, token_address = EXCLUDED.token_address,
  pipedog_in = EXCLUDED.pipedog_in, tokens_burned = EXCLUDED.tokens_burned,
  pipedog_bounty = EXCLUDED.pipedog_bounty, block_number = EXCLUDED.block_number,
  block_timestamp = EXCLUDED.block_timestamp`;

const REVENUE_UPSERT = `
WITH incoming AS (
  SELECT * FROM jsonb_to_recordset($1::jsonb) AS row(
    transaction_hash text, log_index integer, route_kind text,
    caller_address text, recipient_address text, amount text, bounty text,
    sequester_amount text, treasury_amount text, operations_amount text
  )
)
INSERT INTO revenue_events (
  chain_id, route_kind, caller_address, recipient_address, amount, bounty,
  sequester_amount, treasury_amount, operations_amount, block_number,
  block_timestamp, transaction_hash, log_index
)
SELECT $2::bigint, i.route_kind, i.caller_address, i.recipient_address,
       i.amount::numeric, i.bounty::numeric, i.sequester_amount::numeric,
       i.treasury_amount::numeric, i.operations_amount::numeric, e.block_number,
       b.block_timestamp, i.transaction_hash, i.log_index
FROM incoming i
JOIN chain_events e ON e.chain_id = $2::bigint
  AND e.transaction_hash = i.transaction_hash AND e.log_index = i.log_index
JOIN chain_blocks b ON b.chain_id = e.chain_id AND b.block_number = e.block_number
ON CONFLICT (chain_id, transaction_hash, log_index) DO UPDATE SET
  route_kind = EXCLUDED.route_kind, caller_address = EXCLUDED.caller_address,
  recipient_address = EXCLUDED.recipient_address, amount = EXCLUDED.amount,
  bounty = EXCLUDED.bounty, sequester_amount = EXCLUDED.sequester_amount,
  treasury_amount = EXCLUDED.treasury_amount,
  operations_amount = EXCLUDED.operations_amount,
  block_number = EXCLUDED.block_number, block_timestamp = EXCLUDED.block_timestamp`;

const TRANSFERS_UPSERT = `
WITH incoming AS (
  SELECT * FROM jsonb_to_recordset($1::jsonb) AS row(
    transaction_hash text, log_index integer, token_address text,
    from_address text, to_address text, amount text
  )
)
INSERT INTO token_transfers (
  chain_id, token_address, from_address, to_address, amount, block_number,
  block_timestamp, transaction_hash, log_index
)
SELECT $2::bigint, i.token_address, i.from_address, i.to_address,
       i.amount::numeric, e.block_number, b.block_timestamp,
       i.transaction_hash, i.log_index
FROM incoming i
JOIN chain_events e ON e.chain_id = $2::bigint
  AND e.transaction_hash = i.transaction_hash AND e.log_index = i.log_index
JOIN chain_blocks b ON b.chain_id = e.chain_id AND b.block_number = e.block_number
ON CONFLICT (chain_id, transaction_hash, log_index) DO UPDATE SET
  token_address = EXCLUDED.token_address, from_address = EXCLUDED.from_address,
  to_address = EXCLUDED.to_address, amount = EXCLUDED.amount,
  block_number = EXCLUDED.block_number, block_timestamp = EXCLUDED.block_timestamp`;

const ADMIN_UPSERT = `
WITH incoming AS (
  SELECT * FROM jsonb_to_recordset($1::jsonb) AS row(
    transaction_hash text, log_index integer, contract_address text,
    event_name text, actor_address text, subject_address text, details jsonb
  )
)
INSERT INTO admin_events (
  chain_id, contract_address, event_name, actor_address, subject_address,
  details, block_number, block_timestamp, transaction_hash, log_index
)
SELECT $2::bigint, i.contract_address, i.event_name, i.actor_address,
       i.subject_address, i.details, e.block_number, b.block_timestamp,
       i.transaction_hash, i.log_index
FROM incoming i
JOIN chain_events e ON e.chain_id = $2::bigint
  AND e.transaction_hash = i.transaction_hash AND e.log_index = i.log_index
JOIN chain_blocks b ON b.chain_id = e.chain_id AND b.block_number = e.block_number
ON CONFLICT (chain_id, transaction_hash, log_index) DO UPDATE SET
  contract_address = EXCLUDED.contract_address, event_name = EXCLUDED.event_name,
  actor_address = EXCLUDED.actor_address, subject_address = EXCLUDED.subject_address,
  details = EXCLUDED.details, block_number = EXCLUDED.block_number,
  block_timestamp = EXCLUDED.block_timestamp`;

function source(projection: EventSource) {
  return {
    transaction_hash: normalizeBytes32(projection.transactionHash, "Projection transaction"),
    log_index: integer(projection.logIndex, "Projection log index"),
  };
}

function integer(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value < -2_147_483_648 || value > 2_147_483_647) {
    throw new Error(`${label} is outside the Postgres integer range.`);
  }
  return value;
}

function optionalAddress(value: string | undefined, label: string) {
  return value ? normalizeAddress(value, label) : null;
}

function optionalUint(value: bigint | string | undefined, label: string) {
  return value === undefined ? null : normalizeUint256(value, label);
}

function groupProjections(projections: readonly IndexerProjection[]) {
  return {
    launches: projections.filter((value): value is LaunchProjection => value.kind === "launch"),
    swaps: projections.filter((value): value is SwapProjection => value.kind === "swap"),
    fees: projections.filter((value): value is FeeProjection => value.kind === "fee"),
    burns: projections.filter((value): value is BurnProjection => value.kind === "burn"),
    revenue: projections.filter((value): value is RevenueProjection => value.kind === "revenue"),
    transfers: projections.filter((value): value is TransferProjection => value.kind === "transfer"),
    admin: projections.filter((value): value is AdminProjection => value.kind === "admin"),
  };
}

function projectionStatements(
  transaction: DbTransactionQuery,
  chainId: number,
  projections: readonly IndexerProjection[],
) {
  const grouped = groupProjections(projections);
  const statements: DbQueryPromise[] = [];
  const append = (sql: string, rows: unknown[]) => {
    if (rows.length > 0) statements.push(transaction.query(sql, [JSON.stringify(rows), chainId]));
  };

  append(
    LAUNCHES_UPSERT,
    grouped.launches.map((value) => ({
      ...source(value),
      token_address: normalizeAddress(value.tokenAddress, "Launch token"),
      pool_id: normalizeBytes32(value.poolId, "Launch pool"),
      creator_address: normalizeAddress(value.creatorAddress, "Launch creator"),
      config_id: normalizeUint256(value.configId, "Config ID"),
      first_buy_in: normalizeUint256(value.firstBuyIn, "First buy input"),
      first_buy_out: normalizeUint256(value.firstBuyOut, "First buy output"),
      hook_address: normalizeAddress(value.hookAddress, "Hook"),
      fee_recipient_address: normalizeAddress(value.feeRecipientAddress, "Fee recipient"),
      fee_mode: value.feeMode,
      name: value.name ?? null,
      symbol: value.symbol ?? null,
      description: value.description ?? null,
      logo_uri: value.logoUri ?? null,
      metadata_uri: value.metadataUri ?? null,
      socials: value.socials ? jsonSafe(value.socials) : null,
    })),
  );
  append(
    SWAPS_UPSERT,
    grouped.swaps.map((value) => ({
      ...source(value),
      pool_id: normalizeBytes32(value.poolId, "Swap pool"),
      sender_address: normalizeAddress(value.senderAddress, "Swap sender"),
      side: value.side,
      amount0: normalizeSignedInteger(value.amount0, "Swap amount0"),
      amount1: normalizeSignedInteger(value.amount1, "Swap amount1"),
      sqrt_price_x96: normalizeUint256(value.sqrtPriceX96, "Swap sqrt price"),
      liquidity: normalizeUint256(value.liquidity, "Swap liquidity"),
      tick: integer(value.tick, "Swap tick"),
      fee_pips: integer(value.feePips, "Swap fee"),
      pipedog_amount: normalizeUint256(value.pipedogAmount, "PIPEDOG amount"),
      token_amount: normalizeUint256(value.tokenAmount, "Token amount"),
    })),
  );
  append(
    FEES_UPSERT,
    grouped.fees.map((value) => ({
      ...source(value),
      fee_kind: value.feeKind,
      pool_id: value.poolId ? normalizeBytes32(value.poolId, "Fee pool") : null,
      actor_address: optionalAddress(value.actorAddress, "Fee actor"),
      creator_address: optionalAddress(value.creatorAddress, "Fee creator"),
      recipient_address: optionalAddress(value.recipientAddress, "Fee recipient"),
      amount: optionalUint(value.amount, "Fee amount"),
      creator_amount: optionalUint(value.creatorAmount, "Creator fee amount"),
      platform_amount: optionalUint(value.platformAmount, "Platform fee amount"),
    })),
  );
  append(
    BURNS_UPSERT,
    grouped.burns.map((value) => ({
      ...source(value),
      pool_id: normalizeBytes32(value.poolId, "Burn pool"),
      token_address: normalizeAddress(value.tokenAddress, "Burn token"),
      pipedog_in: normalizeUint256(value.pipedogIn, "Burn PIPEDOG input"),
      tokens_burned: normalizeUint256(value.tokensBurned, "Tokens burned"),
      pipedog_bounty: normalizeUint256(value.pipedogBounty, "Burn bounty"),
    })),
  );
  append(
    REVENUE_UPSERT,
    grouped.revenue.map((value) => ({
      ...source(value),
      route_kind: value.routeKind,
      caller_address: optionalAddress(value.callerAddress, "Revenue caller"),
      recipient_address: optionalAddress(value.recipientAddress, "Revenue recipient"),
      amount: normalizeUint256(value.amount, "Revenue amount"),
      bounty: optionalUint(value.bounty, "Revenue bounty"),
      sequester_amount: optionalUint(value.sequesterAmount, "Sequester amount"),
      treasury_amount: optionalUint(value.treasuryAmount, "Treasury amount"),
      operations_amount: optionalUint(value.operationsAmount, "Operations amount"),
    })),
  );
  append(
    TRANSFERS_UPSERT,
    grouped.transfers.map((value) => ({
      ...source(value),
      token_address: normalizeAddress(value.tokenAddress, "Transfer token"),
      from_address: normalizeAddress(value.fromAddress, "Transfer sender"),
      to_address: normalizeAddress(value.toAddress, "Transfer recipient"),
      amount: normalizeUint256(value.amount, "Transfer amount"),
    })),
  );
  append(
    ADMIN_UPSERT,
    grouped.admin.map((value) => ({
      ...source(value),
      contract_address: normalizeAddress(value.contractAddress, "Admin contract"),
      event_name: value.eventName.trim().slice(0, 128),
      actor_address: optionalAddress(value.actorAddress, "Admin actor"),
      subject_address: optionalAddress(value.subjectAddress, "Admin subject"),
      details: value.details ? jsonSafe(value.details) : null,
    })),
  );
  return statements;
}

export async function initializeIndexerCursor(options: {
  chainId: number;
  stream: string;
  startBlock: bigint | string;
}) {
  const database = await getDatabase();
  await database.query("SELECT laypipe_initialize_cursor($1::bigint, $2::text, $3::bigint)", [
    options.chainId,
    options.stream,
    normalizeUint256(options.startBlock, "Cursor start block"),
  ], databaseFetchOptions(DATABASE_WRITE_TIMEOUT_MS));
}

export async function ingestCanonicalBatch(
  input: CanonicalBatchInput,
  databaseOverride?: DbClient,
) {
  const batch = normalizeCanonicalBatch(input);
  const database = databaseOverride ?? await getDatabase();
  const blockRows = batch.blocks.map((block) => ({
    block_number: block.number,
    block_hash: block.hash,
    parent_hash: block.parentHash,
    block_timestamp: block.timestamp,
  }));
  const eventRows = batch.logs.map((event) => ({
    block_number: event.blockNumber,
    transaction_hash: event.transactionHash,
    transaction_index: event.transactionIndex,
    log_index: event.logIndex,
    contract_address: event.contractAddress,
    topic0: event.topics[0] ?? null,
    topics: event.topics,
    data: event.data,
    event_name: event.eventName,
    decoded_args: event.decodedArgs,
  }));
  const last = batch.blocks.at(-1)!;

  await database.transaction(
    (transaction) => [
      transaction.query(BLOCKS_UPSERT, [JSON.stringify(blockRows), batch.chainId]),
      ...(eventRows.length > 0
        ? [transaction.query(EVENTS_UPSERT, [JSON.stringify(eventRows), batch.chainId])]
        : []),
      ...projectionStatements(transaction, batch.chainId, batch.projections),
      transaction.query(
        "SELECT laypipe_advance_cursor($1::bigint, $2::text, $3::bigint, $4::bigint, $5::evm_bytes32)",
        [batch.chainId, batch.stream, batch.expectedNextBlock, last.number, last.hash],
      ),
    ] as const,
    {
      isolationLevel: "Serializable",
      ...databaseFetchOptions(DATABASE_WRITE_TIMEOUT_MS),
    },
  );

  return {
    chainId: batch.chainId,
    firstBlock: batch.blocks[0]!.number,
    lastBlock: last.number,
    blockCount: batch.blocks.length,
    eventCount: batch.logs.length,
    projectionCount: batch.projections.length,
  };
}

export interface StoredBlockRow extends DbRow {
  block_number: string | number | bigint;
  block_hash: string;
}

export interface IndexedLaunchIdentityRow extends DbRow {
  token_address: string;
  pool_id: string;
  fee_mode: string;
}

/**
 * Loads the complete watched launch set for the bounded RPC filter builder.
 * The extra row makes an oversized watch set fail before any cursor advance;
 * callers can then shard the stream instead of silently dropping pools.
 */
export async function loadIndexedLaunchIdentities(options: {
  chainId: number;
  limit: number;
}) {
  if (
    !Number.isSafeInteger(options.limit) ||
    options.limit < 1 ||
    options.limit > 20_000
  ) {
    throw new Error("Indexed launch identity limit must be between 1 and 20000.");
  }
  const database = await getDatabase();
  const rows = await database.query<IndexedLaunchIdentityRow>(
    `SELECT token_address, pool_id, fee_mode
     FROM launches
     WHERE chain_id = $1::bigint
     ORDER BY block_number ASC, log_index ASC
     LIMIT $2::integer`,
    [options.chainId, options.limit + 1],
    databaseFetchOptions(DATABASE_READ_TIMEOUT_MS),
  );
  if (rows.length > options.limit) {
    throw new Error(
      "Indexed launch watch set exceeds the configured RPC filter bound.",
    );
  }
  return rows.map((row) => {
    if (row.fee_mode !== "creator" && row.fee_mode !== "self-burn") {
      throw new Error("Indexed launch fee mode is invalid.");
    }
    const feeMode: "creator" | "self-burn" = row.fee_mode;
    return {
      tokenAddress: normalizeAddress(row.token_address, "Indexed launch token"),
      poolId: normalizeBytes32(row.pool_id, "Indexed launch pool"),
      feeMode,
    };
  });
}

export async function loadRecentStoredBlocks(options: {
  chainId: number;
  atOrBelow: bigint | string;
  limit?: number;
}) {
  const limit = options.limit ?? 128;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 2_048) {
    throw new Error("Reorg lookback must be between 1 and 2048 blocks.");
  }
  const database = await getDatabase();
  const rows = await database.query<StoredBlockRow>(
    `SELECT block_number::text, block_hash
     FROM chain_blocks
     WHERE chain_id = $1::bigint AND block_number <= $2::bigint
     ORDER BY block_number DESC
     LIMIT $3::integer`,
    [options.chainId, normalizeUint256(options.atOrBelow), limit],
    databaseFetchOptions(DATABASE_READ_TIMEOUT_MS),
  );
  return rows.map((row) => ({
    number: String(row.block_number),
    hash: normalizeBytes32(row.block_hash),
  }));
}

export async function rollbackChainTo(options: {
  chainId: number;
  ancestorBlock: bigint | string;
  ancestorHash: string;
}) {
  const database = await getDatabase();
  const rows = await database.query<{ deleted_blocks: string | number | bigint }>(
    `SELECT laypipe_rollback_chain($1::bigint, $2::bigint, $3::evm_bytes32)::text AS deleted_blocks`,
    [
      options.chainId,
      normalizeUint256(options.ancestorBlock, "Rollback ancestor"),
      normalizeBytes32(options.ancestorHash, "Rollback ancestor hash"),
    ],
    databaseFetchOptions(DATABASE_WRITE_TIMEOUT_MS),
  );
  return BigInt(String(rows[0]?.deleted_blocks ?? "0"));
}

export async function readIndexerHealth(chainId: number, stream: string) {
  const database = await getDatabase();
  const rows = await database.query<DbRow>(
    `SELECT chain_id::text, stream, start_block::text, next_block::text,
            last_processed_block::text, last_processed_hash,
            observed_safe_head::text, observed_at::text, last_run_status,
            updated_at::text
     FROM indexer_cursors
     WHERE chain_id = $1::bigint AND stream = $2::text`,
    [chainId, stream],
    databaseFetchOptions(DATABASE_READ_TIMEOUT_MS),
  );
  return rows[0] ?? null;
}

export async function recordIndexerObservation(options: {
  chainId: number;
  stream: string;
  safeHead: bigint | string;
  status: "caught-up" | "bounded" | "deadline";
  observedAt?: Date;
}, databaseOverride?: DbClient) {
  const database = databaseOverride ?? await getDatabase();
  const observedAt = options.observedAt ?? new Date();
  if (!Number.isFinite(observedAt.getTime())) {
    throw new Error("Indexer observation time is invalid.");
  }
  const rows = await database.query<{ updated: boolean }>(
    `UPDATE indexer_cursors
     SET observed_safe_head = $3::bigint,
         observed_at = $4::timestamptz,
         last_run_status = $5::text
     WHERE chain_id = $1::bigint AND stream = $2::text
       AND (last_processed_block IS NULL OR last_processed_block <= $3::bigint)
       AND (observed_safe_head IS NULL OR observed_safe_head <= $3::bigint)
       AND (observed_at IS NULL OR observed_at <= $4::timestamptz)
     RETURNING true AS updated`,
    [
      options.chainId,
      options.stream,
      normalizeUint256(options.safeHead, "Observed safe head"),
      observedAt.toISOString(),
      options.status,
    ],
    databaseFetchOptions(DATABASE_WRITE_TIMEOUT_MS),
  );
  if (rows.length !== 1) {
    throw new Error("Indexer observation was rejected as missing or non-monotonic.");
  }
}

export type { DbParameter };
