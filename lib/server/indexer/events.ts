import {
  decodeAbiParameters,
  decodeEventLog,
  keccak256,
  toBytes,
  toFunctionSelector,
  type Hex,
} from "viem";

import {
  normalizeAddress,
  normalizeBytes32,
  normalizeHexData,
  type ChainLogInput,
  type LaunchProjection,
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
