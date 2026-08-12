export type DecimalInput = bigint | string;
export type HexAddress = `0x${string}`;
export type Hex32 = `0x${string}`;
export type HexData = `0x${string}`;

const UINT256_MAX = (BigInt(1) << BigInt(256)) - BigInt(1);
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export interface ChainBlockInput {
  number: DecimalInput;
  hash: string;
  parentHash: string;
  timestamp: string | Date;
}

export interface ChainLogInput {
  blockNumber: DecimalInput;
  transactionHash: string;
  transactionIndex: number;
  logIndex: number;
  contractAddress: string;
  topics: string[];
  data: string;
  eventName?: string;
  decodedArgs?: Record<string, unknown>;
}

export interface NormalizedChainBlock {
  number: string;
  hash: Hex32;
  parentHash: Hex32;
  timestamp: string;
}

export interface NormalizedChainLog {
  blockNumber: string;
  transactionHash: Hex32;
  transactionIndex: number;
  logIndex: number;
  contractAddress: HexAddress;
  topics: Hex32[];
  data: HexData;
  eventName: string | null;
  decodedArgs: Record<string, unknown> | null;
}

export interface EventSource {
  transactionHash: string;
  logIndex: number;
}

interface ProjectionBase extends EventSource {
  kind: string;
}

export interface LaunchProjection extends ProjectionBase {
  kind: "launch";
  tokenAddress: string;
  poolId: string;
  creatorAddress: string;
  configId: DecimalInput;
  firstBuyIn: DecimalInput;
  firstBuyOut: DecimalInput;
  hookAddress: string;
  feeRecipientAddress: string;
  feeMode: "creator" | "self-burn";
  name?: string;
  symbol?: string;
  description?: string;
  logoUri?: string;
  metadataUri?: string;
  socials?: Record<string, string>;
}

export interface SwapProjection extends ProjectionBase {
  kind: "swap";
  poolId: string;
  senderAddress: string;
  side: "buy" | "sell";
  amount0: DecimalInput;
  amount1: DecimalInput;
  sqrtPriceX96: DecimalInput;
  liquidity: DecimalInput;
  tick: number;
  feePips: number;
  pipedogAmount: DecimalInput;
  tokenAmount: DecimalInput;
}

export interface FeeProjection extends ProjectionBase {
  kind: "fee";
  feeKind:
    | "accrued"
    | "swept"
    | "creator-claimed"
    | "launch-fee"
    | "platform-deferred"
    | "platform-collected";
  poolId?: string;
  actorAddress?: string;
  creatorAddress?: string;
  recipientAddress?: string;
  amount?: DecimalInput;
  creatorAmount?: DecimalInput;
  platformAmount?: DecimalInput;
}

export interface BurnProjection extends ProjectionBase {
  kind: "burn";
  poolId: string;
  tokenAddress: string;
  pipedogIn: DecimalInput;
  tokensBurned: DecimalInput;
  pipedogBounty: DecimalInput;
}

export interface RevenueProjection extends ProjectionBase {
  kind: "revenue";
  routeKind: "allocated" | "sequestered" | "treasury" | "operations";
  callerAddress?: string;
  recipientAddress?: string;
  amount: DecimalInput;
  bounty?: DecimalInput;
  sequesterAmount?: DecimalInput;
  treasuryAmount?: DecimalInput;
  operationsAmount?: DecimalInput;
}

export interface TransferProjection extends ProjectionBase {
  kind: "transfer";
  tokenAddress: string;
  fromAddress: string;
  toAddress: string;
  amount: DecimalInput;
}

export interface AdminProjection extends ProjectionBase {
  kind: "admin";
  contractAddress: string;
  eventName: string;
  actorAddress?: string;
  subjectAddress?: string;
  details?: Record<string, unknown>;
}

export type IndexerProjection =
  | LaunchProjection
  | SwapProjection
  | FeeProjection
  | BurnProjection
  | RevenueProjection
  | TransferProjection
  | AdminProjection;

export interface CanonicalBatchInput {
  chainId: number;
  stream: string;
  expectedNextBlock: DecimalInput;
  blocks: ChainBlockInput[];
  logs: ChainLogInput[];
  projections?: IndexerProjection[];
}

export interface NormalizedCanonicalBatch {
  chainId: number;
  stream: string;
  expectedNextBlock: string;
  blocks: NormalizedChainBlock[];
  logs: NormalizedChainLog[];
  projections: IndexerProjection[];
}

export function normalizeUint256(value: DecimalInput, label = "value") {
  const normalized = typeof value === "bigint" ? value : parseInteger(value, label);
  if (normalized < BigInt(0) || normalized > UINT256_MAX) {
    throw new Error(`${label} is outside uint256 range.`);
  }
  return normalized.toString();
}

