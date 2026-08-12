CREATE DOMAIN evm_address AS text
  CHECK (VALUE ~ '^0x[0-9a-f]{40}$');
--> statement-breakpoint
CREATE DOMAIN evm_bytes32 AS text
  CHECK (VALUE ~ '^0x[0-9a-f]{64}$');
--> statement-breakpoint
CREATE DOMAIN evm_hex_data AS text
  CHECK (VALUE ~ '^0x([0-9a-f]{2})*$');
--> statement-breakpoint
CREATE DOMAIN uint256_numeric AS numeric(78, 0)
  CHECK (VALUE >= 0 AND VALUE <= 115792089237316195423570985008687907853269984665640564039457584007913129639935);
--> statement-breakpoint
CREATE TABLE chain_blocks (
  chain_id bigint NOT NULL CHECK (chain_id > 0),
  block_number bigint NOT NULL CHECK (block_number >= 0),
  block_hash evm_bytes32 NOT NULL,
  parent_hash evm_bytes32 NOT NULL,
  block_timestamp timestamptz NOT NULL,
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chain_id, block_number),
  UNIQUE (chain_id, block_hash)
);
--> statement-breakpoint
CREATE TABLE chain_events (
  chain_id bigint NOT NULL CHECK (chain_id > 0),
  block_number bigint NOT NULL CHECK (block_number >= 0),
  transaction_hash evm_bytes32 NOT NULL,
  transaction_index integer NOT NULL CHECK (transaction_index >= 0),
  log_index integer NOT NULL CHECK (log_index >= 0),
  contract_address evm_address NOT NULL,
  topic0 evm_bytes32,
  topics jsonb NOT NULL CHECK (jsonb_typeof(topics) = 'array'),
  data evm_hex_data NOT NULL,
  event_name text CHECK (event_name IS NULL OR length(event_name) BETWEEN 1 AND 128),
  decoded_args jsonb CHECK (decoded_args IS NULL OR jsonb_typeof(decoded_args) = 'object'),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chain_id, transaction_hash, log_index),
  UNIQUE (chain_id, block_number, log_index),
  FOREIGN KEY (chain_id, block_number)
    REFERENCES chain_blocks (chain_id, block_number) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX chain_events_block_order_idx
  ON chain_events (chain_id, block_number, transaction_index, log_index);
--> statement-breakpoint
CREATE INDEX chain_events_contract_topic_idx
  ON chain_events (chain_id, contract_address, topic0, block_number DESC);
