import type { IndexerWatermark } from "../market/live";
import { isAddress, isTransactionHash, type Address, type Hex } from "../web3/types";

export type IndexedKeeperActionKind = "sweep" | "sequester" | "treasury";

export interface KeeperRewardAccounting {
  totalBountyPipedog: string;
  sequesterBountyPipedog: string;
  treasuryBountyPipedog: string;
  sequesterCalls: string;
  treasuryCalls: string;
  sweepCalls: string;
}

export interface IndexedKeeperAction {
  kind: IndexedKeeperActionKind;
  transactionHash: Hex;
  blockNumber: string;
  blockTimestamp: string;
  processedPipedog: string;
  routedPipedog: string;
  bountyPipedog: string;
  poolId: Hex | null;
}

export interface KeeperSweepCandidate {
  poolId: Hex;
  tokenAddress: Address;
  name: string | null;
  symbol: string | null;
  indexedPendingPipedog: string;
}

export interface KeeperRewardsResponse {
  source: "live";
  chainId: 4663;
  wallet: Address;
  asOfBlock: string;
  accounting: KeeperRewardAccounting;
  recentActions: IndexedKeeperAction[];
  sweepCandidates: KeeperSweepCandidate[];
  eligibility: {
    status: "wallet-verification-required";
    reason: string;
  };
  indexer: IndexerWatermark;
}

export interface KeeperApiError {
  error: {
    code: "invalid_request" | "rate_limited" | "keeper_data_unavailable";
    message: string;
  };
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Keeper API returned malformed data.");
  }
  return value as Record<string, unknown>;
}

function uintText(value: unknown) {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)$/.test(value)) {
    throw new Error("Keeper API returned a malformed amount.");
  }
  return value;
}

function address(value: unknown): Address {
  if (typeof value !== "string" || !isAddress(value)) {
    throw new Error("Keeper API returned a malformed address.");
  }
  return value;
}

function bytes32(value: unknown): Hex {
  if (typeof value !== "string" || !isTransactionHash(value)) {
    throw new Error("Keeper API returned malformed 32-byte data.");
  }
  return value;
}

function nullableText(value: unknown) {
  if (value !== null && typeof value !== "string") {
    throw new Error("Keeper API returned malformed token metadata.");
  }
  return value as string | null;
}

function timestamp(value: unknown) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error("Keeper API returned a malformed timestamp.");
  }
  return value;
}

function parseIndexer(value: unknown): IndexerWatermark {
  const parsed = record(value);
  const nullableUint = (entry: unknown) => entry === null ? null : uintText(entry);
  const nullableBytes32 = (entry: unknown) => entry === null ? null : bytes32(entry);
  const nullableTimestamp = (entry: unknown) => entry === null ? null : timestamp(entry);
  if (
    typeof parsed.stream !== "string" ||
    (parsed.lastRunStatus !== null &&
      parsed.lastRunStatus !== "caught-up" &&
      parsed.lastRunStatus !== "bounded" &&
      parsed.lastRunStatus !== "deadline")
  ) {
    throw new Error("Keeper API returned a malformed indexer watermark.");
  }
  return {
    stream: parsed.stream,
    nextBlock: uintText(parsed.nextBlock),
    lastProcessedBlock: nullableUint(parsed.lastProcessedBlock),
    lastProcessedHash: nullableBytes32(parsed.lastProcessedHash),
    observedSafeHead: nullableUint(parsed.observedSafeHead),
    observedAt: nullableTimestamp(parsed.observedAt),
    lastRunStatus: parsed.lastRunStatus,
    updatedAt: timestamp(parsed.updatedAt),
  };
}