export function normalizeSignedInteger(value: DecimalInput, label = "value") {
  const normalized = typeof value === "bigint" ? value : parseInteger(value, label);
  return normalized.toString();
}

function parseInteger(value: string, label: string) {
  if (!/^-?(?:0|[1-9]\d*)$/.test(value)) {
    throw new Error(`${label} must be a canonical base-10 integer string.`);
  }
  return BigInt(value);
}

export function normalizeAddress(value: string, label = "address") {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new Error(`${label} is not a valid EVM address.`);
  }
  return value.toLowerCase() as HexAddress;
}

export function normalizeBytes32(value: string, label = "hash") {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`${label} is not 32-byte hex.`);
  }
  return value.toLowerCase() as Hex32;
}

export function normalizeHexData(value: string, label = "data") {
  if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(value)) {
    throw new Error(`${label} is not byte-aligned hex data.`);
  }
  return value.toLowerCase() as HexData;
}

function normalizeTimestamp(value: string | Date) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("Block timestamp is invalid.");
  return date.toISOString();
}

function assertSafeIndex(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 2_147_483_647) {
    throw new Error(`${label} is outside the Postgres integer range.`);
  }
  return value;
}

function normalizeStream(value: string) {
  const normalized = value.trim();
  if (!/^[a-z0-9][a-z0-9:_-]{0,63}$/i.test(normalized)) {
    throw new Error("Indexer stream name is invalid.");
  }
  return normalized;
}

export function normalizeCanonicalBatch(
  input: CanonicalBatchInput,
): NormalizedCanonicalBatch {
  if (!Number.isSafeInteger(input.chainId) || input.chainId <= 0) {
    throw new Error("Chain ID must be a positive safe integer.");
  }
  if (input.blocks.length === 0) throw new Error("Indexer batch cannot be empty.");

  const expectedNextBlock = normalizeUint256(
    input.expectedNextBlock,
    "Expected next block",
  );
  const blocks = input.blocks.map((block) => ({
    number: normalizeUint256(block.number, "Block number"),
    hash: normalizeBytes32(block.hash, "Block hash"),
    parentHash: normalizeBytes32(block.parentHash, "Parent hash"),
    timestamp: normalizeTimestamp(block.timestamp),
  }));

  if (blocks[0]!.number !== expectedNextBlock) {
    throw new Error("Batch does not begin at the expected cursor block.");
  }
  const blockNumbers = new Set<string>();
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index]!;
    if (blockNumbers.has(block.number)) throw new Error("Batch contains a duplicate block.");
    blockNumbers.add(block.number);
    if (index > 0) {
      const previous = blocks[index - 1]!;
      if (BigInt(block.number) !== BigInt(previous.number) + BigInt(1)) {
        throw new Error("Batch blocks are not contiguous.");
      }
      if (block.parentHash !== previous.hash) {
        throw new Error("Batch block parent hash does not match its predecessor.");
      }
    }
  }

  const eventKeys = new Set<string>();
  const logs = input.logs.map((log) => {
    const blockNumber = normalizeUint256(log.blockNumber, "Log block number");
    if (!blockNumbers.has(blockNumber)) {
      throw new Error("Log references a block outside its ingestion batch.");
    }
    const transactionHash = normalizeBytes32(log.transactionHash, "Transaction hash");
    const logIndex = assertSafeIndex(log.logIndex, "Log index");
    const key = `${transactionHash}:${logIndex}`;
    if (eventKeys.has(key)) throw new Error("Batch contains a duplicate chain event.");
    eventKeys.add(key);
    const decodedArgs = log.decodedArgs ? jsonSafe(log.decodedArgs) : null;
    return {
      blockNumber,
      transactionHash,
      transactionIndex: assertSafeIndex(log.transactionIndex, "Transaction index"),
      logIndex,
      contractAddress: normalizeAddress(log.contractAddress, "Log contract"),
      topics: log.topics.map((topic, index) =>
        normalizeBytes32(topic, `Topic ${index}`),
      ),
      data: normalizeHexData(log.data),
      eventName: log.eventName?.trim().slice(0, 128) || null,
      decodedArgs,
    };
  });

  const projections = input.projections ?? [];
  for (const projection of projections) {
    const key = `${normalizeBytes32(projection.transactionHash)}:${assertSafeIndex(
      projection.logIndex,
      "Projection log index",
    )}`;
    if (!eventKeys.has(key)) {
      throw new Error("Projection does not reference an event in its atomic batch.");
    }
  }

  return {
    chainId: input.chainId,
    stream: normalizeStream(input.stream),
    expectedNextBlock,
    blocks,
    logs,
    projections,
  };
}

export function jsonSafe<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value, (_key, entry) =>
      typeof entry === "bigint" ? entry.toString() : entry,
    ),
  ) as T;
}

export function isZeroAddress(value: string) {
  return normalizeAddress(value) === ZERO_ADDRESS;
}