--> statement-breakpoint
CREATE TABLE indexer_cursors (
  chain_id bigint NOT NULL CHECK (chain_id > 0),
  stream text NOT NULL CHECK (stream ~ '^[A-Za-z0-9][A-Za-z0-9:_-]{0,63}$'),
  start_block bigint NOT NULL CHECK (start_block >= 0),
  next_block bigint NOT NULL CHECK (next_block >= start_block),
  last_processed_block bigint,
  last_processed_hash evm_bytes32,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chain_id, stream),
  CHECK (
    (last_processed_block IS NULL AND last_processed_hash IS NULL AND next_block = start_block)
    OR
    (last_processed_block IS NOT NULL AND last_processed_hash IS NOT NULL AND next_block = last_processed_block + 1)
  )
);
--> statement-breakpoint
CREATE TABLE launches (
  chain_id bigint NOT NULL,
  token_address evm_address NOT NULL,
  pool_id evm_bytes32 NOT NULL,
  creator_address evm_address NOT NULL,
  config_id uint256_numeric NOT NULL,
  first_buy_in uint256_numeric NOT NULL,
  first_buy_out uint256_numeric NOT NULL,
  hook_address evm_address NOT NULL,
  fee_recipient_address evm_address NOT NULL,
  fee_mode text NOT NULL CHECK (fee_mode IN ('creator', 'self-burn')),
  name text,
  symbol text,
  description text,
  logo_uri text,
  metadata_uri text,
  socials jsonb CHECK (socials IS NULL OR jsonb_typeof(socials) = 'object'),
  block_number bigint NOT NULL,
  launched_at timestamptz NOT NULL,
  transaction_hash evm_bytes32 NOT NULL,
  log_index integer NOT NULL,
  PRIMARY KEY (chain_id, token_address),
  UNIQUE (chain_id, pool_id),
  UNIQUE (chain_id, transaction_hash, log_index),
  FOREIGN KEY (chain_id, transaction_hash, log_index)
    REFERENCES chain_events (chain_id, transaction_hash, log_index) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX launches_newest_idx ON launches (chain_id, block_number DESC, log_index DESC);
--> statement-breakpoint
CREATE INDEX launches_creator_idx ON launches (chain_id, creator_address, block_number DESC);
--> statement-breakpoint
CREATE TABLE swaps (
  chain_id bigint NOT NULL,
  pool_id evm_bytes32 NOT NULL,
  sender_address evm_address NOT NULL,
  side text NOT NULL CHECK (side IN ('buy', 'sell')),
  amount0 numeric(78, 0) NOT NULL,
  amount1 numeric(78, 0) NOT NULL,
  sqrt_price_x96 uint256_numeric NOT NULL,
  liquidity uint256_numeric NOT NULL,
  tick integer NOT NULL,
  fee_pips integer NOT NULL CHECK (fee_pips BETWEEN 0 AND 1000000),
  pipedog_amount uint256_numeric NOT NULL,
  token_amount uint256_numeric NOT NULL,
  block_number bigint NOT NULL,
  block_timestamp timestamptz NOT NULL,
  transaction_hash evm_bytes32 NOT NULL,
  log_index integer NOT NULL,
  PRIMARY KEY (chain_id, transaction_hash, log_index),
  FOREIGN KEY (chain_id, transaction_hash, log_index)
    REFERENCES chain_events (chain_id, transaction_hash, log_index) ON DELETE CASCADE,
  FOREIGN KEY (chain_id, pool_id)
    REFERENCES launches (chain_id, pool_id) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX swaps_pool_time_idx
  ON swaps (chain_id, pool_id, block_number DESC, log_index DESC);
--> statement-breakpoint
CREATE INDEX swaps_time_idx ON swaps (chain_id, block_timestamp DESC);
--> statement-breakpoint
CREATE TABLE fee_events (
  chain_id bigint NOT NULL,
  fee_kind text NOT NULL CHECK (fee_kind IN ('accrued', 'swept', 'creator-claimed', 'launch-fee')),
  pool_id evm_bytes32,
  actor_address evm_address,
  creator_address evm_address,
  amount uint256_numeric,
  creator_amount uint256_numeric,
  platform_amount uint256_numeric,
  block_number bigint NOT NULL,
  block_timestamp timestamptz NOT NULL,
  transaction_hash evm_bytes32 NOT NULL,
  log_index integer NOT NULL,
  PRIMARY KEY (chain_id, transaction_hash, log_index),
  FOREIGN KEY (chain_id, transaction_hash, log_index)
    REFERENCES chain_events (chain_id, transaction_hash, log_index) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX fee_events_pool_idx
  ON fee_events (chain_id, pool_id, block_number DESC) WHERE pool_id IS NOT NULL;
--> statement-breakpoint
CREATE TABLE burn_events (
  chain_id bigint NOT NULL,
  pool_id evm_bytes32 NOT NULL,
  token_address evm_address NOT NULL,
  pipedog_in uint256_numeric NOT NULL,
  tokens_burned uint256_numeric NOT NULL,
  pipedog_bounty uint256_numeric NOT NULL,
  block_number bigint NOT NULL,
  block_timestamp timestamptz NOT NULL,
  transaction_hash evm_bytes32 NOT NULL,
  log_index integer NOT NULL,
  PRIMARY KEY (chain_id, transaction_hash, log_index),
  FOREIGN KEY (chain_id, transaction_hash, log_index)
    REFERENCES chain_events (chain_id, transaction_hash, log_index) ON DELETE CASCADE,
  FOREIGN KEY (chain_id, pool_id)
    REFERENCES launches (chain_id, pool_id) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX burn_events_pool_idx ON burn_events (chain_id, pool_id, block_number DESC);
--> statement-breakpoint
CREATE TABLE revenue_events (
  chain_id bigint NOT NULL,
  route_kind text NOT NULL CHECK (route_kind IN ('allocated', 'sequestered', 'treasury', 'operations')),
  caller_address evm_address,
  recipient_address evm_address,
  amount uint256_numeric NOT NULL,
  bounty uint256_numeric,
  sequester_amount uint256_numeric,
  treasury_amount uint256_numeric,
  operations_amount uint256_numeric,
  block_number bigint NOT NULL,
  block_timestamp timestamptz NOT NULL,
  transaction_hash evm_bytes32 NOT NULL,
  log_index integer NOT NULL,
  PRIMARY KEY (chain_id, transaction_hash, log_index),
  FOREIGN KEY (chain_id, transaction_hash, log_index)
    REFERENCES chain_events (chain_id, transaction_hash, log_index) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX revenue_events_kind_idx
  ON revenue_events (chain_id, route_kind, block_number DESC);
--> statement-breakpoint
CREATE TABLE token_transfers (
  chain_id bigint NOT NULL,
  token_address evm_address NOT NULL,
  from_address evm_address NOT NULL,
  to_address evm_address NOT NULL,
  amount uint256_numeric NOT NULL,
  block_number bigint NOT NULL,
  block_timestamp timestamptz NOT NULL,
  transaction_hash evm_bytes32 NOT NULL,
  log_index integer NOT NULL,
  PRIMARY KEY (chain_id, transaction_hash, log_index),
  FOREIGN KEY (chain_id, transaction_hash, log_index)
    REFERENCES chain_events (chain_id, transaction_hash, log_index) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX token_transfers_token_time_idx
  ON token_transfers (chain_id, token_address, block_number DESC, log_index DESC);
--> statement-breakpoint
CREATE INDEX token_transfers_from_idx
  ON token_transfers (chain_id, token_address, from_address, block_number DESC);
--> statement-breakpoint
CREATE INDEX token_transfers_to_idx
  ON token_transfers (chain_id, token_address, to_address, block_number DESC);
--> statement-breakpoint
CREATE VIEW token_balances AS
SELECT chain_id, token_address, holder_address, sum(delta)::numeric(78, 0) AS balance
FROM (
  SELECT chain_id, token_address, to_address AS holder_address, amount AS delta
  FROM token_transfers
  WHERE to_address <> '0x0000000000000000000000000000000000000000'
  UNION ALL
  SELECT chain_id, token_address, from_address AS holder_address, -amount AS delta
  FROM token_transfers
  WHERE from_address <> '0x0000000000000000000000000000000000000000'
) changes
GROUP BY chain_id, token_address, holder_address
HAVING sum(delta) <> 0;
--> statement-breakpoint
CREATE TABLE admin_events (
  chain_id bigint NOT NULL,
  contract_address evm_address NOT NULL,
  event_name text NOT NULL CHECK (length(event_name) BETWEEN 1 AND 128),
  actor_address evm_address,
  subject_address evm_address,
  details jsonb CHECK (details IS NULL OR jsonb_typeof(details) = 'object'),
  block_number bigint NOT NULL,
  block_timestamp timestamptz NOT NULL,
  transaction_hash evm_bytes32 NOT NULL,
  log_index integer NOT NULL,
  PRIMARY KEY (chain_id, transaction_hash, log_index),
  FOREIGN KEY (chain_id, transaction_hash, log_index)
    REFERENCES chain_events (chain_id, transaction_hash, log_index) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX admin_events_contract_idx
  ON admin_events (chain_id, contract_address, block_number DESC);
--> statement-breakpoint
CREATE FUNCTION laypipe_reject_changed_immutable_row()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'attempted to mutate immutable indexed row in %', TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'chain_blocks', 'chain_events', 'launches', 'swaps', 'fee_events',
    'burn_events', 'revenue_events', 'token_transfers', 'admin_events'
  ] LOOP
    EXECUTE format(
      'CREATE TRIGGER %I_immutable BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION laypipe_reject_changed_immutable_row()',
      table_name,
      table_name
    );
  END LOOP;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION laypipe_initialize_cursor(
  p_chain_id bigint,
  p_stream text,
  p_start_block bigint
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  existing_start bigint;
BEGIN
  IF p_chain_id <= 0 OR p_start_block < 0 OR p_stream !~ '^[A-Za-z0-9][A-Za-z0-9:_-]{0,63}$' THEN
    RAISE EXCEPTION 'invalid cursor identity';
  END IF;
  INSERT INTO indexer_cursors (chain_id, stream, start_block, next_block)
  VALUES (p_chain_id, p_stream, p_start_block, p_start_block)
  ON CONFLICT (chain_id, stream) DO NOTHING;

  SELECT start_block INTO existing_start
  FROM indexer_cursors
  WHERE chain_id = p_chain_id AND stream = p_stream
  FOR UPDATE;
  IF existing_start IS DISTINCT FROM p_start_block THEN
    RAISE EXCEPTION 'cursor start block mismatch';
  END IF;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION laypipe_advance_cursor(
  p_chain_id bigint,
  p_stream text,
  p_expected_next bigint,
  p_last_block bigint,
  p_last_hash evm_bytes32
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  cursor_row indexer_cursors%ROWTYPE;
  first_parent evm_bytes32;
  actual_last_hash evm_bytes32;
  block_count bigint;
BEGIN
  SELECT * INTO cursor_row
  FROM indexer_cursors
  WHERE chain_id = p_chain_id AND stream = p_stream
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'indexer cursor is not initialized'; END IF;
  IF cursor_row.next_block <> p_expected_next THEN
    RAISE EXCEPTION 'cursor compare-and-swap failed: expected %, actual %', p_expected_next, cursor_row.next_block;
  END IF;
  IF p_last_block < p_expected_next THEN RAISE EXCEPTION 'empty cursor advance'; END IF;

  SELECT count(*), max(block_hash) FILTER (WHERE block_number = p_last_block)
    INTO block_count, actual_last_hash
  FROM chain_blocks
  WHERE chain_id = p_chain_id AND block_number BETWEEN p_expected_next AND p_last_block;
  IF block_count <> p_last_block - p_expected_next + 1 OR actual_last_hash IS DISTINCT FROM p_last_hash THEN
    RAISE EXCEPTION 'cursor advance does not match stored canonical blocks';
  END IF;

  IF cursor_row.last_processed_hash IS NOT NULL THEN
    SELECT parent_hash INTO first_parent
    FROM chain_blocks
    WHERE chain_id = p_chain_id AND block_number = p_expected_next;
    IF first_parent IS DISTINCT FROM cursor_row.last_processed_hash THEN
      RAISE EXCEPTION 'new batch does not extend the cursor parent hash';
    END IF;
  END IF;

  UPDATE indexer_cursors
  SET next_block = p_last_block + 1,
      last_processed_block = p_last_block,
      last_processed_hash = p_last_hash,
      updated_at = now()
  WHERE chain_id = p_chain_id AND stream = p_stream;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION laypipe_rollback_chain(
  p_chain_id bigint,
  p_ancestor_block bigint,
  p_ancestor_hash evm_bytes32
)
RETURNS bigint
LANGUAGE plpgsql
AS $$
DECLARE
  actual_hash evm_bytes32;
  deleted_count bigint;
BEGIN
  SELECT block_hash INTO actual_hash
  FROM chain_blocks
  WHERE chain_id = p_chain_id AND block_number = p_ancestor_block;
  IF actual_hash IS DISTINCT FROM p_ancestor_hash THEN
    RAISE EXCEPTION 'rollback ancestor does not match stored block hash';
  END IF;

  DELETE FROM chain_blocks
  WHERE chain_id = p_chain_id AND block_number > p_ancestor_block;
  GET DIAGNOSTICS deleted_count = ROW_COUNT;

  UPDATE indexer_cursors
  SET next_block = p_ancestor_block + 1,
      last_processed_block = p_ancestor_block,
      last_processed_hash = p_ancestor_hash,
      updated_at = now()
  WHERE chain_id = p_chain_id
    AND last_processed_block > p_ancestor_block
    AND start_block <= p_ancestor_block;

  UPDATE indexer_cursors
  SET next_block = start_block,
      last_processed_block = NULL,
      last_processed_hash = NULL,
      updated_at = now()
  WHERE chain_id = p_chain_id
    AND last_processed_block > p_ancestor_block
    AND start_block > p_ancestor_block;

  RETURN deleted_count;
END;
$$;
