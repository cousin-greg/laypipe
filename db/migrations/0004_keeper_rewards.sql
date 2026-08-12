-- Keeper projections intentionally do not accept changed canonical events.
-- The indexer uses ON CONFLICT DO UPDATE for idempotent replay, while the
-- immutable row triggers from 0000 allow identical rows and reject any changed
-- value before an UPDATE could leave these INSERT/DELETE projections stale.
DO $$
DECLARE
  canonical_table text;
BEGIN
  FOREACH canonical_table IN ARRAY ARRAY['fee_events', 'revenue_events'] LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_trigger t
      JOIN pg_catalog.pg_class relation ON relation.oid = t.tgrelid
      JOIN pg_catalog.pg_namespace schema ON schema.oid = relation.relnamespace
      WHERE schema.nspname = 'public'
        AND relation.relname = canonical_table
        AND t.tgname = canonical_table || '_immutable'
        AND t.tgfoid = 'public.laypipe_reject_changed_immutable_row()'::regprocedure
        AND t.tgtype = 19 -- ROW (1) + BEFORE (2) + UPDATE (16)
        AND t.tgenabled IN ('O', 'A')
        AND NOT t.tgisinternal
    ) THEN
      RAISE EXCEPTION
        'keeper projections require enabled immutable UPDATE trigger on %',
        canonical_table;
    END IF;
  END LOOP;
END;
$$;
--> statement-breakpoint
CREATE INDEX revenue_events_caller_bounty_idx
  ON revenue_events (
    chain_id, caller_address, block_number DESC, log_index DESC
  )
  INCLUDE (route_kind, bounty, amount, transaction_hash, block_timestamp)
  WHERE caller_address IS NOT NULL
    AND route_kind IN ('sequestered', 'treasury');
--> statement-breakpoint
CREATE INDEX fee_events_sweeper_idx
  ON fee_events (
    chain_id, actor_address, block_number DESC, log_index DESC
  )
  INCLUDE (
    pool_id, creator_amount, platform_amount, transaction_hash, block_timestamp
  )
  WHERE fee_kind = 'swept' AND actor_address IS NOT NULL;
--> statement-breakpoint
CREATE TABLE keeper_pool_fee_state (
  chain_id bigint NOT NULL CHECK (chain_id > 0),
  pool_id evm_bytes32 NOT NULL,
  token_address evm_address NOT NULL,
  name text,
  symbol text,
  accrued_total numeric NOT NULL CHECK (accrued_total >= 0),
  swept_total numeric NOT NULL CHECK (swept_total >= 0),
  indexed_pending numeric
    GENERATED ALWAYS AS (accrued_total - swept_total) STORED,
  PRIMARY KEY (chain_id, pool_id),
  FOREIGN KEY (chain_id, pool_id)
    REFERENCES launches (chain_id, pool_id) ON DELETE CASCADE,
  CHECK (
    swept_total <= accrued_total
    AND accrued_total - swept_total
      <= 115792089237316195423570985008687907853269984665640564039457584007913129639935
  )
);
--> statement-breakpoint
INSERT INTO keeper_pool_fee_state (
  chain_id, pool_id, token_address, name, symbol, accrued_total, swept_total
)
SELECT fee.chain_id, fee.pool_id, launch.token_address, launch.name, launch.symbol,
  sum(CASE WHEN fee.fee_kind = 'accrued' THEN fee.amount ELSE 0 END),
  sum(CASE WHEN fee.fee_kind = 'swept'
    THEN fee.creator_amount + fee.platform_amount ELSE 0 END)
FROM fee_events fee
JOIN launches launch
  ON launch.chain_id = fee.chain_id AND launch.pool_id = fee.pool_id
WHERE fee.pool_id IS NOT NULL AND fee.fee_kind IN ('accrued', 'swept')
GROUP BY fee.chain_id, fee.pool_id, launch.token_address, launch.name, launch.symbol;
--> statement-breakpoint
CREATE INDEX keeper_pool_fee_state_candidates_idx
  ON keeper_pool_fee_state (chain_id, indexed_pending DESC, pool_id ASC)
  WHERE indexed_pending > 0;