/** Strictly parse the untrusted keeper HTTP boundary before values reach React. */
export function parseKeeperRewardsResponse(
  value: unknown,
  expectedWallet: Address,
): KeeperRewardsResponse {
  const parsed = record(value);
  const wallet = address(parsed.wallet);
  if (
    parsed.source !== "live" ||
    parsed.chainId !== 4_663 ||
    wallet.toLowerCase() !== expectedWallet.toLowerCase() ||
    !Array.isArray(parsed.recentActions) ||
    parsed.recentActions.length > 20 ||
    !Array.isArray(parsed.sweepCandidates) ||
    parsed.sweepCandidates.length > 20
  ) {
    throw new Error("Keeper API response does not match the connected wallet.");
  }

  const rawAccounting = record(parsed.accounting);
  const accounting: KeeperRewardAccounting = {
    totalBountyPipedog: uintText(rawAccounting.totalBountyPipedog),
    sequesterBountyPipedog: uintText(rawAccounting.sequesterBountyPipedog),
    treasuryBountyPipedog: uintText(rawAccounting.treasuryBountyPipedog),
    sequesterCalls: uintText(rawAccounting.sequesterCalls),
    treasuryCalls: uintText(rawAccounting.treasuryCalls),
    sweepCalls: uintText(rawAccounting.sweepCalls),
  };
  if (
    BigInt(accounting.totalBountyPipedog) !==
    BigInt(accounting.sequesterBountyPipedog) + BigInt(accounting.treasuryBountyPipedog)
  ) {
    throw new Error("Keeper API returned inconsistent bounty accounting.");
  }

  const recentActions = parsed.recentActions.map((entry): IndexedKeeperAction => {
    const action = record(entry);
    if (
      action.kind !== "sweep" &&
      action.kind !== "sequester" &&
      action.kind !== "treasury"
    ) {
      throw new Error("Keeper API returned an unsupported action kind.");
    }
    const poolId = action.poolId === null ? null : bytes32(action.poolId);
    if ((action.kind === "sweep") !== (poolId !== null)) {
      throw new Error("Keeper API returned an inconsistent action pool.");
    }
    const bountyPipedog = uintText(action.bountyPipedog);
    const processedPipedog = uintText(action.processedPipedog);
    const routedPipedog = uintText(action.routedPipedog);
    if (action.kind === "sweep" && bountyPipedog !== "0") {
      throw new Error("Keeper API attributed a bounty to a zero-bounty sweep.");
    }
    if (
      BigInt(processedPipedog) !==
      BigInt(routedPipedog) + BigInt(bountyPipedog)
    ) {
      throw new Error("Keeper API returned inconsistent processed and routed amounts.");
    }
    return {
      kind: action.kind,
      transactionHash: bytes32(action.transactionHash),
      blockNumber: uintText(action.blockNumber),
      blockTimestamp: timestamp(action.blockTimestamp),
      processedPipedog,
      routedPipedog,
      bountyPipedog,
      poolId,
    };
  });

  const sweepCandidates = parsed.sweepCandidates.map((entry): KeeperSweepCandidate => {
    const candidate = record(entry);
    const indexedPendingPipedog = uintText(candidate.indexedPendingPipedog);
    if (BigInt(indexedPendingPipedog) === BigInt(0)) {
      throw new Error("Keeper API returned a zero-value sweep candidate.");
    }
    return {
      poolId: bytes32(candidate.poolId),
      tokenAddress: address(candidate.tokenAddress),
      name: nullableText(candidate.name),
      symbol: nullableText(candidate.symbol),
      indexedPendingPipedog,
    };
  });

  const eligibility = record(parsed.eligibility);
  if (
    eligibility.status !== "wallet-verification-required" ||
    typeof eligibility.reason !== "string" ||
    eligibility.reason.length < 1
  ) {
    throw new Error("Keeper API returned malformed eligibility status.");
  }

  return {
    source: "live",
    chainId: 4_663,
    wallet,
    asOfBlock: uintText(parsed.asOfBlock),
    accounting,
    recentActions,
    sweepCandidates,
    eligibility: {
      status: "wallet-verification-required",
      reason: eligibility.reason,
    },
    indexer: parseIndexer(parsed.indexer),
  };
}
