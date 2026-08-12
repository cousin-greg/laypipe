"use client";

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  cursorAfterFirstPageRefresh,
  MARKET_PAGE_LIMIT,
  MARKET_POLL_INTERVAL_MS,
  marketPollDelay,
  mergeMarketPages,
  shouldRevalidateLoadedMarketPages,
} from "@/lib/market/pagination";
import type { MarketDataMode } from "@/lib/server/market/mode";
import {
  type BoardMarketSource,
  type BoardToken,
  fixtureBoardSource,
  selectMarketAdapter,
} from "../_data/adapter";

export type MarketRefreshState = "ready" | "refreshing" | "error";

type MarketDataContextValue = {
  marketMode: MarketDataMode;
  tokens: BoardToken[];
  leaders: BoardMarketSource["leaders"];
  refreshState: MarketRefreshState;
  lastUpdated: string | null;
  hasMore: boolean;
  loadingMore: boolean;
  loadMoreError: boolean;
  loadMore: () => Promise<void>;
};

const MarketDataContext = createContext<MarketDataContextValue | null>(null);

const tokenKey = (token: BoardToken) => token.slug;
const emptyMarketLeaders: BoardMarketSource["leaders"] = {
  mostTraded: null,
  newest: null,
  biggestMover: null,
};

export function MarketDataProvider({
  children,
  marketMode,
}: {
  children: ReactNode;
  marketMode: MarketDataMode;
}) {
  const adapter = useMemo(() => selectMarketAdapter(marketMode), [marketMode]);
  const fixture = marketMode === "fixture" ? fixtureBoardSource : null;
  const [tokens, setTokens] = useState<BoardToken[]>(() => fixture?.tokens ?? []);
  const [leaders, setLeaders] = useState<BoardMarketSource["leaders"]>(() =>
    fixture?.leaders ?? emptyMarketLeaders,
  );
  const tokensRef = useRef<BoardToken[]>(fixture?.tokens ?? []);
  const [refreshState, setRefreshState] = useState<MarketRefreshState>(
    marketMode === "fixture" ? "ready" : "refreshing",
  );
  const [lastUpdated, setLastUpdated] = useState<string | null>(
    fixture?.updatedAt ?? null,
  );
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState(false);
  const deepestCursor = useRef<string | null | undefined>(
    marketMode === "fixture" ? null : undefined,
  );
  const loadedPageCount = useRef(1);
  const lastLoadedPagesRevalidation = useRef(0);
  const hasLoadedOlderPages = useRef(false);
  const refreshPending = useRef(false);
  const loadMorePending = useRef(false);
  const loadMoreController = useRef<AbortController | null>(null);

  useEffect(() => {
    if (marketMode === "fixture") return;

    let stopped = false;
    let timer: number | null = null;
    let activeController: AbortController | null = null;
    let consecutiveErrors = 0;

    const clearScheduledRefresh = () => {
      if (timer === null) return;
      window.clearTimeout(timer);
      timer = null;
    };

    const scheduleRefresh = (delay: number) => {
      clearScheduledRefresh();
      if (stopped || document.hidden) return;
      timer = window.setTimeout(() => void refresh(), delay);
    };

    const refresh = async () => {
      if (stopped || document.hidden || activeController) return;
      if (loadMorePending.current) {
        scheduleRefresh(1_000);
        return;
      }

      const controller = new AbortController();
      activeController = controller;
      refreshPending.current = true;
      setRefreshState("refreshing");

      try {
        const result = await adapter.listTokens({
          limit: MARKET_PAGE_LIMIT,
          signal: controller.signal,
        });
        if (stopped || controller.signal.aborted) return;

        const targetPageCount = loadedPageCount.current;
        const revalidateLoadedPages = shouldRevalidateLoadedMarketPages(
          targetPageCount,
          Date.now() - lastLoadedPagesRevalidation.current,
        );
        let refreshedTokens = result.tokens;
        let refreshedCursor = result.nextCursor;
        let refreshedPageCount = 1;
        if (revalidateLoadedPages) {
          while (
            refreshedPageCount < targetPageCount &&
            refreshedCursor
          ) {
            const olderPage = await adapter.listTokens({
              cursor: refreshedCursor,
              limit: MARKET_PAGE_LIMIT,
              signal: controller.signal,
            });
            if (stopped || controller.signal.aborted) return;
            refreshedTokens = mergeMarketPages(
              refreshedTokens,
              olderPage.tokens,
              tokenKey,
            );
            refreshedCursor = olderPage.nextCursor;
            refreshedPageCount += 1;
          }
          loadedPageCount.current = refreshedPageCount;
          hasLoadedOlderPages.current = refreshedPageCount > 1;
          lastLoadedPagesRevalidation.current = Date.now();
          deepestCursor.current = refreshedCursor;
          setNextCursor(refreshedCursor);
        } else {
          refreshedTokens = mergeMarketPages(
            refreshedTokens,
            tokensRef.current,
            tokenKey,
          );
          refreshedCursor = cursorAfterFirstPageRefresh(
            deepestCursor.current,
            result.nextCursor,
            hasLoadedOlderPages.current,
          );
          deepestCursor.current = refreshedCursor;
          setNextCursor(refreshedCursor);
        }
        tokensRef.current = refreshedTokens;
        setTokens(refreshedTokens);
        setLeaders(result.leaders);
        setLastUpdated(result.updatedAt);
        consecutiveErrors = 0;
        setRefreshState("ready");
        scheduleRefresh(MARKET_POLL_INTERVAL_MS);
      } catch {
        if (stopped || controller.signal.aborted) return;
        consecutiveErrors += 1;
        setRefreshState("error");
        scheduleRefresh(marketPollDelay(consecutiveErrors));
      } finally {
        if (activeController === controller) activeController = null;
        refreshPending.current = false;
      }
    };

    const handleVisibilityChange = () => {
      clearScheduledRefresh();
      if (document.hidden) {
        activeController?.abort();
        activeController = null;
        return;
      }
      void refresh();
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    void refresh();

    return () => {
      stopped = true;
      clearScheduledRefresh();
      activeController?.abort();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [adapter, marketMode]);

  useEffect(
    () => () => {
      loadMoreController.current?.abort();
    },
    [],
  );

  const loadMore = useCallback(async () => {
    const cursor = deepestCursor.current;
    if (
      marketMode !== "live" ||
      !cursor ||
      refreshPending.current ||
      loadMorePending.current
    ) {
      return;
    }

    const controller = new AbortController();
    loadMorePending.current = true;
    loadMoreController.current = controller;
    setLoadingMore(true);
    setLoadMoreError(false);

    try {
      const result = await adapter.listTokens({
        cursor,
        limit: MARKET_PAGE_LIMIT,
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;

      const mergedTokens = mergeMarketPages(
        tokensRef.current,
        result.tokens,
        tokenKey,
      );
      tokensRef.current = mergedTokens;
      setTokens(mergedTokens);
      setLastUpdated(result.updatedAt);
      hasLoadedOlderPages.current = true;
      loadedPageCount.current += 1;
      deepestCursor.current = result.nextCursor;
      setNextCursor(result.nextCursor);
    } catch {
      if (!controller.signal.aborted) setLoadMoreError(true);
    } finally {
      if (loadMoreController.current === controller) {
        loadMoreController.current = null;
      }
      loadMorePending.current = false;
      if (!controller.signal.aborted) setLoadingMore(false);
    }
  }, [adapter, marketMode]);

  const value = useMemo<MarketDataContextValue>(
    () => ({
      marketMode,
      tokens,
      leaders,
      refreshState,
      lastUpdated,
      hasMore: nextCursor !== null,
      loadingMore,
      loadMoreError,
      loadMore,
    }),
    [
      lastUpdated,
      leaders,
      loadMore,
      loadMoreError,
      loadingMore,
      marketMode,
      nextCursor,
      refreshState,
      tokens,
    ],
  );

  return (
    <MarketDataContext.Provider value={value}>
      {children}
    </MarketDataContext.Provider>
  );
}

export function useMarketData() {
  const value = useContext(MarketDataContext);
  if (!value) {
    throw new Error("useMarketData must be used inside MarketDataProvider.");
  }
  return value;
}
