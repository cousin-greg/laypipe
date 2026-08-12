import {
  decodeAbiParameters,
  decodeEventLog,
  keccak256,
  parseAbi,
  toBytes,
  toEventSelector,
  toFunctionSelector,
  type Hex,
} from "viem";

import {
  normalizeAddress,
  normalizeBytes32,
  normalizeHexData,
  type AdminProjection,
  type BurnProjection,
  type ChainLogInput,
  type FeeProjection,
  type IndexerProjection,
  type LaunchProjection,
  type RevenueProjection,
  type SwapProjection,
  type TransferProjection,
} from "./model";

export const TOKEN_LAUNCHED_TOPIC = keccak256(
  toBytes("TokenLaunched(address,address,bytes32,uint256,uint256,uint256,address,address)"),
);
export const POOL_MANAGER_SWAP_TOPIC = keccak256(
  toBytes("Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)"),
);
export const ERC20_TRANSFER_TOPIC = keccak256(
  toBytes("Transfer(address,address,uint256)"),
);

const TOKEN_LAUNCHED_ABI = [
  {
    type: "event",
    name: "TokenLaunched",
    anonymous: false,
    inputs: [
      { name: "token", type: "address", indexed: true },
      { name: "creator", type: "address", indexed: true },
      { name: "poolId", type: "bytes32", indexed: true },
      { name: "configId", type: "uint256", indexed: false },
      { name: "firstBuyIn", type: "uint256", indexed: false },
      { name: "firstBuyOut", type: "uint256", indexed: false },
      { name: "hook", type: "address", indexed: false },
      { name: "feeRecipient", type: "address", indexed: false },
    ],
  },
] as const;

const POOL_MANAGER_SWAP_ABI = [
  {
    type: "event",
    name: "Swap",
    anonymous: false,
    inputs: [
      { name: "id", type: "bytes32", indexed: true },
      { name: "sender", type: "address", indexed: true },
      { name: "amount0", type: "int128", indexed: false },
      { name: "amount1", type: "int128", indexed: false },
      { name: "sqrtPriceX96", type: "uint160", indexed: false },
      { name: "liquidity", type: "uint128", indexed: false },
      { name: "tick", type: "int24", indexed: false },
      { name: "fee", type: "uint24", indexed: false },
    ],
  },
] as const;

const TRANSFER_ABI = [
  {
    type: "event",
    name: "Transfer",
    anonymous: false,
    inputs: [
      { name: "from", type: "address", indexed: true },
      { name: "to", type: "address", indexed: true },
      { name: "value", type: "uint256", indexed: false },
    ],
  },
] as const;

/**
 * These event lists intentionally contain only events that have a deterministic
 * projection in the production schema. Their signatures are covered against
 * the committed contract ABI bundle in tests, so a Solidity/ABI change cannot
 * silently drift the operational indexer.
 */
const FACTORY_OPERATIONAL_ABI = parseAbi([
  "event LaunchFeeRouted(address indexed treasury, uint256 amount)",
  "event DividendLaunchEnabledSet(bool enabled)",
  "event HookSet(address indexed oldHook, address indexed newHook)",
  "event Initialized(uint64 version)",
  "event LaunchConfigAdded(uint256 indexed configId, (uint256 supply, int24 tickSpacing, int24 startTick, uint16 creatorFeeBps, uint24 baseFeeRate, uint24 launchFeeRate, uint32 launchFeeDecay, bool enabled, bool selfBurn) config)",
  "event LaunchConfigEnabled(uint256 indexed configId, bool enabled)",
  "event LaunchEnabledSet(bool enabled)",
  "event LaunchFeeSet(uint256 oldFee, uint256 newFee)",
  "event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner)",
  "event OwnershipTransferred(address indexed previousOwner, address indexed newOwner)",
  "event SelfBurnerSet(address indexed oldBurner, address indexed newBurner)",
  "event Swept(address indexed asset, address indexed recipient, uint256 amount)",
  "event TokenImplementationSet(address indexed oldImplementation, address indexed newImplementation)",
  "event TreasurySet(address indexed oldTreasury, address indexed newTreasury)",
  "event Upgraded(address indexed implementation)",
]);

