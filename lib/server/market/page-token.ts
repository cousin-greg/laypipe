import { unstable_cache } from "next/cache";
import type { LiveTokenDetailResponse } from "../../market/live";
import { getReadDatabase } from "../db/neon";
import { MarketInputError, getLiveToken, parseLiveTokenSlug } from "./read-model";

export const LIVE_TOKEN_PAGE_CACHE_SECONDS = 10;
export const LIVE_TOKEN_PAGE_TIMEOUT_MS = 3_500;
const MAX_LIVE_TOKEN_PAGE_TIMEOUT_MS = 10_000;

export type LiveTokenPageResult =
  | { status: "ready"; payload: LiveTokenDetailResponse }
  | { status: "not_found" }
  | { status: "unavailable" };

export interface LiveTokenPageDependencies {
  readToken?: (address: string) => Promise<LiveTokenDetailResponse | null>;
  timeoutMs?: number;
}

const readCachedToken = unstable_cache(
  async (address: string) => getLiveToken(await getReadDatabase(), address),
  ["laypipe-live-token-page-v1"],
  { revalidate: LIVE_TOKEN_PAGE_CACHE_SECONDS },
);

async function withDeadline<T>(promise: Promise<T>, timeoutMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Live token read exceeded its deadline.")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function loadLiveTokenPage(
  slug: string,
  dependencies: LiveTokenPageDependencies = {},
): Promise<LiveTokenPageResult> {
  let address: string;
  try {
    address = parseLiveTokenSlug(slug);
  } catch (error) {
    if (error instanceof MarketInputError) return { status: "not_found" };
    return { status: "unavailable" };
  }

  const timeoutMs = dependencies.timeoutMs ?? LIVE_TOKEN_PAGE_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > MAX_LIVE_TOKEN_PAGE_TIMEOUT_MS
  ) {
    throw new Error("Live token page timeout is outside the supported range.");
  }

  try {
    const payload = await withDeadline(
      (dependencies.readToken ?? readCachedToken)(address),
      timeoutMs,
    );
    return payload ? { status: "ready", payload } : { status: "not_found" };
  } catch {
    return { status: "unavailable" };
  }
}
