export type LaunchMode = "creator" | "self-burn";

export type LaunchToken = {
  slug: string;
  name: string;
  symbol: string;
  description: string;
  accent: string;
  price: number;
  marketCap: number;
  volume24h: number;
  change24h: number;
  liquidity: number;
  holders: number;
  trades: number;
  ageHours: number;
  launchedAt: string;
  mode: LaunchMode;
  chart: number[];
};

export type MarketSource = {
  mode: "demo";
  label: string;
  tokens: LaunchToken[];
  updatedAt: string;
};

const demoTokens: LaunchToken[] = [
  {
    slug: "pipe-dream",
    name: "Pipe Dream",
    symbol: "DREAM",
    description: "A bright little coin with unrealistic plumbing ambitions.",
    accent: "#ef6b47",
    price: 0.000184,
    marketCap: 184000,
    volume24h: 42600,
    change24h: 38.4,
    liquidity: 74800,
    holders: 1284,
    trades: 3219,
    ageHours: 46,
    launchedAt: "2026-07-27T13:20:00.000Z",
    mode: "self-burn",
    chart: [21, 26, 24, 31, 35, 33, 43, 47, 44, 52, 61, 70],
  },
  {
    slug: "yard-dog",
    name: "Yard Dog",
    symbol: "YARD",
    description: "Outside all day. Refuses to come in. Extremely liquid.",
    accent: "#e9b949",
    price: 0.000092,
    marketCap: 92000,
    volume24h: 18800,
    change24h: 16.2,
    liquidity: 39100,
    holders: 721,
    trades: 1840,
    ageHours: 19,
    launchedAt: "2026-07-28T16:12:00.000Z",
    mode: "creator",
    chart: [26, 31, 29, 34, 38, 36, 41, 46, 48, 45, 54, 58],
  },
  {
    slug: "green-valve",
    name: "Green Valve",
    symbol: "VALVE",
    description: "Turn it left. Let the fees flow.",
    accent: "#2b9461",
    price: 0.000317,
    marketCap: 317000,
    volume24h: 35100,
    change24h: 9.8,
    liquidity: 98700,
    holders: 2031,
    trades: 4428,
    ageHours: 92,
    launchedAt: "2026-07-25T15:45:00.000Z",
    mode: "self-burn",
    chart: [44, 42, 46, 43, 48, 50, 49, 55, 53, 59, 61, 64],
  },
  {
    slug: "sun-pup",
    name: "Sun Pup",
    symbol: "SUNPUP",
    description: "Solar powered, grass approved, never indoors.",
    accent: "#f2c84b",
    price: 0.000068,
    marketCap: 68000,
    volume24h: 14200,
    change24h: 24.7,
    liquidity: 28800,
    holders: 516,
    trades: 1127,
    ageHours: 7,
    launchedAt: "2026-07-29T04:22:00.000Z",
    mode: "creator",
    chart: [18, 17, 23, 22, 28, 31, 30, 38, 42, 47, 53, 65],
  },
  {
    slug: "porch-coin",
    name: "Porch Coin",
    symbol: "PORCH",
    description: "A rocking-chair reserve currency for very long afternoons.",
    accent: "#83b856",
    price: 0.000131,
    marketCap: 131000,
    volume24h: 9100,
    change24h: -4.3,
    liquidity: 52200,
    holders: 988,
    trades: 2074,
    ageHours: 133,
    launchedAt: "2026-07-23T22:05:00.000Z",
    mode: "creator",
    chart: [62, 59, 61, 55, 57, 51, 54, 49, 47, 50, 46, 44],
  },
  {
    slug: "puddle",
    name: "Puddle",
    symbol: "PDL",
    description: "Small pool. Deep lore.",
    accent: "#59b9d4",
    price: 0.000045,
    marketCap: 45000,
    volume24h: 12300,
    change24h: 11.6,
    liquidity: 19400,
    holders: 403,
    trades: 940,
    ageHours: 31,
    launchedAt: "2026-07-28T04:08:00.000Z",
    mode: "self-burn",
    chart: [30, 33, 31, 36, 34, 39, 43, 41, 45, 49, 47, 52],
  },
  {
    slug: "sprinklr",
    name: "Sprinklr",
    symbol: "SPRK",
    description: "Automated distribution for lawns and attention.",
    accent: "#70c9dc",
    price: 0.000024,
    marketCap: 24000,
    volume24h: 6800,
    change24h: 6.1,
    liquidity: 12100,
    holders: 271,
    trades: 611,
    ageHours: 4,
    launchedAt: "2026-07-29T07:30:00.000Z",
    mode: "creator",
    chart: [21, 24, 23, 27, 30, 29, 31, 35, 33, 37, 39, 41],
  },
  {
    slug: "borkline",
    name: "Borkline",
    symbol: "BORK",
    description: "A direct route from the backyard to the timeline.",
    accent: "#d88e55",
    price: 0.000208,
    marketCap: 208000,
    volume24h: 26700,
    change24h: -8.9,
    liquidity: 67500,
    holders: 1498,
    trades: 3683,
    ageHours: 71,
    launchedAt: "2026-07-26T12:42:00.000Z",
    mode: "self-burn",
    chart: [68, 65, 67, 61, 58, 60, 54, 56, 51, 48, 45, 42],
  },
  {
    slug: "hole-inspector",
    name: "Hole Inspector",
    symbol: "HOLE",
    description: "Every mystery begins with a suspicious patch of dirt.",
    accent: "#a8754d",
    price: 0.000076,
    marketCap: 76000,
    volume24h: 15400,
    change24h: 19.1,
    liquidity: 33400,
    holders: 640,
    trades: 1531,
    ageHours: 14,
    launchedAt: "2026-07-28T21:16:00.000Z",
    mode: "creator",
    chart: [23, 28, 25, 31, 34, 32, 38, 40, 46, 44, 51, 57],
  },
  {
    slug: "leaky-alpha",
    name: "Leaky Alpha",
    symbol: "DRIP",
    description: "The information escaped through a loose fitting.",
    accent: "#b96042",
    price: 0.000011,
    marketCap: 11000,
    volume24h: 4900,
    change24h: -12.4,
    liquidity: 7300,
    holders: 146,
    trades: 382,
    ageHours: 2,
    launchedAt: "2026-07-29T09:18:00.000Z",
    mode: "self-burn",
    chart: [58, 62, 57, 54, 56, 49, 51, 46, 43, 45, 39, 36],
  },
  {
    slug: "garden-party",
    name: "Garden Party",
    symbol: "GARDEN",
    description: "Everyone is invited. Someone bring a hose.",
    accent: "#79a84f",
    price: 0.000053,
    marketCap: 53000,
    volume24h: 7700,
    change24h: 3.6,
    liquidity: 22700,
    holders: 390,
    trades: 817,
    ageHours: 53,
    launchedAt: "2026-07-27T06:55:00.000Z",
    mode: "creator",
    chart: [32, 31, 34, 36, 35, 38, 37, 40, 42, 41, 43, 45],
  },
  {
    slug: "fence-fund",
    name: "Fence Fund",
    symbol: "FENCE",
    description: "A hard boundary around soft money.",
    accent: "#6c8d72",
    price: 0.000099,
    marketCap: 99000,
    volume24h: 11100,
    change24h: 7.2,
    liquidity: 41600,
    holders: 804,
    trades: 1990,
    ageHours: 108,
    launchedAt: "2026-07-24T23:10:00.000Z",
    mode: "self-burn",
    chart: [30, 34, 32, 35, 37, 36, 40, 42, 41, 44, 46, 49],
  },
];

export const marketSource: MarketSource = {
  mode: "demo",
  label: "Illustrative preview data",
  tokens: demoTokens,
  updatedAt: "2026-07-29T10:00:00.000Z",
};

export const protocolPreviewStats = [
  { label: "Demo launches", value: "12", note: "sample set" },
  { label: "Demo 24h volume", value: "$204K", note: "illustrative" },
  { label: "PIPEDOG → 0xdead", value: "—", note: "router pending" },
  { label: "PIPEDOG fees routed", value: "—", note: "indexer pending" },
];

export function findDemoToken(slug: string) {
  return marketSource.tokens.find((token) => token.slug === slug);
}

export function newestDemoTokens(limit = 8) {
  return [...marketSource.tokens]
    .sort((a, b) => a.ageHours - b.ageHours)
    .slice(0, limit);
}