const HOOK_OPERATIONAL_ABI = parseAbi([
  "event FeeAccrued(bytes32 indexed poolId, uint256 amount)",
  "event FeesSwept(bytes32 indexed poolId, address indexed caller, uint256 creatorAmount, uint256 platformAmount)",
  "event CreatorFeesClaimed(bytes32 indexed poolId, address indexed creator, uint256 amount)",
  "event PlatformPayoutDeferred(uint256 amount)",
  "event PlatformPayoutCollected(address indexed treasury, uint256 amount)",
  "event CreatorUpdated(bytes32 indexed poolId, address indexed oldCreator, address indexed newCreator)",
  "event TreasuryUpdated(address indexed oldTreasury, address indexed newTreasury)",
  "event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner)",
  "event OwnershipTransferred(address indexed previousOwner, address indexed newOwner)",
]);

const SELF_BURN_OPERATIONAL_ABI = parseAbi([
  "event Burned(bytes32 indexed poolId, address indexed token, uint256 pipedogIn, uint256 tokensBurned, uint256 pipedogBounty)",
]);

const REVENUE_OPERATIONAL_ABI = parseAbi([
  "event RevenueAllocated(uint256 sequesterAmount, uint256 treasuryAmount, uint256 operationsAmount)",
  "event PipedogSequestered(address indexed caller, uint256 pipedogSequestered, uint256 bounty, address indexed sink)",
  "event TreasuryPipedogRouted(address indexed caller, address indexed treasury, uint256 pipedogRouted, uint256 bounty)",
  "event OperationsPipedogCollected(address indexed operationsWallet, uint256 amount)",
  "event TreasuryUpdated(address indexed oldTreasury, address indexed newTreasury)",
  "event OperationsWalletUpdated(address indexed oldWallet, address indexed newWallet)",
  "event MaxSequesterPerCallUpdated(uint256 oldCap, uint256 newCap)",
  "event MaxTreasuryRoutePerCallUpdated(uint256 oldCap, uint256 newCap)",
  "event Migrated(address indexed successor, uint256 amount)",
  "event TokenRecovered(address indexed token, address indexed recipient, uint256 amount)",
  "event NativeRecovered(address indexed recipient, uint256 amount)",
  "event Paused(address account)",
  "event Unpaused(address account)",
  "event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner)",
  "event OwnershipTransferred(address indexed previousOwner, address indexed newOwner)",
]);

function eventTopics(abi: readonly unknown[]) {
  return abi.map((event) => toEventSelector(event as Parameters<typeof toEventSelector>[0]));
}

export const FACTORY_OPERATIONAL_TOPICS = eventTopics(FACTORY_OPERATIONAL_ABI);
export const HOOK_OPERATIONAL_TOPICS = eventTopics(HOOK_OPERATIONAL_ABI);
export const SELF_BURN_OPERATIONAL_TOPICS = eventTopics(SELF_BURN_OPERATIONAL_ABI);
export const REVENUE_OPERATIONAL_TOPICS = eventTopics(REVENUE_OPERATIONAL_ABI);

export const INDEXED_OPERATIONAL_EVENT_ABIS = {
  factory: FACTORY_OPERATIONAL_ABI,
  hook: HOOK_OPERATIONAL_ABI,
  selfBurner: SELF_BURN_OPERATIONAL_ABI,
  revenueRouter: REVENUE_OPERATIONAL_ABI,
} as const;

export const INDEXED_OPERATIONAL_EVENT_NAMES = {
  factory: FACTORY_OPERATIONAL_ABI.map((event) => event.name),
  hook: HOOK_OPERATIONAL_ABI.map((event) => event.name),
  selfBurner: SELF_BURN_OPERATIONAL_ABI.map((event) => event.name),
  revenueRouter: REVENUE_OPERATIONAL_ABI.map((event) => event.name),
} as const;

export interface KnownLaunchEventIdentity {
  tokenAddress: `0x${string}`;
  poolId: `0x${string}`;
  feeMode: "creator" | "self-burn";
}

export interface DecodedLaunch {
  raw: ChainLogInput;
  tokenAddress: `0x${string}`;
  creatorAddress: `0x${string}`;
  poolId: `0x${string}`;
  configId: bigint;
  firstBuyIn: bigint;
  firstBuyOut: bigint;
  hookAddress: `0x${string}`;
  feeRecipientAddress: `0x${string}`;
}

function topics(value: readonly string[]) {
  if (value.length === 0) throw new Error("Indexed log has no event selector.");
  return value.map((topic, index) =>
    normalizeBytes32(topic, `Indexed topic ${index}`),
  ) as [Hex, ...Hex[]];
}

