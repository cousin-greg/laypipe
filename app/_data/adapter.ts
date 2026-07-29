import { LaunchToken, MarketSource, marketSource } from "./market";

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

export interface MarketDataAdapter {
  source: "demo" | "api";
  listTokens(signal?: AbortSignal): Promise<MarketSource>;
  getToken(slug: string, signal?: AbortSignal): Promise<LaunchToken | null>;
}

export const demoMarketAdapter: MarketDataAdapter = {
  source: "demo",
  async listTokens() {
    return {
      ...marketSource,
      tokens: [...marketSource.tokens],
      updatedAt: new Date().toISOString(),
    };
  },
  async getToken(slug) {
    return marketSource.tokens.find((token) => token.slug === slug) ?? null;
  },
};

export function createApiMarketAdapter(baseUrl = ""): MarketDataAdapter {
  return {
    source: "api",
    async listTokens(signal) {
      const response = await fetch(`${baseUrl}${laypipeApiRoutes.tokens}`, {
        signal,
        headers: { accept: "application/json" },
      });

      if (!response.ok) {
        throw new Error(`Token index returned ${response.status}`);
      }

      return (await response.json()) as MarketSource;
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

      return (await response.json()) as LaunchToken;
    },
  };
}
