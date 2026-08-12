import type {
  LiveMarketToken,
  LiveTokenDetailResponse,
  LiveTokenListResponse,
  PipedogPriceRatio,
} from "@/lib/market/live";
import type { MarketDataMode } from "@/lib/server/market/mode";
import {
  buildTokenListUrl,
  isMarketPageCursor,
  MARKET_PAGE_LIMIT,
} from "@/lib/market/pagination";
import { LaunchMode, LaunchToken, marketSource } from "./market";

export type ProtocolConfig = {
  chainId: number;
  factory: string | null;
  hook: string | null;
  feeRouter: string | null;
  poolManager: string | null;
  quoteToken: string;
};

export type ProtocolStats = {
  launches: number;
  volume24h: number;
  pipedogFeesRouted: number;
  pipedogSequestered: number;
};

export type TokenTrade = {
  txHash: string;
  side: "buy" | "sell";
  pipedogAmount: string;
  tokenAmount: string;
  timestamp: string;
};

export type TokenPosition = {
  tokenSlug: string;
  balance: string;
  claimablePipedog: string;
  creator: boolean;
};

export const laypipeApiRoutes = {
  config: "/api/config",
  stats: "/api/stats",
  tokens: "/api/tokens",
  token: (slug: string) => `/api/tokens/${slug}`,
  chart: (slug: string) => `/api/tokens/${slug}/chart`,
  trades: (slug: string) => `/api/tokens/${slug}/trades`,
  eventStream: (slug: string) => `/api/tokens/${slug}/stream`,
  holders: (slug: string) => `/api/tokens/${slug}/holders`,
  position: (slug: string, wallet: string) =>
    `/api/tokens/${slug}/position?wallet=${encodeURIComponent(wallet)}`,
  holdings: (wallet: string) =>
    `/api/holdings?wallet=${encodeURIComponent(wallet)}`,
  tokenomics: "/api/tokenomics",
  protocolDistributions: "/api/protocol-distributions",
} as const;

export type BoardToken = {
  source: "fixture" | "live";
  slug: string;
  tokenAddress: string | null;
  name: string;
  symbol: string;
  description: string | null;
  accent: string;
  price: number | null;
  priceUnit: "USD" | "PIPEDOG";
  marketCap: number | null;
  volume24h: number;
  volumeUnit: "USD" | "PIPEDOG";
  change24h: number | null;
  liquidity: number | null;
  holders: number | null;
  trades: number;
  ageHours: number;
  launchedAt: string;
  mode: LaunchMode;
  chart: number[];
};

export type BoardMarketSource = {
  mode: "fixture" | "live";
  label: string;
  tokens: BoardToken[];
  updatedAt: string | null;
  nextCursor: string | null;
};

export type MarketListRequest = {
  cursor?: string | null;
  limit?: number;
  signal?: AbortSignal;
};

export interface MarketDataAdapter {
  source: "fixture" | "live";
  listTokens(options?: MarketListRequest): Promise<BoardMarketSource>;
  getToken(slug: string, signal?: AbortSignal): Promise<BoardToken | null>;
}

function fixtureToken(token: LaunchToken): BoardToken {
  return {
    ...token,
    source: "fixture",
    tokenAddress: null,
    priceUnit: "USD",
    volumeUnit: "USD",
  };
}

export const fixtureMarketAdapter: MarketDataAdapter = {
  source: "fixture",
  async listTokens() {
    return {
      ...fixtureBoardSource,
      tokens: [...fixtureBoardSource.tokens],
      updatedAt: new Date().toISOString(),
      nextCursor: null,
    };
  },
  async getToken(slug) {
    const token = marketSource.tokens.find((value) => value.slug === slug);
    return token ? fixtureToken(token) : null;
  },
};

