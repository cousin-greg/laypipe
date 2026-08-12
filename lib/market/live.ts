export const LAYPIPE_CHAIN_ID = 4_663;

export type ObservedMetric<T> = {
  status: "observed";
  value: T;
  basis: string;
};

export type UnavailableMetric = {
  status: "unavailable";
  value: null;
  reason: string;
};

export type LiveMetric<T> = ObservedMetric<T> | UnavailableMetric;

export type PipedogPriceRatio = {
  pipedogAmount: string;
  tokenAmount: string;
};

export interface LiveTokenMetrics {
  lastPricePipedog: LiveMetric<PipedogPriceRatio>;
  baselinePrice24hPipedog: LiveMetric<PipedogPriceRatio>;
  volume24hPipedog: ObservedMetric<string>;
  trades24h: ObservedMetric<number>;
  totalTrades: ObservedMetric<number>;
  marketCapUsd: UnavailableMetric;
  liquidityUsd: UnavailableMetric;
  holders: UnavailableMetric;
}

export interface LiveMarketToken {
  source: "live";
  chainId: number;
  slug: string;
  tokenAddress: `0x${string}`;
  poolId: `0x${string}`;
  creatorAddress: `0x${string}`;
  hookAddress: `0x${string}`;
  feeRecipientAddress: `0x${string}`;
  feeMode: "creator" | "self-burn";
  configId: string;
  firstBuyPipedogIn: string;
  firstBuyTokenOut: string;
  name: string | null;
  symbol: string | null;
  description: string | null;
  logoUri: string | null;
  metadataUri: string | null;
  socials: Record<string, string> | null;
  blockNumber: string;
  launchedAt: string;
  lastTradeAt: string | null;
  metrics: LiveTokenMetrics;
}

export interface IndexerWatermark {
  stream: string;
  nextBlock: string;
  lastProcessedBlock: string | null;
  lastProcessedHash: `0x${string}` | null;
  updatedAt: string;
}

export interface LiveTokenListResponse {
  source: "live";
  chainId: number;
  tokens: LiveMarketToken[];
  page: {
    limit: number;
    nextCursor: string | null;
  };
  indexer: IndexerWatermark | null;
}

export interface LiveTokenDetailResponse {
  source: "live";
  chainId: number;
  token: LiveMarketToken;
  indexer: IndexerWatermark | null;
}

export interface MarketApiError {
  error: {
    code: "invalid_request" | "not_found" | "market_data_unavailable";
    message: string;
  };
}