--> statement-breakpoint
CREATE FUNCTION laypipe_apply_inserted_keeper_pool_fees()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  LOCK TABLE public.keeper_pool_fee_state IN SHARE ROW EXCLUSIVE MODE;

  INSERT INTO public.keeper_pool_fee_state (
    chain_id, pool_id, token_address, name, symbol, accrued_total, swept_total
  )
  SELECT fee.chain_id, fee.pool_id, launch.token_address, launch.name, launch.symbol,
    sum(CASE WHEN fee.fee_kind = 'accrued' THEN fee.amount ELSE 0 END),
    sum(CASE WHEN fee.fee_kind = 'swept'
      THEN fee.creator_amount + fee.platform_amount ELSE 0 END)
  FROM new_keeper_fee_events fee
  JOIN public.launches launch
    ON launch.chain_id = fee.chain_id AND launch.pool_id = fee.pool_id
  WHERE fee.pool_id IS NOT NULL AND fee.fee_kind IN ('accrued', 'swept')
  GROUP BY fee.chain_id, fee.pool_id, launch.token_address, launch.name, launch.symbol
  ON CONFLICT (chain_id, pool_id) DO UPDATE
  SET accrued_total = public.keeper_pool_fee_state.accrued_total
        + EXCLUDED.accrued_total,
      swept_total = public.keeper_pool_fee_state.swept_total
        + EXCLUDED.swept_total;

  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER fee_events_keeper_pool_state_insert
AFTER INSERT ON fee_events
REFERENCING NEW TABLE AS new_keeper_fee_events
FOR EACH STATEMENT EXECUTE FUNCTION laypipe_apply_inserted_keeper_pool_fees();
--> statement-breakpoint
CREATE FUNCTION laypipe_apply_deleted_keeper_pool_fees()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  LOCK TABLE public.keeper_pool_fee_state IN SHARE ROW EXCLUSIVE MODE;

  WITH deltas AS (
    SELECT chain_id, pool_id,
      sum(CASE WHEN fee_kind = 'accrued' THEN amount ELSE 0 END) AS accrued,
      sum(CASE WHEN fee_kind = 'swept' THEN creator_amount + platform_amount ELSE 0 END) AS swept
    FROM old_keeper_fee_events
    WHERE pool_id IS NOT NULL AND fee_kind IN ('accrued', 'swept')
    GROUP BY chain_id, pool_id
  )
  UPDATE public.keeper_pool_fee_state state
  SET accrued_total = state.accrued_total - deltas.accrued,
      swept_total = state.swept_total - deltas.swept
  FROM deltas
  WHERE state.chain_id = deltas.chain_id AND state.pool_id = deltas.pool_id;

  DELETE FROM public.keeper_pool_fee_state
  WHERE accrued_total = 0 AND swept_total = 0;

  IF EXISTS (
    WITH affected AS (
      SELECT DISTINCT chain_id, pool_id
      FROM old_keeper_fee_events
      WHERE pool_id IS NOT NULL AND fee_kind IN ('accrued', 'swept')
    ), canonical AS (
      SELECT affected.chain_id, affected.pool_id,
        COALESCE(sum(f.amount) FILTER (WHERE f.fee_kind = 'accrued'), 0) AS accrued,
        COALESCE(sum(f.creator_amount + f.platform_amount)
          FILTER (WHERE f.fee_kind = 'swept'), 0) AS swept
      FROM affected
      JOIN public.launches launch
        ON launch.chain_id = affected.chain_id AND launch.pool_id = affected.pool_id
      LEFT JOIN public.fee_events f
        ON f.chain_id = affected.chain_id AND f.pool_id = affected.pool_id
        AND f.fee_kind IN ('accrued', 'swept')
      GROUP BY affected.chain_id, affected.pool_id
    )
    SELECT 1
    FROM canonical
    LEFT JOIN public.keeper_pool_fee_state state
      USING (chain_id, pool_id)
    WHERE canonical.accrued <> COALESCE(state.accrued_total, 0)
       OR canonical.swept <> COALESCE(state.swept_total, 0)
  ) THEN
    RAISE EXCEPTION 'keeper pool fee state diverged during canonical rollback';
  END IF;

  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER fee_events_keeper_pool_state_delete
