export const MARKET_PAGE_LIMIT = 50;
export const MARKET_POLL_INTERVAL_MS = 15_000;
export const MARKET_POLL_MAX_BACKOFF_MS = 120_000;
export const MARKET_LOADED_PAGES_REVALIDATE_MS = 60_000;

const CURSOR_PATTERN = /^[A-Za-z0-9_-]{1,512}$/;

export function isMarketPageCursor(value: unknown): value is string {
  return typeof value === "string" && CURSOR_PATTERN.test(value);
}

export function marketPollDelay(consecutiveErrors: number) {
  if (!Number.isSafeInteger(consecutiveErrors) || consecutiveErrors < 0) {
    throw new Error("Market polling error count is invalid.");
  }

  if (consecutiveErrors === 0) return MARKET_POLL_INTERVAL_MS;
  return Math.min(
    MARKET_POLL_INTERVAL_MS * 2 ** Math.min(consecutiveErrors, 3),
    MARKET_POLL_MAX_BACKOFF_MS,
  );
}

export function shouldRevalidateLoadedMarketPages(
  loadedPageCount: number,
  elapsedMs: number,
) {
  if (
    !Number.isSafeInteger(loadedPageCount) ||
    loadedPageCount < 1 ||
    !Number.isFinite(elapsedMs) ||
    elapsedMs < 0
  ) {
    throw new Error("Loaded market page revalidation state is invalid.");
  }
  return (
    loadedPageCount > 1 &&
    elapsedMs >= MARKET_LOADED_PAGES_REVALIDATE_MS
  );
}

export function buildTokenListUrl(
  endpoint: string,
  options: { cursor?: string | null; limit?: number } = {},
) {
  const limit = options.limit ?? MARKET_PAGE_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MARKET_PAGE_LIMIT) {
    throw new Error(`Market page limit must be between 1 and ${MARKET_PAGE_LIMIT}.`);
  }
  if (options.cursor && !isMarketPageCursor(options.cursor)) {
    throw new Error("Market page cursor is malformed.");
  }

  const parameters = new URLSearchParams({ limit: String(limit) });
  if (options.cursor) parameters.set("cursor", options.cursor);
  return `${endpoint}?${parameters.toString()}`;
}

export function mergeMarketPages<T>(
  first: readonly T[],
  retained: readonly T[],
  key: (value: T) => string,
) {
  const seen = new Set<string>();
  const merged: T[] = [];

  for (const value of [...first, ...retained]) {
    const id = key(value);
    if (seen.has(id)) continue;
    seen.add(id);
    merged.push(value);
  }

  return merged;
}

export function cursorAfterFirstPageRefresh(
  deepestCursor: string | null | undefined,
  firstPageNextCursor: string | null,
  hasLoadedOlderPages: boolean,
) {
  return hasLoadedOlderPages ? deepestCursor ?? null : firstPageNextCursor;
}