export const fixtureBoardSource: BoardMarketSource = {
  mode: "fixture",
  label: marketSource.label,
  tokens: marketSource.tokens.map(fixtureToken),
  updatedAt: marketSource.updatedAt,
  nextCursor: null,
};

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is invalid.`);
  }
  return value as Record<string, unknown>;
}

function requireLiveToken(value: unknown): LiveMarketToken {
  const token = requireObject(value, "Live token");
  if (
    token.source !== "live" ||
    typeof token.slug !== "string" ||
    typeof token.tokenAddress !== "string" ||
    typeof token.launchedAt !== "string" ||
    typeof token.feeMode !== "string" ||
    !token.metrics ||
    typeof token.metrics !== "object"
  ) {
    throw new Error("Live token payload is invalid.");
  }
  return token as unknown as LiveMarketToken;
}

function exactRatioToNumber(value: PipedogPriceRatio) {
  if (!/^\d+$/.test(value.pipedogAmount) || !/^[1-9]\d*$/.test(value.tokenAmount)) {
    throw new Error("Indexed price ratio is invalid.");
  }
  const result = Number(value.pipedogAmount) / Number(value.tokenAmount);
  return Number.isFinite(result) ? result : null;
}

function baseUnitsToDisplay(value: string) {
  if (!/^\d+$/.test(value)) throw new Error("Indexed base-unit amount is invalid.");
  const result = Number(value) / 1e18;
  if (!Number.isFinite(result)) throw new Error("Indexed amount is too large to display.");
  return result;
}

function elapsedHours(timestamp: string) {
  const milliseconds = new Date(timestamp).getTime();
  if (!Number.isFinite(milliseconds)) throw new Error("Indexed launch time is invalid.");
  return Math.max(0, Math.floor((Date.now() - milliseconds) / 3_600_000));
}

function addressAccent(address: string) {
  const hue = Number.parseInt(address.slice(2, 8), 16) % 360;
  return `hsl(${hue} 52% 48%)`;
}

export function mapLiveTokenToBoardToken(token: LiveMarketToken): BoardToken {
  const last = token.metrics.lastPricePipedog;
  const baseline = token.metrics.baselinePrice24hPipedog;
  const price = last.status === "observed" ? exactRatioToNumber(last.value) : null;
  let change24h: number | null = null;
  if (
    token.metrics.trades24h.value >= 2 &&
    last.status === "observed" &&
    baseline.status === "observed"
  ) {
    const baselinePrice = exactRatioToNumber(baseline.value);
    const lastPrice = exactRatioToNumber(last.value);
    if (baselinePrice && lastPrice !== null) {
      const change = ((lastPrice / baselinePrice) - 1) * 100;
      if (Number.isFinite(change)) change24h = change;
    }
  }
  const fallback = `${token.tokenAddress.slice(0, 6)}…${token.tokenAddress.slice(-4)}`;
  return {
    source: "live",
    slug: token.slug,
    tokenAddress: token.tokenAddress,
    name: token.name?.trim() || fallback,
    symbol: token.symbol?.trim() || token.tokenAddress.slice(2, 8).toUpperCase(),
    description: token.description,
    accent: addressAccent(token.tokenAddress),
    price,
    priceUnit: "PIPEDOG",
    marketCap: null,
    volume24h: baseUnitsToDisplay(token.metrics.volume24hPipedog.value),
    volumeUnit: "PIPEDOG",
    change24h,
    liquidity: null,
    holders: null,
    trades: token.metrics.totalTrades.value,
    ageHours: elapsedHours(token.launchedAt),
    launchedAt: token.launchedAt,
    mode: token.feeMode,
    chart: [],
  };
}

function parseTokenList(payload: unknown): LiveTokenListResponse {
  const response = requireObject(payload, "Live market response");
  const page = requireObject(response.page, "Live market page");
  const nextCursor = page.nextCursor;
  if (
    response.source !== "live" ||
    !Array.isArray(response.tokens) ||
    typeof page.limit !== "number" ||
    !Number.isSafeInteger(page.limit) ||
    page.limit < 1 ||
    page.limit > MARKET_PAGE_LIMIT ||
    (nextCursor !== null && !isMarketPageCursor(nextCursor))
  ) {
    throw new Error("Live market response is invalid.");
  }
  return {
    ...(response as unknown as LiveTokenListResponse),
    tokens: response.tokens.map(requireLiveToken),
  };
}

function parseTokenDetail(payload: unknown): LiveTokenDetailResponse {
  const response = requireObject(payload, "Live token response");
  if (response.source !== "live") throw new Error("Live token response is invalid.");
  return {
    ...(response as unknown as LiveTokenDetailResponse),
    token: requireLiveToken(response.token),
  };
}

export function createApiMarketAdapter(baseUrl = ""): MarketDataAdapter {
  return {
    source: "live",
    async listTokens(options = {}) {
      const endpoint = `${baseUrl}${laypipeApiRoutes.tokens}`;
      const response = await fetch(buildTokenListUrl(endpoint, {
        cursor: options.cursor,
        limit: options.limit ?? MARKET_PAGE_LIMIT,
      }), {
        signal: options.signal,
        headers: { accept: "application/json" },
      });

      if (!response.ok) {
        throw new Error(`Token index returned ${response.status}`);
      }

      const payload = parseTokenList(await response.json());
      return {
        mode: "live",
        label: "Indexed Robinhood Chain markets",
        tokens: payload.tokens.map(mapLiveTokenToBoardToken),
        updatedAt: payload.indexer?.updatedAt ?? null,
        nextCursor: payload.page.nextCursor,
      };
    },
    async getToken(slug, signal) {
      const response = await fetch(
        `${baseUrl}${laypipeApiRoutes.token(slug)}`,
        {
          signal,
          headers: { accept: "application/json" },
        },
      );

      if (response.status === 404) return null;
      if (!response.ok) {
        throw new Error(`Token index returned ${response.status}`);
      }

      return mapLiveTokenToBoardToken(parseTokenDetail(await response.json()).token);
    },
  };
}

export function selectMarketAdapter(mode: MarketDataMode): MarketDataAdapter {
  return mode === "live" ? createApiMarketAdapter() : fixtureMarketAdapter;
}