AFTER DELETE ON fee_events
REFERENCING OLD TABLE AS old_keeper_fee_events
FOR EACH STATEMENT EXECUTE FUNCTION laypipe_apply_deleted_keeper_pool_fees();
--> statement-breakpoint
REVOKE ALL ON TABLE keeper_pool_fee_state FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION laypipe_apply_inserted_keeper_pool_fees() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION laypipe_apply_deleted_keeper_pool_fees() FROM PUBLIC;
--> statement-breakpoint
CREATE TABLE keeper_caller_accounting (
  chain_id bigint NOT NULL CHECK (chain_id > 0),
  caller_address evm_address NOT NULL,
  sequester_bounty numeric NOT NULL CHECK (sequester_bounty >= 0),
  treasury_bounty numeric NOT NULL CHECK (treasury_bounty >= 0),
  sequester_calls numeric NOT NULL CHECK (sequester_calls >= 0),
  treasury_calls numeric NOT NULL CHECK (treasury_calls >= 0),
  sweep_calls numeric NOT NULL CHECK (sweep_calls >= 0),
  PRIMARY KEY (chain_id, caller_address)
);
--> statement-breakpoint
INSERT INTO keeper_caller_accounting (
  chain_id, caller_address, sequester_bounty, treasury_bounty,
  sequester_calls, treasury_calls, sweep_calls
)
SELECT chain_id, caller_address,
  sum(sequester_bounty), sum(treasury_bounty), sum(sequester_calls),
  sum(treasury_calls), sum(sweep_calls)
FROM (
  SELECT chain_id, caller_address,
    COALESCE(sum(bounty) FILTER (WHERE route_kind = 'sequestered'), 0)
      AS sequester_bounty,
    COALESCE(sum(bounty) FILTER (WHERE route_kind = 'treasury'), 0)
      AS treasury_bounty,
    count(*) FILTER (WHERE route_kind = 'sequestered') AS sequester_calls,
    count(*) FILTER (WHERE route_kind = 'treasury') AS treasury_calls,
    0::numeric AS sweep_calls
  FROM revenue_events
  WHERE caller_address IS NOT NULL
    AND route_kind IN ('sequestered', 'treasury')
  GROUP BY chain_id, caller_address
  UNION ALL
  SELECT chain_id, actor_address, 0, 0, 0, 0, count(*)
  FROM fee_events
  WHERE actor_address IS NOT NULL AND fee_kind = 'swept'
  GROUP BY chain_id, actor_address
) accounting
GROUP BY chain_id, caller_address;
--> statement-breakpoint
CREATE FUNCTION laypipe_apply_inserted_keeper_revenue_accounting()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  LOCK TABLE public.keeper_caller_accounting IN SHARE ROW EXCLUSIVE MODE;

  INSERT INTO public.keeper_caller_accounting (
    chain_id, caller_address, sequester_bounty, treasury_bounty,
    sequester_calls, treasury_calls, sweep_calls
  )
  SELECT chain_id, caller_address,
    COALESCE(sum(bounty) FILTER (WHERE route_kind = 'sequestered'), 0),
    COALESCE(sum(bounty) FILTER (WHERE route_kind = 'treasury'), 0),
    count(*) FILTER (WHERE route_kind = 'sequestered'),
    count(*) FILTER (WHERE route_kind = 'treasury'),
    0
  FROM new_keeper_revenue_events
  WHERE caller_address IS NOT NULL
    AND route_kind IN ('sequestered', 'treasury')
  GROUP BY chain_id, caller_address
  ON CONFLICT (chain_id, caller_address) DO UPDATE
  SET sequester_bounty = public.keeper_caller_accounting.sequester_bounty
        + EXCLUDED.sequester_bounty,
      treasury_bounty = public.keeper_caller_accounting.treasury_bounty
        + EXCLUDED.treasury_bounty,
      sequester_calls = public.keeper_caller_accounting.sequester_calls
        + EXCLUDED.sequester_calls,
      treasury_calls = public.keeper_caller_accounting.treasury_calls
        + EXCLUDED.treasury_calls;

  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER revenue_events_keeper_accounting_insert
