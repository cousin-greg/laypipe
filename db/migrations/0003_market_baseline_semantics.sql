CREATE OR REPLACE FUNCTION laypipe_refresh_market_leaders()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  prior_refresh timestamptz;
  canonical_timestamp timestamptz;
  refresh_time timestamptz := transaction_timestamp();
BEGIN
  IF NEW.stream <> 'laypipe'
     OR NEW.last_run_status <> 'caught-up'
     OR NEW.last_processed_block IS NULL
     OR NEW.last_processed_hash IS NULL
     OR NEW.observed_safe_head IS NULL
     OR NEW.observed_at IS NULL
     OR NEW.observed_safe_head < NEW.last_processed_block THEN
    RETURN NEW;
  END IF;

  SELECT refreshed_at INTO prior_refresh
  FROM public.market_leader_snapshots
  WHERE chain_id = NEW.chain_id
  FOR UPDATE;

  IF prior_refresh IS NOT NULL
     AND prior_refresh > refresh_time - interval '1 minute' THEN
    RETURN NEW;
  END IF;

  SELECT block_timestamp INTO canonical_timestamp
  FROM public.chain_blocks
  WHERE chain_id = NEW.chain_id
    AND block_number = NEW.last_processed_block
    AND block_hash = NEW.last_processed_hash;
  IF canonical_timestamp IS NULL THEN
    RAISE EXCEPTION 'market leader watermark is not a stored canonical block';
  END IF;

  INSERT INTO public.market_leader_snapshots (
    chain_id, snapshot_block, snapshot_hash, snapshot_at, refreshed_at
  ) VALUES (
    NEW.chain_id, NEW.last_processed_block, NEW.last_processed_hash,
    canonical_timestamp, refresh_time
  )
  ON CONFLICT (chain_id) DO UPDATE
  SET snapshot_block = EXCLUDED.snapshot_block,
      snapshot_hash = EXCLUDED.snapshot_hash,
      snapshot_at = EXCLUDED.snapshot_at,
      refreshed_at = EXCLUDED.refreshed_at;

  DELETE FROM public.market_leader_entries WHERE chain_id = NEW.chain_id;

  WITH window_swaps AS MATERIALIZED (
    SELECT s.pool_id, s.pipedog_amount, s.token_amount,
      s.block_number, s.block_timestamp, s.log_index
    FROM public.swaps s
    WHERE s.chain_id = NEW.chain_id
      AND s.token_amount > 0
      AND s.block_number <= NEW.last_processed_block
      AND s.block_timestamp > canonical_timestamp - interval '24 hours'
      AND s.block_timestamp <= canonical_timestamp
  ), newest_leader AS (
    SELECT l.token_address
    FROM public.launches l
    WHERE l.chain_id = NEW.chain_id
      AND l.block_number <= NEW.last_processed_block
    ORDER BY l.block_number DESC, l.log_index DESC, l.token_address DESC
    LIMIT 1
  ), trade_counts AS (
    SELECT w.pool_id, count(*) AS trades_24h,
      sum(w.pipedog_amount) AS volume_24h_pipedog
    FROM window_swaps w
    GROUP BY w.pool_id
  ), cutoff_swaps AS (
    SELECT counts.pool_id, cutoff.pipedog_amount, cutoff.token_amount,
      false AS window_fallback
    FROM trade_counts counts
    JOIN LATERAL (
      SELECT s.pipedog_amount, s.token_amount
      FROM public.swaps s
      WHERE s.chain_id = NEW.chain_id
        AND s.pool_id = counts.pool_id
        AND s.token_amount > 0
        AND s.block_number <= NEW.last_processed_block
        AND s.block_timestamp <= canonical_timestamp - interval '24 hours'
      ORDER BY s.block_timestamp DESC, s.block_number DESC, s.log_index DESC
      LIMIT 1
    ) cutoff ON true
  ), first_window_swaps AS (
    SELECT DISTINCT ON (w.pool_id)
      w.pool_id, w.pipedog_amount, w.token_amount, true AS window_fallback
    FROM window_swaps w
    ORDER BY w.pool_id, w.block_timestamp ASC, w.block_number ASC, w.log_index ASC
  ), baseline_swaps AS (
    SELECT c.pool_id, c.pipedog_amount, c.token_amount, c.window_fallback
    FROM cutoff_swaps c
    UNION ALL
    SELECT first.pool_id, first.pipedog_amount, first.token_amount,
      first.window_fallback
    FROM first_window_swaps first
    WHERE NOT EXISTS (
      SELECT 1 FROM cutoff_swaps c WHERE c.pool_id = first.pool_id
    )
  ), latest_swaps AS (
    SELECT DISTINCT ON (w.pool_id)
      w.pool_id, w.pipedog_amount, w.token_amount
    FROM window_swaps w
    ORDER BY w.pool_id, w.block_number DESC, w.log_index DESC
  ), mover_scores AS (
    SELECT latest.pool_id,
      (
        latest.pipedog_amount * baseline.token_amount
        - baseline.pipedog_amount * latest.token_amount
      ) * 100 AS change_numerator,
      baseline.pipedog_amount * latest.token_amount AS change_denominator
    FROM latest_swaps latest
    JOIN baseline_swaps baseline USING (pool_id)
    JOIN trade_counts counts USING (pool_id)
    WHERE baseline.pipedog_amount > 0
      AND (NOT baseline.window_fallback OR counts.trades_24h >= 2)
  ), most_traded_leader AS (
    SELECT l.token_address
    FROM trade_counts t
    JOIN public.launches l
      ON l.chain_id = NEW.chain_id AND l.pool_id = t.pool_id
    ORDER BY t.trades_24h DESC, t.volume_24h_pipedog DESC,
      l.block_number DESC, l.log_index DESC, l.token_address DESC
    LIMIT 1
  ), biggest_mover_leader AS (
    SELECT l.token_address
    FROM mover_scores score
    JOIN public.launches l
      ON l.chain_id = NEW.chain_id AND l.pool_id = score.pool_id
    WHERE score.change_numerator > 0
    ORDER BY div(
      score.change_numerator * power(10::numeric, 320),
      score.change_denominator
    ) DESC, l.block_number DESC, l.log_index DESC, l.token_address DESC
    LIMIT 1
  ), leaders AS (
    SELECT 'most-traded'::text AS leader_kind, token_address
    FROM most_traded_leader
    UNION ALL
    SELECT 'newest'::text, token_address FROM newest_leader
    UNION ALL
    SELECT 'biggest-mover'::text, token_address FROM biggest_mover_leader
  )
  INSERT INTO public.market_leader_entries (
    chain_id, leader_kind, token_address
  )
  SELECT NEW.chain_id, leader_kind, token_address FROM leaders;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION laypipe_refresh_market_leaders() FROM PUBLIC;