export function decodeTokenLaunched(log: ChainLogInput): DecodedLaunch {
  const decoded = decodeEventLog({
    abi: TOKEN_LAUNCHED_ABI,
    eventName: "TokenLaunched",
    topics: topics(log.topics),
    data: normalizeHexData(log.data) as Hex,
    strict: true,
  });
  const args = decoded.args;
  return {
    raw: {
      ...log,
      eventName: "TokenLaunched",
      decodedArgs: args,
    },
    tokenAddress: normalizeAddress(args.token, "Launched token"),
    creatorAddress: normalizeAddress(args.creator, "Launch creator"),
    poolId: normalizeBytes32(args.poolId, "Launch pool"),
    configId: args.configId,
    firstBuyIn: args.firstBuyIn,
    firstBuyOut: args.firstBuyOut,
    hookAddress: normalizeAddress(args.hook, "Launch hook"),
    feeRecipientAddress: normalizeAddress(args.feeRecipient, "Launch fee recipient"),
  };
}

export function launchProjection(
  value: DecodedLaunch,
  metadata: {
    feeMode: "creator" | "self-burn";
    name?: string;
    symbol?: string;
    description?: string;
    logoUri?: string;
    metadataUri?: string;
    socials?: Record<string, string>;
  },
): LaunchProjection {
  return {
    kind: "launch",
    transactionHash: value.raw.transactionHash,
    logIndex: value.raw.logIndex,
    tokenAddress: value.tokenAddress,
    poolId: value.poolId,
    creatorAddress: value.creatorAddress,
    configId: value.configId,
    firstBuyIn: value.firstBuyIn,
    firstBuyOut: value.firstBuyOut,
    hookAddress: value.hookAddress,
    feeRecipientAddress: value.feeRecipientAddress,
    ...metadata,
  };
}

export function decodePoolManagerSwap(
  log: ChainLogInput,
  launchedPools: ReadonlySet<string>,
): { raw: ChainLogInput; projection: SwapProjection } {
  const decoded = decodeEventLog({
    abi: POOL_MANAGER_SWAP_ABI,
    eventName: "Swap",
    topics: topics(log.topics),
    data: normalizeHexData(log.data) as Hex,
    strict: true,
  });
  const args = decoded.args;
  const poolId = normalizeBytes32(args.id, "Swap pool");
  if (!launchedPools.has(poolId)) {
    throw new Error("PoolManager returned a swap outside the LayPipe pool filter.");
  }
  // PoolManager emits Pool.swap's caller-style BalanceDelta directly. With
  // PIPEDOG as currency0, a buy spends currency0 (negative) and receives the
  // launched currency1 (positive); a sell is the inverse.
  const isBuy = args.amount0 < BigInt(0) && args.amount1 > BigInt(0);
  const isSell = args.amount0 > BigInt(0) && args.amount1 < BigInt(0);
  if (!isBuy && !isSell) {
    throw new Error("LayPipe swap does not exchange PIPEDOG and launch tokens.");
  }
  const raw: ChainLogInput = {
    ...log,
    eventName: "Swap",
    decodedArgs: args,
  };
  return {
    raw,
    projection: {
      kind: "swap",
      transactionHash: log.transactionHash,
      logIndex: log.logIndex,
      poolId,
      senderAddress: normalizeAddress(args.sender, "Swap sender"),
      side: isBuy ? "buy" : "sell",
      amount0: args.amount0,
      amount1: args.amount1,
      sqrtPriceX96: args.sqrtPriceX96,
      liquidity: args.liquidity,
      tick: args.tick,
      feePips: args.fee,
      pipedogAmount: args.amount0 < BigInt(0) ? -args.amount0 : args.amount0,
      tokenAmount: args.amount1 < BigInt(0) ? -args.amount1 : args.amount1,
    },
  };
}