AFTER INSERT ON revenue_events
REFERENCING NEW TABLE AS new_keeper_revenue_events
FOR EACH STATEMENT EXECUTE FUNCTION laypipe_apply_inserted_keeper_revenue_accounting();
--> statement-breakpoint
CREATE FUNCTION laypipe_apply_deleted_keeper_revenue_accounting()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  LOCK TABLE public.keeper_caller_accounting IN SHARE ROW EXCLUSIVE MODE;

  WITH deltas AS (
    SELECT chain_id, caller_address,
      COALESCE(sum(bounty) FILTER (WHERE route_kind = 'sequestered'), 0) AS sequester_bounty,
      COALESCE(sum(bounty) FILTER (WHERE route_kind = 'treasury'), 0) AS treasury_bounty,
      count(*) FILTER (WHERE route_kind = 'sequestered') AS sequester_calls,
      count(*) FILTER (WHERE route_kind = 'treasury') AS treasury_calls
    FROM old_keeper_revenue_events
    WHERE caller_address IS NOT NULL
      AND route_kind IN ('sequestered', 'treasury')
    GROUP BY chain_id, caller_address
  )
  UPDATE public.keeper_caller_accounting state
  SET sequester_bounty = state.sequester_bounty - deltas.sequester_bounty,
      treasury_bounty = state.treasury_bounty - deltas.treasury_bounty,
      sequester_calls = state.sequester_calls - deltas.sequester_calls,
      treasury_calls = state.treasury_calls - deltas.treasury_calls
  FROM deltas
  WHERE state.chain_id = deltas.chain_id
    AND state.caller_address = deltas.caller_address;

  DELETE FROM public.keeper_caller_accounting
  WHERE sequester_bounty = 0 AND treasury_bounty = 0
    AND sequester_calls = 0 AND treasury_calls = 0 AND sweep_calls = 0;

  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER revenue_events_keeper_accounting_delete
AFTER DELETE ON revenue_events
REFERENCING OLD TABLE AS old_keeper_revenue_events
FOR EACH STATEMENT EXECUTE FUNCTION laypipe_apply_deleted_keeper_revenue_accounting();
--> statement-breakpoint
CREATE FUNCTION laypipe_apply_inserted_keeper_sweep_accounting()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  LOCK TABLE public.keeper_caller_accounting IN SHARE ROW EXCLUSIVE MODE;

  INSERT INTO public.keeper_caller_accounting (
    chain_id, caller_address, sequester_bounty, treasury_bounty,
    sequester_calls, treasury_calls, sweep_calls
  )
  SELECT chain_id, actor_address, 0, 0, 0, 0, count(*)
  FROM new_keeper_sweep_events
  WHERE actor_address IS NOT NULL AND fee_kind = 'swept'
  GROUP BY chain_id, actor_address
  ON CONFLICT (chain_id, caller_address) DO UPDATE
  SET sweep_calls = public.keeper_caller_accounting.sweep_calls
        + EXCLUDED.sweep_calls;

  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER fee_events_keeper_accounting_insert
AFTER INSERT ON fee_events
REFERENCING NEW TABLE AS new_keeper_sweep_events
FOR EACH STATEMENT EXECUTE FUNCTION laypipe_apply_inserted_keeper_sweep_accounting();
--> statement-breakpoint
CREATE FUNCTION laypipe_apply_deleted_keeper_sweep_accounting()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  LOCK TABLE public.keeper_caller_accounting IN SHARE ROW EXCLUSIVE MODE;

  WITH deltas AS (
    SELECT chain_id, actor_address, count(*) AS sweep_calls
    FROM old_keeper_sweep_events
    WHERE actor_address IS NOT NULL AND fee_kind = 'swept'
    GROUP BY chain_id, actor_address
  )
  UPDATE public.keeper_caller_accounting state
  SET sweep_calls = state.sweep_calls - deltas.sweep_calls
  FROM deltas
  WHERE state.chain_id = deltas.chain_id
    AND state.caller_address = deltas.actor_address;

  DELETE FROM public.keeper_caller_accounting
  WHERE sequester_bounty = 0 AND treasury_bounty = 0
    AND sequester_calls = 0 AND treasury_calls = 0 AND sweep_calls = 0;

  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER fee_events_keeper_accounting_delete
AFTER DELETE ON fee_events
REFERENCING OLD TABLE AS old_keeper_sweep_events
FOR EACH STATEMENT EXECUTE FUNCTION laypipe_apply_deleted_keeper_sweep_accounting();
--> statement-breakpoint
REVOKE ALL ON TABLE keeper_caller_accounting FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION laypipe_apply_inserted_keeper_revenue_accounting() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION laypipe_apply_deleted_keeper_revenue_accounting() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION laypipe_apply_inserted_keeper_sweep_accounting() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION laypipe_apply_deleted_keeper_sweep_accounting() FROM PUBLIC;
