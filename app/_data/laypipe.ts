export const LAYPIPE_TOTAL_SUPPLY = 1_000_000_000;
export const LAYPIPE_MAX_PIPE_DOGS = 10_000;
export const LAYPIPE_PER_PIPE_DOG =
  LAYPIPE_TOTAL_SUPPLY / LAYPIPE_MAX_PIPE_DOGS;
export const LAYPIPE_TRADE_FEE_BPS = 100;

export type LaypipeAdapterMode = "contract-preview" | "live";

export type LaypipeProtocolSnapshot = {
  mode: LaypipeAdapterMode;
  totalSupply: string;
  maxPipeDogs: number;
  laypipePerPipeDog: string;
  tradeFeeBps: number;
  quoteSymbol: "ETH";
  baseSymbol: "LAYPIPE";
  tradingEnabled: boolean;
  claimEnabled: boolean;
  statusLabel: string;
};

export type PipeDogPreview = {
  id: string;
  name: string;
  imagePath: "/brand/pipedog.png";
  status: "automatic preview";
};

export type LaypipeWalletSnapshot = {
  mode: LaypipeAdapterMode;
  balance: string;
  pipeDogCount: number;
  rewardUnits: number;
  remainder: string;
  tokensToNextPipeDog: string;
  progressBps: number;
  claimablePipedog: string;
  pipeDogs: PipeDogPreview[];
};

export type LaypipePageData = {
  protocol: LaypipeProtocolSnapshot;
  wallet: LaypipeWalletSnapshot;
};

export type LaypipeDataAdapter = {
  mode: LaypipeAdapterMode;
  readProtocol: () => Promise<LaypipeProtocolSnapshot>;
  readWallet: (wallet?: string | null) => Promise<LaypipeWalletSnapshot>;
};

export function calculatePipeDogPosition(balanceWholeTokens: bigint) {
  if (balanceWholeTokens < BigInt(0)) {
    throw new Error("LAYPIPE balance cannot be negative.");
  }

  const unit = BigInt(LAYPIPE_PER_PIPE_DOG);
  const pipeDogCount = balanceWholeTokens / unit;
  const remainder = balanceWholeTokens % unit;
  const tokensToNextPipeDog = remainder === BigInt(0) ? unit : unit - remainder;

  return {
    balance: balanceWholeTokens.toString(),
    pipeDogCount: Number(pipeDogCount),
    rewardUnits: Number(pipeDogCount),
    remainder: remainder.toString(),
    tokensToNextPipeDog: tokensToNextPipeDog.toString(),
    progressBps: Number((remainder * BigInt(10_000)) / unit),
  };
}

const previewPosition = calculatePipeDogPosition(BigInt(248_250));

const protocolPreview: LaypipeProtocolSnapshot = {
  mode: "contract-preview",
  totalSupply: String(LAYPIPE_TOTAL_SUPPLY),
  maxPipeDogs: LAYPIPE_MAX_PIPE_DOGS,
  laypipePerPipeDog: String(LAYPIPE_PER_PIPE_DOG),
  tradeFeeBps: LAYPIPE_TRADE_FEE_BPS,
  quoteSymbol: "ETH",
  baseSymbol: "LAYPIPE",
  tradingEnabled: false,
  claimEnabled: false,
  statusLabel: "Singleton contracts pending",
};

const walletPreview: LaypipeWalletSnapshot = {
  mode: "contract-preview",
  ...previewPosition,
  claimablePipedog: "1284.37",
  pipeDogs: [
    {
      id: "preview-0001",
      name: "Lay Pipedog #0001",
      imagePath: "/brand/pipedog.png",
      status: "automatic preview",
    },
    {
      id: "preview-0002",
      name: "Lay Pipedog #0002",
      imagePath: "/brand/pipedog.png",
      status: "automatic preview",
    },
  ],
};

export const laypipePreviewAdapter: LaypipeDataAdapter = {
  mode: "contract-preview",
  async readProtocol() {
    return protocolPreview;
  },
  async readWallet() {
    return walletPreview;
  },
};

export async function readLaypipePageData(
  adapter: LaypipeDataAdapter = laypipePreviewAdapter,
): Promise<LaypipePageData> {
  const [protocol, wallet] = await Promise.all([
    adapter.readProtocol(),
    adapter.readWallet(),
  ]);

  return { protocol, wallet };
}
