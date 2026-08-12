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
  observed_safe_head bigint CHECK (observed_safe_head IS NULL OR observed_safe_head >= 0),
  observed_at timestamptz,
  last_run_status text CHECK (
    last_run_status IS NULL OR last_run_status IN ('caught-up', 'bounded', 'deadline')
  ),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chain_id, stream),
  CHECK (
    (last_processed_block IS NULL AND last_processed_hash IS NULL AND next_block = start_block)
    OR
    (last_processed_block IS NOT NULL AND last_processed_hash IS NOT NULL AND next_block = last_processed_block + 1)
  ),
  CHECK (
    (observed_safe_head IS NULL AND observed_at IS NULL AND last_run_status IS NULL)
    OR
    (observed_safe_head IS NOT NULL AND observed_at IS NOT NULL AND last_run_status IS NOT NULL)
  )
);
--> statement-breakpoint
CREATE FUNCTION laypipe_enforce_cursor_observation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.observed_safe_head IS NULL
     AND NEW.observed_at IS NULL
     AND NEW.last_run_status IS NULL THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.last_processed_block IS NOT NULL
       AND NEW.observed_safe_head < NEW.last_processed_block THEN
      RAISE EXCEPTION 'observed safe head is behind the indexer cursor';
    END IF;
    RETURN NEW;
  END IF;

  IF ROW(NEW.observed_safe_head, NEW.observed_at, NEW.last_run_status)
     IS DISTINCT FROM
     ROW(OLD.observed_safe_head, OLD.observed_at, OLD.last_run_status) THEN
    IF NEW.last_processed_block IS NOT NULL
       AND NEW.observed_safe_head < NEW.last_processed_block THEN
      RAISE EXCEPTION 'observed safe head is behind the indexer cursor';
    END IF;
    IF OLD.observed_safe_head IS NOT NULL
       AND NEW.observed_safe_head < OLD.observed_safe_head THEN
      RAISE EXCEPTION 'observed safe head regressed';
    END IF;
    IF OLD.observed_at IS NOT NULL AND NEW.observed_at < OLD.observed_at THEN
      RAISE EXCEPTION 'indexer observation time regressed';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER indexer_cursor_observation_guard
BEFORE INSERT OR UPDATE ON indexer_cursors
FOR EACH ROW EXECUTE FUNCTION laypipe_enforce_cursor_observation();
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
CREATE INDEX launches_market_page_idx
  ON launches (chain_id, block_number DESC, log_index DESC, token_address DESC);
--> statement-breakpoint
CREATE INDEX launches_creator_idx
  ON launches (
    chain_id, creator_address, block_number DESC, log_index DESC, token_address DESC
  )
  INCLUDE (pool_id, hook_address);
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
CREATE INDEX swaps_pool_market_metrics_idx
  ON swaps (
    chain_id, pool_id, block_timestamp DESC, block_number DESC, log_index DESC
  )
  INCLUDE (pipedog_amount, token_amount)
  WHERE token_amount > 0;
