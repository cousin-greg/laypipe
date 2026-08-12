export type MarketDataMode = "fixture" | "live";

/** Live data is opt-in. Missing configuration always remains visibly fixture. */
export function readMarketDataMode(
  value = process.env.LAYPIPE_MARKET_MODE,
): MarketDataMode {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || normalized === "fixture") return "fixture";
  if (normalized === "live") return "live";
  throw new Error("LAYPIPE_MARKET_MODE must be either fixture or live.");
}
