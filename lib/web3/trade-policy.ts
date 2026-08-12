export const TRADE_QUOTE_TTL_MS = 30_000;

// The wallet can take time to sign after the final client-side freshness check.
// Keep that grace bounded, while sizing the router deadline for a chain that
// advances much faster than one block per second.
export const TRADE_WALLET_SUBMISSION_GRACE_MS = 30_000;
// This is a release stress assumption, not a claim that the chain runs at a
// fixed cadence. The router is block-bound, so slower cadence makes the same
// block cap last longer in wall-clock time.
export const TRADE_DEADLINE_STRESS_BLOCKS_PER_SECOND = 20;

const TRADE_ONCHAIN_DEADLINE_WINDOW_MS =
  TRADE_QUOTE_TTL_MS + TRADE_WALLET_SUBMISSION_GRACE_MS;

export const TRADE_DEADLINE_BLOCK_BUDGET = BigInt(
  Math.ceil(TRADE_ONCHAIN_DEADLINE_WINDOW_MS / 1_000) *
    TRADE_DEADLINE_STRESS_BLOCKS_PER_SECOND,
);
