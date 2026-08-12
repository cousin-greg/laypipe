import type { IndexerWatermark } from "../market/live";
import { trustedIpfsGatewayUrl } from "../ipfs/gateway";
import { isAddress } from "../web3/types";

export type ClaimablePipedog =
  | {
      status: "observed";
      value: string;
      swept: string;
      pendingCreatorShare: string;
      asOfBlock: string;
    }
  | {
      status: "unavailable";
      value: null;
      reason: string;
    };

export interface WalletTokenPosition {
  tokenAddress: `0x${string}`;
  poolId: `0x${string}`;
  name: string | null;
  symbol: string | null;
  logoGatewayUrl: string | null;
  feeMode: "creator" | "self-burn";
  launchedAt: string;
  balance: string;
  originalCreator: `0x${string}`;
  currentCreator: `0x${string}`;
  launchedByWallet: boolean;
  isCurrentCreator: boolean;
  lifetimeCreatorClaimedPipedog: string;
  lifetimeSelfBurnedTokens: string;
  claimablePipedog: ClaimablePipedog;
}

export interface WalletPortfolioResponse {
  source: "live";
  chainId: 4663;
  wallet: `0x${string}`;
  asOfBlock: string;
  onchainClaims:
    | { status: "unavailable"; reason: string };
  positions: WalletTokenPosition[];
  page: { limit: number; nextCursor: string | null };
  indexer: IndexerWatermark;
}

export interface WalletApiError {
  error: {
    code: "invalid_request" | "rate_limited" | "wallet_data_unavailable";
    message: string;
  };
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Wallet API returned malformed data.");
  }
  return value as Record<string, unknown>;
}

function uintText(value: unknown) {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)$/.test(value)) {
    throw new Error("Wallet API returned a malformed amount.");
  }
  return value;
}

function address(value: unknown) {
  if (typeof value !== "string" || !isAddress(value)) {
    throw new Error("Wallet API returned a malformed address.");
  }
  return value;
}

function bytes32(value: unknown) {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error("Wallet API returned a malformed pool ID.");
  }
  return value as `0x${string}`;
}

function timestamp(value: unknown) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error("Wallet API returned a malformed timestamp.");
  }
  return value;
}

function nullableText(value: unknown) {
  if (value !== null && typeof value !== "string") {
    throw new Error("Wallet API returned malformed token metadata.");
  }
  return value as string | null;
}

function parseClaimable(value: unknown): ClaimablePipedog {
  const parsed = record(value);
  if (parsed.status === "unavailable") {
    if (parsed.value !== null || typeof parsed.reason !== "string") {
      throw new Error("Wallet API returned malformed claim state.");
    }
    return { status: "unavailable", value: null, reason: parsed.reason };
  }
  if (parsed.status === "observed") {
    return {
      status: "observed",
      value: uintText(parsed.value),
      swept: uintText(parsed.swept),
      pendingCreatorShare: uintText(parsed.pendingCreatorShare),
      asOfBlock: uintText(parsed.asOfBlock),
    };
  }
  throw new Error("Wallet API returned malformed claim state.");
}

function parseIndexer(value: unknown): IndexerWatermark {
  const parsed = record(value);
  const nullableUint = (entry: unknown) =>
    entry === null ? null : uintText(entry);
  const nullableHash = (entry: unknown) => {
    if (entry === null) return null;
    return bytes32(entry);
  };
  const nullableTimestamp = (entry: unknown) =>
    entry === null ? null : timestamp(entry);
  if (
    typeof parsed.stream !== "string" ||
    (parsed.lastRunStatus !== null &&
      parsed.lastRunStatus !== "caught-up" &&
      parsed.lastRunStatus !== "bounded" &&
      parsed.lastRunStatus !== "deadline")
  ) {
    throw new Error("Wallet API returned a malformed indexer watermark.");
  }
  return {
    stream: parsed.stream,
    nextBlock: uintText(parsed.nextBlock),
    lastProcessedBlock: nullableUint(parsed.lastProcessedBlock),
    lastProcessedHash: nullableHash(parsed.lastProcessedHash),
    updatedAt: timestamp(parsed.updatedAt),
    observedSafeHead: nullableUint(parsed.observedSafeHead),
    observedAt: nullableTimestamp(parsed.observedAt),
    lastRunStatus: parsed.lastRunStatus,
  };
}

/** Parse the untrusted HTTP boundary before amounts or pool IDs reach React or a wallet client. */
export function parseWalletPortfolioResponse(
  value: unknown,
  expectedWallet: `0x${string}`,
): WalletPortfolioResponse {
  const parsed = record(value);
  const wallet = address(parsed.wallet);
  if (
    parsed.source !== "live" ||
    parsed.chainId !== 4_663 ||
    wallet.toLowerCase() !== expectedWallet.toLowerCase() ||
    !Array.isArray(parsed.positions) ||
    parsed.positions.length > 20
  ) {
    throw new Error("Wallet API response does not match the connected wallet.");
  }
  const claims = record(parsed.onchainClaims);
  if (claims.status !== "unavailable" || typeof claims.reason !== "string") {
    throw new Error("Wallet API returned malformed on-chain claim status.");
  }
  const positions = parsed.positions.map((entry): WalletTokenPosition => {
    const position = record(entry);
    const feeMode = position.feeMode;
    if (
      (feeMode !== "creator" && feeMode !== "self-burn") ||
      typeof position.launchedByWallet !== "boolean" ||
      typeof position.isCurrentCreator !== "boolean"
    ) {
      throw new Error("Wallet API returned a malformed token position.");
    }
    const rawArtwork = position.logoGatewayUrl;
    const logoGatewayUrl =
      rawArtwork === null
        ? null
        : typeof rawArtwork === "string"
          ? trustedIpfsGatewayUrl(rawArtwork)
          : null;
    if (rawArtwork !== null && logoGatewayUrl === null) {
      throw new Error("Wallet API returned an untrusted artwork URL.");
    }
    return {
      tokenAddress: address(position.tokenAddress),
      poolId: bytes32(position.poolId),
      name: nullableText(position.name),
      symbol: nullableText(position.symbol),
      logoGatewayUrl,
      feeMode,
      launchedAt: timestamp(position.launchedAt),
      balance: uintText(position.balance),
      originalCreator: address(position.originalCreator),
      currentCreator: address(position.currentCreator),
      launchedByWallet: position.launchedByWallet,
      isCurrentCreator: position.isCurrentCreator,
      lifetimeCreatorClaimedPipedog: uintText(
        position.lifetimeCreatorClaimedPipedog,
      ),
      lifetimeSelfBurnedTokens: uintText(position.lifetimeSelfBurnedTokens),
      claimablePipedog: parseClaimable(position.claimablePipedog),
    };
  });
  const page = record(parsed.page);
  if (
    !Number.isSafeInteger(page.limit) ||
    (page.limit as number) < 1 ||
    (page.limit as number) > 20 ||
    (page.nextCursor !== null &&
      (typeof page.nextCursor !== "string" ||
        !/^[A-Za-z0-9_-]{1,768}$/.test(page.nextCursor)))
  ) {
    throw new Error("Wallet API returned malformed pagination.");
  }
  return {
    source: "live",
    chainId: 4_663,
    wallet,
    asOfBlock: uintText(parsed.asOfBlock),
    onchainClaims: { status: "unavailable", reason: claims.reason },
    positions,
    page: { limit: page.limit as number, nextCursor: page.nextCursor as string | null },
    indexer: parseIndexer(parsed.indexer),
  };
}