--> statement-breakpoint
CREATE INDEX swaps_time_idx ON swaps (chain_id, block_timestamp DESC);
--> statement-breakpoint
CREATE TABLE pool_market_totals (
  chain_id bigint NOT NULL,
  pool_id evm_bytes32 NOT NULL,
  total_trades bigint NOT NULL DEFAULT 0 CHECK (total_trades >= 0),
  PRIMARY KEY (chain_id, pool_id),
  FOREIGN KEY (chain_id, pool_id)
    REFERENCES launches (chain_id, pool_id) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE FUNCTION laypipe_adjust_pool_market_totals()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.token_amount > 0 THEN
      INSERT INTO pool_market_totals (chain_id, pool_id, total_trades)
      VALUES (NEW.chain_id, NEW.pool_id, 1)
      ON CONFLICT (chain_id, pool_id) DO UPDATE
      SET total_trades = pool_market_totals.total_trades + 1;
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.token_amount > 0 THEN
    UPDATE pool_market_totals
    SET total_trades = total_trades - 1
    WHERE chain_id = OLD.chain_id AND pool_id = OLD.pool_id;
    DELETE FROM pool_market_totals
    WHERE chain_id = OLD.chain_id AND pool_id = OLD.pool_id AND total_trades = 0;
  END IF;
  RETURN OLD;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER swaps_market_totals_insert
AFTER INSERT ON swaps
FOR EACH ROW EXECUTE FUNCTION laypipe_adjust_pool_market_totals();
--> statement-breakpoint
CREATE TRIGGER swaps_market_totals_delete
AFTER DELETE ON swaps
FOR EACH ROW EXECUTE FUNCTION laypipe_adjust_pool_market_totals();
--> statement-breakpoint
CREATE TABLE fee_events (
  chain_id bigint NOT NULL,
  fee_kind text NOT NULL CHECK (fee_kind IN (
    'accrued', 'swept', 'creator-claimed', 'launch-fee',
    'platform-deferred', 'platform-collected'
  )),
  pool_id evm_bytes32,
  actor_address evm_address,
  creator_address evm_address,
  recipient_address evm_address,
  amount uint256_numeric,
  creator_amount uint256_numeric,
  platform_amount uint256_numeric,
  block_number bigint NOT NULL,
  block_timestamp timestamptz NOT NULL,
  transaction_hash evm_bytes32 NOT NULL,
  log_index integer NOT NULL,
  PRIMARY KEY (chain_id, transaction_hash, log_index),
  FOREIGN KEY (chain_id, transaction_hash, log_index)
    REFERENCES chain_events (chain_id, transaction_hash, log_index) ON DELETE CASCADE,
  FOREIGN KEY (chain_id, pool_id)
    REFERENCES launches (chain_id, pool_id) ON DELETE CASCADE,
  CHECK (
    (fee_kind = 'accrued' AND pool_id IS NOT NULL AND amount IS NOT NULL
      AND actor_address IS NULL AND creator_address IS NULL AND recipient_address IS NULL
      AND creator_amount IS NULL AND platform_amount IS NULL)
    OR
    (fee_kind = 'swept' AND pool_id IS NOT NULL AND actor_address IS NOT NULL
      AND creator_amount IS NOT NULL AND platform_amount IS NOT NULL
      AND creator_address IS NULL AND recipient_address IS NULL AND amount IS NULL)
    OR
    (fee_kind = 'creator-claimed' AND pool_id IS NOT NULL
      AND creator_address IS NOT NULL AND recipient_address = creator_address
      AND amount IS NOT NULL AND actor_address IS NULL
      AND creator_amount IS NULL AND platform_amount IS NULL)
    OR
    (fee_kind = 'launch-fee' AND pool_id IS NULL AND recipient_address IS NOT NULL
      AND amount IS NOT NULL AND actor_address IS NULL AND creator_address IS NULL
      AND creator_amount IS NULL AND platform_amount IS NULL)
    OR
    (fee_kind = 'platform-deferred' AND pool_id IS NULL AND amount IS NOT NULL
      AND actor_address IS NULL AND creator_address IS NULL AND recipient_address IS NULL
      AND creator_amount IS NULL AND platform_amount IS NULL)
    OR
    (fee_kind = 'platform-collected' AND pool_id IS NULL AND recipient_address IS NOT NULL
      AND amount IS NOT NULL AND actor_address IS NULL AND creator_address IS NULL
      AND creator_amount IS NULL AND platform_amount IS NULL)
  )
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
    REFERENCES chain_events (chain_id, transaction_hash, log_index) ON DELETE CASCADE,
  CHECK (
    (route_kind = 'allocated' AND caller_address IS NULL AND recipient_address IS NULL
      AND bounty IS NULL AND sequester_amount IS NOT NULL
      AND treasury_amount IS NOT NULL AND operations_amount IS NOT NULL
      AND amount = sequester_amount + treasury_amount + operations_amount)
    OR
    (route_kind IN ('sequestered', 'treasury') AND caller_address IS NOT NULL
      AND recipient_address IS NOT NULL AND bounty IS NOT NULL
      AND sequester_amount IS NULL AND treasury_amount IS NULL AND operations_amount IS NULL)
    OR
    (route_kind = 'operations' AND caller_address IS NULL
      AND recipient_address IS NOT NULL AND bounty IS NULL
      AND sequester_amount IS NULL AND treasury_amount IS NULL AND operations_amount IS NULL)
  )
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
CREATE TABLE token_holder_balance_state (
  chain_id bigint NOT NULL CHECK (chain_id > 0),
  holder_address evm_address NOT NULL,
  token_address evm_address NOT NULL,
  balance uint256_numeric NOT NULL,
  PRIMARY KEY (chain_id, holder_address, token_address)
);
--> statement-breakpoint
DO $$
BEGIN
  INSERT INTO token_holder_balance_state (
    chain_id, holder_address, token_address, balance
  )
  SELECT chain_id, holder_address, token_address, balance
  FROM token_balances;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION laypipe_apply_inserted_token_transfers()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  LOCK TABLE token_holder_balance_state IN SHARE ROW EXCLUSIVE MODE;

  IF EXISTS (
    WITH deltas AS (
      SELECT chain_id, holder_address, token_address, sum(delta)::numeric(78, 0) AS delta
      FROM (
        SELECT chain_id, to_address AS holder_address, token_address, amount AS delta
        FROM new_token_transfers
        WHERE to_address <> '0x0000000000000000000000000000000000000000'
        UNION ALL
        SELECT chain_id, from_address AS holder_address, token_address, -amount AS delta
        FROM new_token_transfers
        WHERE from_address <> '0x0000000000000000000000000000000000000000'
      ) changes
      GROUP BY chain_id, holder_address, token_address
    )
    SELECT 1
    FROM deltas d
    LEFT JOIN token_holder_balance_state s
      USING (chain_id, holder_address, token_address)
    WHERE COALESCE(s.balance, 0) + d.delta < 0
  ) THEN
    RAISE EXCEPTION 'token transfer would make a holder balance negative';
  END IF;

  WITH deltas AS (
    SELECT chain_id, holder_address, token_address, sum(delta)::numeric(78, 0) AS delta
    FROM (
      SELECT chain_id, to_address AS holder_address, token_address, amount AS delta
      FROM new_token_transfers
      WHERE to_address <> '0x0000000000000000000000000000000000000000'
      UNION ALL
      SELECT chain_id, from_address AS holder_address, token_address, -amount AS delta
      FROM new_token_transfers
      WHERE from_address <> '0x0000000000000000000000000000000000000000'
    ) changes
    GROUP BY chain_id, holder_address, token_address
  )
  UPDATE token_holder_balance_state s
  SET balance = s.balance + d.delta
  FROM deltas d
  WHERE s.chain_id = d.chain_id
    AND s.holder_address = d.holder_address
    AND s.token_address = d.token_address;

  WITH deltas AS (
    SELECT chain_id, holder_address, token_address, sum(delta)::numeric(78, 0) AS delta
    FROM (
      SELECT chain_id, to_address AS holder_address, token_address, amount AS delta
      FROM new_token_transfers
      WHERE to_address <> '0x0000000000000000000000000000000000000000'
      UNION ALL
      SELECT chain_id, from_address AS holder_address, token_address, -amount AS delta
      FROM new_token_transfers
      WHERE from_address <> '0x0000000000000000000000000000000000000000'
    ) changes
    GROUP BY chain_id, holder_address, token_address
  )
  INSERT INTO token_holder_balance_state (
    chain_id, holder_address, token_address, balance
  )
  SELECT d.chain_id, d.holder_address, d.token_address, d.delta
  FROM deltas d
  WHERE d.delta > 0
    AND NOT EXISTS (
      SELECT 1
      FROM token_holder_balance_state s
      WHERE s.chain_id = d.chain_id
        AND s.holder_address = d.holder_address
        AND s.token_address = d.token_address
    );

  DELETE FROM token_holder_balance_state WHERE balance = 0;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER token_transfers_balance_state_insert
AFTER INSERT ON token_transfers
REFERENCING NEW TABLE AS new_token_transfers
FOR EACH STATEMENT EXECUTE FUNCTION laypipe_apply_inserted_token_transfers();
--> statement-breakpoint
CREATE FUNCTION laypipe_apply_deleted_token_transfers()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  LOCK TABLE token_holder_balance_state IN SHARE ROW EXCLUSIVE MODE;

  IF EXISTS (
    WITH deltas AS (
      SELECT chain_id, holder_address, token_address, sum(delta)::numeric(78, 0) AS delta
      FROM (
        SELECT chain_id, to_address AS holder_address, token_address, -amount AS delta
        FROM old_token_transfers
        WHERE to_address <> '0x0000000000000000000000000000000000000000'
        UNION ALL
        SELECT chain_id, from_address AS holder_address, token_address, amount AS delta
        FROM old_token_transfers
        WHERE from_address <> '0x0000000000000000000000000000000000000000'
      ) changes
      GROUP BY chain_id, holder_address, token_address
    )
    SELECT 1
    FROM deltas d
    LEFT JOIN token_holder_balance_state s
      USING (chain_id, holder_address, token_address)
    WHERE COALESCE(s.balance, 0) + d.delta < 0
  ) THEN
    RAISE EXCEPTION 'token transfer rollback would make a holder balance negative';
  END IF;

  WITH deltas AS (
    SELECT chain_id, holder_address, token_address, sum(delta)::numeric(78, 0) AS delta
    FROM (
      SELECT chain_id, to_address AS holder_address, token_address, -amount AS delta
      FROM old_token_transfers
      WHERE to_address <> '0x0000000000000000000000000000000000000000'
      UNION ALL
      SELECT chain_id, from_address AS holder_address, token_address, amount AS delta
      FROM old_token_transfers
      WHERE from_address <> '0x0000000000000000000000000000000000000000'
    ) changes
    GROUP BY chain_id, holder_address, token_address
  )
  UPDATE token_holder_balance_state s
  SET balance = s.balance + d.delta
  FROM deltas d
  WHERE s.chain_id = d.chain_id
    AND s.holder_address = d.holder_address
    AND s.token_address = d.token_address;

  WITH deltas AS (
    SELECT chain_id, holder_address, token_address, sum(delta)::numeric(78, 0) AS delta
    FROM (
      SELECT chain_id, to_address AS holder_address, token_address, -amount AS delta
      FROM old_token_transfers
      WHERE to_address <> '0x0000000000000000000000000000000000000000'
      UNION ALL
      SELECT chain_id, from_address AS holder_address, token_address, amount AS delta
      FROM old_token_transfers
      WHERE from_address <> '0x0000000000000000000000000000000000000000'
    ) changes
    GROUP BY chain_id, holder_address, token_address
  )
  INSERT INTO token_holder_balance_state (
    chain_id, holder_address, token_address, balance
  )
  SELECT d.chain_id, d.holder_address, d.token_address, d.delta
  FROM deltas d
  WHERE d.delta > 0
    AND NOT EXISTS (
      SELECT 1
      FROM token_holder_balance_state s
      WHERE s.chain_id = d.chain_id
        AND s.holder_address = d.holder_address
        AND s.token_address = d.token_address
    );

  DELETE FROM token_holder_balance_state WHERE balance = 0;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER token_transfers_balance_state_delete
AFTER DELETE ON token_transfers
REFERENCING OLD TABLE AS old_token_transfers
FOR EACH STATEMENT EXECUTE FUNCTION laypipe_apply_deleted_token_transfers();
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
CREATE INDEX admin_events_creator_pool_idx
  ON admin_events (
    chain_id, (details->>'poolId'), block_number DESC, log_index DESC
  )
  INCLUDE (subject_address, contract_address)
  WHERE event_name = 'CreatorUpdated'
    AND subject_address IS NOT NULL
    AND details ? 'poolId';
--> statement-breakpoint
CREATE INDEX admin_events_creator_subject_idx
  ON admin_events (
    chain_id, subject_address, block_number DESC, log_index DESC
  )
  INCLUDE (contract_address, details)
  WHERE event_name = 'CreatorUpdated'
    AND subject_address IS NOT NULL
    AND details ? 'poolId';
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
      observed_safe_head = NULL,
      observed_at = NULL,
      last_run_status = NULL,
      updated_at = now()
  WHERE chain_id = p_chain_id
    AND last_processed_block > p_ancestor_block
    AND start_block <= p_ancestor_block;

  UPDATE indexer_cursors
  SET next_block = start_block,
      last_processed_block = NULL,
      last_processed_hash = NULL,
      observed_safe_head = NULL,
      observed_at = NULL,
      last_run_status = NULL,
      updated_at = now()
  WHERE chain_id = p_chain_id
    AND last_processed_block > p_ancestor_block
    AND start_block > p_ancestor_block;

  RETURN deleted_count;
END;
$$;
--> statement-breakpoint
CREATE TABLE ipfs_promotions (
  promotion_id text PRIMARY KEY CHECK (promotion_id ~ '^[0-9a-f]{64}$'),
  stage_file_id uuid NOT NULL,
  pin_digest text NOT NULL CHECK (pin_digest ~ '^[0-9a-f]{64}$'),
  wallet_address evm_address NOT NULL,
  file_sha256 text NOT NULL CHECK (file_sha256 ~ '^[0-9a-f]{64}$'),
  image_cid text NOT NULL CHECK (image_cid ~ '^b[a-z2-7]{45,127}$'),
  metadata_cid text NOT NULL CHECK (metadata_cid ~ '^b[a-z2-7]{45,127}$'),
  image_file_id uuid NOT NULL,
  metadata_file_id uuid NOT NULL,
  image_size integer NOT NULL CHECK (image_size BETWEEN 1 AND 5242880),
  metadata_size integer NOT NULL CHECK (metadata_size BETWEEN 1 AND 65536),
  image_mime_type text NOT NULL CHECK (image_mime_type = 'image/webp'),
  metadata_mime_type text NOT NULL CHECK (metadata_mime_type = 'application/json'),
  status text NOT NULL CHECK (status = 'completed'),
  completed_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TRIGGER ipfs_promotions_immutable
  BEFORE UPDATE ON ipfs_promotions
  FOR EACH ROW
  EXECUTE FUNCTION laypipe_reject_changed_immutable_row();
--> statement-breakpoint
CREATE INDEX ipfs_promotions_completed_cids_idx
  ON ipfs_promotions (image_cid, metadata_cid)
  INCLUDE (promotion_id)
  WHERE status = 'completed';
