CREATE TABLE laypipe_database_identity (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  database_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
INSERT INTO laypipe_database_identity (singleton, database_id)
VALUES (true, gen_random_uuid());
--> statement-breakpoint
CREATE INDEX ipfs_promotions_creator_completed_cids_idx
  ON ipfs_promotions (wallet_address, image_cid, metadata_cid)
  INCLUDE (promotion_id)
  WHERE status = 'completed';
--> statement-breakpoint
CREATE FUNCTION laypipe_runtime_initialize_cursor(
  p_chain_id bigint,
  p_stream text,
  p_start_block bigint
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM public.laypipe_initialize_cursor(p_chain_id, p_stream, p_start_block);
END;
$$;
--> statement-breakpoint
CREATE FUNCTION laypipe_runtime_advance_cursor(
  p_chain_id bigint,
  p_stream text,
  p_expected_next bigint,
  p_last_block bigint,
  p_last_hash evm_bytes32
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM public.laypipe_advance_cursor(
    p_chain_id, p_stream, p_expected_next, p_last_block, p_last_hash
  );
END;
$$;
--> statement-breakpoint
CREATE FUNCTION laypipe_runtime_record_observation(
  p_chain_id bigint,
  p_stream text,
  p_safe_head bigint,
  p_observed_at timestamptz,
  p_status text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  updated boolean;
BEGIN
  IF p_status NOT IN ('caught-up', 'bounded', 'deadline') THEN
    RAISE EXCEPTION 'invalid indexer observation status';
  END IF;
  UPDATE public.indexer_cursors
  SET observed_safe_head = p_safe_head,
      observed_at = p_observed_at,
      last_run_status = p_status
  WHERE chain_id = p_chain_id AND stream = p_stream
    AND (last_processed_block IS NULL OR last_processed_block <= p_safe_head)
    AND (observed_safe_head IS NULL OR observed_safe_head <= p_safe_head)
    AND (observed_at IS NULL OR observed_at <= p_observed_at)
  RETURNING true INTO updated;
  RETURN COALESCE(updated, false);
END;
$$;
--> statement-breakpoint
CREATE FUNCTION laypipe_runtime_rollback_chain(
  p_chain_id bigint,
  p_ancestor_block bigint,
  p_ancestor_hash evm_bytes32
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  RETURN public.laypipe_rollback_chain(
    p_chain_id, p_ancestor_block, p_ancestor_hash
  );
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION laypipe_runtime_initialize_cursor(bigint, text, bigint)
  FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION laypipe_runtime_advance_cursor(bigint, text, bigint, bigint, evm_bytes32)
  FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION laypipe_runtime_record_observation(bigint, text, bigint, timestamptz, text)
  FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION laypipe_runtime_rollback_chain(bigint, bigint, evm_bytes32)
  FROM PUBLIC;