export function decodeTokenTransfer(
  log: ChainLogInput,
  launchedTokens: ReadonlySet<string>,
): { raw: ChainLogInput; projection: TransferProjection } {
  const tokenAddress = normalizeAddress(log.contractAddress, "Transfer token");
  if (!launchedTokens.has(tokenAddress)) {
    throw new Error("RPC returned a transfer outside the LayPipe token filter.");
  }
  const decoded = decodeEventLog({
    abi: TRANSFER_ABI,
    eventName: "Transfer",
    topics: topics(log.topics),
    data: normalizeHexData(log.data) as Hex,
    strict: true,
  });
  const args = decoded.args;
  const raw: ChainLogInput = {
    ...log,
    eventName: "Transfer",
    decodedArgs: args,
  };
  return {
    raw,
    projection: {
      kind: "transfer",
      transactionHash: log.transactionHash,
      logIndex: log.logIndex,
      tokenAddress,
      fromAddress: normalizeAddress(args.from, "Transfer sender"),
      toAddress: normalizeAddress(args.to, "Transfer recipient"),
      amount: args.value,
    },
  };
}

function eventArgs(value: unknown, label: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} event arguments are invalid.`);
  }
  return value as Record<string, unknown>;
}

function uintArg(args: Record<string, unknown>, name: string) {
  const value = args[name];
  if (typeof value === "bigint" && value >= BigInt(0)) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return BigInt(value);
  }
  throw new Error(`${name} is not a decoded unsigned integer.`);
}

function signedArg(args: Record<string, unknown>, name: string) {
  const value = args[name];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error(`${name} is not a decoded signed integer.`);
  }
  return value;
}

function boolArg(args: Record<string, unknown>, name: string) {
  const value = args[name];
  if (typeof value !== "boolean") throw new Error(`${name} is not a decoded boolean.`);
  return value;
}

function addressArg(args: Record<string, unknown>, name: string) {
  return normalizeAddress(String(args[name]), name);
}

function bytes32Arg(args: Record<string, unknown>, name: string) {
  return normalizeBytes32(String(args[name]), name);
}

function rawOperationalEvent(
  log: ChainLogInput,
  eventName: string,
  args: Record<string, unknown>,
): ChainLogInput {
  return { ...log, eventName, decodedArgs: args };
}

function source(log: ChainLogInput) {
  return { transactionHash: log.transactionHash, logIndex: log.logIndex };
}

function adminProjection(
  log: ChainLogInput,
  eventName: string,
  options?: {
    actorAddress?: string;
    subjectAddress?: string;
    details?: Record<string, unknown>;
  },
): AdminProjection {
  return {
    kind: "admin",
    ...source(log),
    contractAddress: normalizeAddress(log.contractAddress, "Admin event contract"),
    eventName,
    ...options,
  };
}

function addressChangeAdmin(
  log: ChainLogInput,
  eventName: string,
  args: Record<string, unknown>,
  oldName: string,
  newName: string,
) {
  const oldAddress = addressArg(args, oldName);
  const newAddress = addressArg(args, newName);
  return adminProjection(log, eventName, {
    subjectAddress: newAddress,
    details: { [oldName]: oldAddress, [newName]: newAddress },
  });
}

function ownershipAdmin(
  log: ChainLogInput,
  eventName: string,
  args: Record<string, unknown>,
) {
  return addressChangeAdmin(
    log,
    eventName,
    args,
    "previousOwner",
    "newOwner",
  );
}

function knownPool(
  poolId: `0x${string}`,
  knownByPool: ReadonlyMap<string, KnownLaunchEventIdentity>,
) {
  const launch = knownByPool.get(poolId);
  if (!launch) throw new Error("Operational event references an unknown LayPipe pool.");
  return launch;
}

export function decodeFactoryOperationalEvent(log: ChainLogInput): {
  raw: ChainLogInput;
  projection: IndexerProjection;
} {
  const decoded = decodeEventLog({
    abi: FACTORY_OPERATIONAL_ABI,
    topics: topics(log.topics),
    data: normalizeHexData(log.data) as Hex,
    strict: true,
  });
  const args = eventArgs(decoded.args, decoded.eventName);
  const raw = rawOperationalEvent(log, decoded.eventName, args);
  let projection: IndexerProjection;

  switch (decoded.eventName) {
    case "LaunchFeeRouted":
      projection = {
        kind: "fee",
        ...source(log),
        feeKind: "launch-fee",
        recipientAddress: addressArg(args, "treasury"),
        amount: uintArg(args, "amount"),
      } satisfies FeeProjection;
      break;
    case "DividendLaunchEnabledSet":
    case "LaunchEnabledSet":
      projection = adminProjection(log, decoded.eventName, {
        details: { enabled: boolArg(args, "enabled") },
      });
      break;
    case "HookSet":
      projection = addressChangeAdmin(log, decoded.eventName, args, "oldHook", "newHook");
      break;
    case "Initialized":
      projection = adminProjection(log, decoded.eventName, {
        details: { version: uintArg(args, "version").toString() },
      });
      break;
    case "LaunchConfigAdded": {
      const config = eventArgs(args.config, "LaunchConfigAdded config");
      projection = adminProjection(log, decoded.eventName, {
        details: {
          configId: uintArg(args, "configId").toString(),
          config: {
            supply: uintArg(config, "supply").toString(),
            tickSpacing: signedArg(config, "tickSpacing").toString(),
            startTick: signedArg(config, "startTick").toString(),
            creatorFeeBps: uintArg(config, "creatorFeeBps").toString(),
            baseFeeRate: uintArg(config, "baseFeeRate").toString(),
            launchFeeRate: uintArg(config, "launchFeeRate").toString(),
            launchFeeDecay: uintArg(config, "launchFeeDecay").toString(),
            enabled: boolArg(config, "enabled"),
            selfBurn: boolArg(config, "selfBurn"),
          },
        },
      });
      break;
    }
    case "LaunchConfigEnabled":
      projection = adminProjection(log, decoded.eventName, {
        details: {
          configId: uintArg(args, "configId").toString(),
          enabled: boolArg(args, "enabled"),
        },
      });
      break;
    case "LaunchFeeSet":
      projection = adminProjection(log, decoded.eventName, {
        details: {
          oldFee: uintArg(args, "oldFee").toString(),
          newFee: uintArg(args, "newFee").toString(),
        },
      });
      break;
    case "OwnershipTransferStarted":
    case "OwnershipTransferred":
      projection = ownershipAdmin(log, decoded.eventName, args);
      break;
    case "SelfBurnerSet":
      projection = addressChangeAdmin(log, decoded.eventName, args, "oldBurner", "newBurner");
      break;
    case "Swept": {
      const recipientAddress = addressArg(args, "recipient");
      projection = adminProjection(log, decoded.eventName, {
        subjectAddress: recipientAddress,
        details: {
          asset: addressArg(args, "asset"),
          recipient: recipientAddress,
          amount: uintArg(args, "amount").toString(),
        },
      });
      break;
    }
    case "TokenImplementationSet":
      projection = addressChangeAdmin(
        log,
        decoded.eventName,
        args,
        "oldImplementation",
        "newImplementation",
      );
      break;
    case "TreasurySet":
      projection = addressChangeAdmin(log, decoded.eventName, args, "oldTreasury", "newTreasury");
      break;
    case "Upgraded": {
      const implementation = addressArg(args, "implementation");
      projection = adminProjection(log, decoded.eventName, {
        subjectAddress: implementation,
        details: { implementation },
      });
      break;
    }
    default:
      throw new Error("Factory event has no deterministic projection.");
  }
  return { raw, projection };
}

export function decodeHookOperationalEvent(
  log: ChainLogInput,
  knownByPool: ReadonlyMap<string, KnownLaunchEventIdentity>,
): { raw: ChainLogInput; projection: IndexerProjection } {
  const decoded = decodeEventLog({
    abi: HOOK_OPERATIONAL_ABI,
    topics: topics(log.topics),
    data: normalizeHexData(log.data) as Hex,
    strict: true,
  });
  const args = eventArgs(decoded.args, decoded.eventName);
  const raw = rawOperationalEvent(log, decoded.eventName, args);
  let projection: IndexerProjection;

  switch (decoded.eventName) {
    case "FeeAccrued": {
      const poolId = bytes32Arg(args, "poolId");
      knownPool(poolId, knownByPool);
      projection = {
        kind: "fee",
        ...source(log),
        feeKind: "accrued",
        poolId,
        amount: uintArg(args, "amount"),
      } satisfies FeeProjection;
      break;
    }
    case "FeesSwept": {
      const poolId = bytes32Arg(args, "poolId");
      knownPool(poolId, knownByPool);
      projection = {
        kind: "fee",
        ...source(log),
        feeKind: "swept",
        poolId,
        actorAddress: addressArg(args, "caller"),
        creatorAmount: uintArg(args, "creatorAmount"),
        platformAmount: uintArg(args, "platformAmount"),
      } satisfies FeeProjection;
      break;
    }
    case "CreatorFeesClaimed": {
      const poolId = bytes32Arg(args, "poolId");
      knownPool(poolId, knownByPool);
      const creator = addressArg(args, "creator");
      projection = {
        kind: "fee",
        ...source(log),
        feeKind: "creator-claimed",
        poolId,
        creatorAddress: creator,
        recipientAddress: creator,
        amount: uintArg(args, "amount"),
      } satisfies FeeProjection;
      break;
    }
    case "PlatformPayoutDeferred":
      projection = {
        kind: "fee",
        ...source(log),
        feeKind: "platform-deferred",
        amount: uintArg(args, "amount"),
      } satisfies FeeProjection;
      break;
    case "PlatformPayoutCollected":
      projection = {
        kind: "fee",
        ...source(log),
        feeKind: "platform-collected",
        recipientAddress: addressArg(args, "treasury"),
        amount: uintArg(args, "amount"),
      } satisfies FeeProjection;
      break;
    case "CreatorUpdated": {
      const poolId = bytes32Arg(args, "poolId");
      knownPool(poolId, knownByPool);
      const oldCreator = addressArg(args, "oldCreator");
      const newCreator = addressArg(args, "newCreator");
      projection = adminProjection(log, decoded.eventName, {
        subjectAddress: newCreator,
        details: { poolId, oldCreator, newCreator },
      });
      break;
    }
    case "TreasuryUpdated":
      projection = addressChangeAdmin(log, decoded.eventName, args, "oldTreasury", "newTreasury");
      break;
    case "OwnershipTransferStarted":
    case "OwnershipTransferred":
      projection = ownershipAdmin(log, decoded.eventName, args);
      break;
    default:
      throw new Error("Hook event has no deterministic projection.");
  }
  return { raw, projection };
}

export function decodeSelfBurnOperationalEvent(
  log: ChainLogInput,
  knownByPool: ReadonlyMap<string, KnownLaunchEventIdentity>,
): { raw: ChainLogInput; projection: BurnProjection } {
  const decoded = decodeEventLog({
    abi: SELF_BURN_OPERATIONAL_ABI,
    eventName: "Burned",
    topics: topics(log.topics),
    data: normalizeHexData(log.data) as Hex,
    strict: true,
  });
  const args = eventArgs(decoded.args, decoded.eventName);
  const poolId = bytes32Arg(args, "poolId");
  const launch = knownPool(poolId, knownByPool);
  const tokenAddress = addressArg(args, "token");
  if (launch.feeMode !== "self-burn" || launch.tokenAddress !== tokenAddress) {
    throw new Error("Burned event does not match its registered self-burn launch.");
  }
  return {
    raw: rawOperationalEvent(log, decoded.eventName, args),
    projection: {
      kind: "burn",
      ...source(log),
      poolId,
      tokenAddress,
      pipedogIn: uintArg(args, "pipedogIn"),
      tokensBurned: uintArg(args, "tokensBurned"),
      pipedogBounty: uintArg(args, "pipedogBounty"),
    },
  };
}

export function decodeRevenueOperationalEvent(log: ChainLogInput): {
  raw: ChainLogInput;
  projection: IndexerProjection;
} {
  const decoded = decodeEventLog({
    abi: REVENUE_OPERATIONAL_ABI,
    topics: topics(log.topics),
    data: normalizeHexData(log.data) as Hex,
    strict: true,
  });
  const args = eventArgs(decoded.args, decoded.eventName);
  const raw = rawOperationalEvent(log, decoded.eventName, args);
  let projection: IndexerProjection;

  switch (decoded.eventName) {
    case "RevenueAllocated": {
      const sequesterAmount = uintArg(args, "sequesterAmount");
      const treasuryAmount = uintArg(args, "treasuryAmount");
      const operationsAmount = uintArg(args, "operationsAmount");
      projection = {
        kind: "revenue",
        ...source(log),
        routeKind: "allocated",
        amount: sequesterAmount + treasuryAmount + operationsAmount,
        sequesterAmount,
        treasuryAmount,
        operationsAmount,
      } satisfies RevenueProjection;
      break;
    }
    case "PipedogSequestered":
      projection = {
        kind: "revenue",
        ...source(log),
        routeKind: "sequestered",
        callerAddress: addressArg(args, "caller"),
        recipientAddress: addressArg(args, "sink"),
        amount: uintArg(args, "pipedogSequestered"),
        bounty: uintArg(args, "bounty"),
      } satisfies RevenueProjection;
      break;
    case "TreasuryPipedogRouted":
      projection = {
        kind: "revenue",
        ...source(log),
        routeKind: "treasury",
        callerAddress: addressArg(args, "caller"),
        recipientAddress: addressArg(args, "treasury"),
        amount: uintArg(args, "pipedogRouted"),
        bounty: uintArg(args, "bounty"),
      } satisfies RevenueProjection;
      break;
    case "OperationsPipedogCollected":
      projection = {
        kind: "revenue",
        ...source(log),
        routeKind: "operations",
        recipientAddress: addressArg(args, "operationsWallet"),
        amount: uintArg(args, "amount"),
      } satisfies RevenueProjection;
      break;
    case "TreasuryUpdated":
      projection = addressChangeAdmin(log, decoded.eventName, args, "oldTreasury", "newTreasury");
      break;
    case "OperationsWalletUpdated":
      projection = addressChangeAdmin(log, decoded.eventName, args, "oldWallet", "newWallet");
      break;
    case "MaxSequesterPerCallUpdated":
    case "MaxTreasuryRoutePerCallUpdated":
      projection = adminProjection(log, decoded.eventName, {
        details: {
          oldCap: uintArg(args, "oldCap").toString(),
          newCap: uintArg(args, "newCap").toString(),
        },
      });
      break;
    case "Migrated": {
      const successor = addressArg(args, "successor");
      projection = adminProjection(log, decoded.eventName, {
        subjectAddress: successor,
        details: { successor, amount: uintArg(args, "amount").toString() },
      });
      break;
    }
    case "TokenRecovered": {
      const recipientAddress = addressArg(args, "recipient");
      projection = adminProjection(log, decoded.eventName, {
        subjectAddress: recipientAddress,
        details: {
          token: addressArg(args, "token"),
          recipient: recipientAddress,
          amount: uintArg(args, "amount").toString(),
        },
      });
      break;
    }
    case "NativeRecovered": {
      const recipientAddress = addressArg(args, "recipient");
      projection = adminProjection(log, decoded.eventName, {
        subjectAddress: recipientAddress,
        details: { recipient: recipientAddress, amount: uintArg(args, "amount").toString() },
      });
      break;
    }
    case "Paused":
    case "Unpaused": {
      const actorAddress = addressArg(args, "account");
      projection = adminProjection(log, decoded.eventName, {
        actorAddress,
        details: { account: actorAddress },
      });
      break;
    }
    case "OwnershipTransferStarted":
    case "OwnershipTransferred":
      projection = ownershipAdmin(log, decoded.eventName, args);
      break;
    default:
      throw new Error("Revenue-router event has no deterministic projection.");
  }
  return { raw, projection };
}

export const TOKEN_READ_SELECTORS = {
  factory: toFunctionSelector("factory()"),
  poolId: toFunctionSelector("poolId()"),
  hook: toFunctionSelector("hook()"),
  deployer: toFunctionSelector("deployer()"),
  name: toFunctionSelector("name()"),
  symbol: toFunctionSelector("symbol()"),
  logo: toFunctionSelector("logo()"),
  description: toFunctionSelector("description()"),
  tokenURI: toFunctionSelector("tokenURI()"),
  socials: toFunctionSelector("socials()"),
} as const;

export function decodeAddressCall(value: string, label: string) {
  const [decoded] = decodeAbiParameters([{ type: "address" }], normalizeHexData(value) as Hex);
  return normalizeAddress(decoded, label);
}

export function decodeBytes32Call(value: string, label: string) {
  const [decoded] = decodeAbiParameters([{ type: "bytes32" }], normalizeHexData(value) as Hex);
  return normalizeBytes32(decoded, label);
}

export function decodeStringCall(value: string) {
  const [decoded] = decodeAbiParameters([{ type: "string" }], normalizeHexData(value) as Hex);
  return decoded;
}

export function decodeSocialsCall(value: string) {
  const [decoded] = decodeAbiParameters(
    [
      {
        type: "tuple",
        components: [
          { name: "telegram", type: "string" },
          { name: "twitter", type: "string" },
          { name: "discord", type: "string" },
          { name: "website", type: "string" },
          { name: "extra", type: "string" },
        ],
      },
    ],
    normalizeHexData(value) as Hex,
  );
  return decoded;
}
