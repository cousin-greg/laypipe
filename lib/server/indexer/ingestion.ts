import { type Hex } from "viem";

import {
  assertAuditedIndexerDeployment,
  parseRobinhoodProductionManifest,
  type AuditedDeploymentManifest,
  type PublicDeploymentEnvironment,
} from "../../web3/deployment-manifest";
import type { Eip1193Provider } from "../../web3/types";
import {
  decodeAddressCall,
  decodeBytes32Call,
  decodeFactoryOperationalEvent,
  decodeHookOperationalEvent,
  decodePoolManagerSwap,
  decodeRevenueOperationalEvent,
  decodeSelfBurnOperationalEvent,
  decodeSocialsCall,
  decodeStringCall,
  decodeTokenLaunched,
  decodeTokenTransfer,
  ERC20_TRANSFER_TOPIC,
  FACTORY_OPERATIONAL_TOPICS,
  HOOK_OPERATIONAL_TOPICS,
  launchProjection,
  POOL_MANAGER_SWAP_TOPIC,
  REVENUE_OPERATIONAL_TOPICS,
  SELF_BURN_OPERATIONAL_TOPICS,
  TOKEN_LAUNCHED_TOPIC,
  TOKEN_READ_SELECTORS,
  type DecodedLaunch,
  type KnownLaunchEventIdentity,
} from "./events";
import {
  normalizeAddress,
  normalizeBytes32,
  normalizeHexData,
  normalizeUint256,
  type ChainBlockInput,
  type ChainLogInput,
  type IndexerProjection,
} from "./model";
import {
  ingestCanonicalBatch,
  initializeIndexerCursor,
  loadIndexedLaunchIdentities,
  loadRecentStoredBlocks,
  recordIndexerObservation,
  readIndexerHealth,
  rollbackChainTo,
} from "./repository";
import { findCommonAncestor } from "./reorg";
import { createHttpIndexerRpc } from "./rpc";

const STREAM = "laypipe";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const LAYPIPE_TOKEN_SUFFIX = "cc";
// A batch already in flight can consume the ten-second database write deadline,
// and publishing a caught-up observation can consume another ten seconds while
// refreshing the global leader projection. Keep two more seconds for response
// serialization and lease release inside the 60-second Vercel route.
export const INDEXER_FINALIZATION_RESERVE_MS = 22_000;

export interface IndexerRuntimeConfig {
  finalityBlocks: number;
  batchSize: number;
  maxBatchesPerRun: number;
  maxLogs: number;
  maxNewLaunches: number;
  filterChunkSize: number;
  maxFilterChunks: number;
  reorgLookback: number;
  runTimeoutMs: number;
}

export type IndexedLaunchIdentity = KnownLaunchEventIdentity;

export interface IndexerRepository {
  initializeCursor(options: {
    chainId: number;
    stream: string;
    startBlock: bigint | string;
  }): Promise<void>;
  readHealth(chainId: number, stream: string): Promise<Record<string, unknown> | null>;
  loadLaunches(options: {
    chainId: number;
    limit: number;
  }): Promise<IndexedLaunchIdentity[]>;
  loadRecentBlocks(options: {
    chainId: number;
    atOrBelow: bigint | string;
    limit?: number;
  }): Promise<Array<{ number: string; hash: `0x${string}` }>>;
  rollback(options: {
    chainId: number;
    ancestorBlock: bigint | string;
    ancestorHash: string;
  }): Promise<bigint>;
  ingest(input: Parameters<typeof ingestCanonicalBatch>[0]): Promise<{
    chainId: number;
    firstBlock: string;
    lastBlock: string;
    blockCount: number;
    eventCount: number;
    projectionCount: number;
  }>;
}

const productionRepository: IndexerRepository = {
  initializeCursor: initializeIndexerCursor,
  readHealth: readIndexerHealth,
  loadLaunches: loadIndexedLaunchIdentities,
  loadRecentBlocks: loadRecentStoredBlocks,
  rollback: rollbackChainTo,
  ingest: ingestCanonicalBatch,
};

function integerSetting(
  value: string | undefined,
  label: string,
  minimum: number,
  maximum: number,
  fallback?: number,
) {
  const candidate = value?.trim() || (fallback === undefined ? "" : String(fallback));
  if (!/^\d+$/.test(candidate)) throw new Error(`${label} must be configured.`);
  const parsed = Number(candidate);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}.`);
  }
  return parsed;
}

export function readIndexerRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env,
): IndexerRuntimeConfig {
  if (env.INDEXER_ENABLED !== "true") {
    throw new Error("INDEXER_ENABLED must be true before canonical ingestion can run.");
  }
  return {
    finalityBlocks: integerSetting(
      env.INDEXER_FINALITY_BLOCKS,
      "INDEXER_FINALITY_BLOCKS",
      1,
      10_000,
    ),
    // Ten blocks also works on Alchemy's Robinhood free tier. PAYG operators
    // can raise this deliberately after exercising response-size limits.
    batchSize: integerSetting(
      env.INDEXER_BATCH_SIZE,
      "INDEXER_BATCH_SIZE",
      1,
      100,
      10,
    ),
    maxBatchesPerRun: integerSetting(
      env.INDEXER_MAX_BATCHES_PER_RUN,
      "INDEXER_MAX_BATCHES_PER_RUN",
      1,
      100,
      25,
    ),
    maxLogs: integerSetting(env.INDEXER_MAX_LOGS, "INDEXER_MAX_LOGS", 100, 20_000, 5_000),
    maxNewLaunches: integerSetting(
      env.INDEXER_MAX_NEW_LAUNCHES,
      "INDEXER_MAX_NEW_LAUNCHES",
      1,
      100,
      25,
    ),
    filterChunkSize: integerSetting(
      env.INDEXER_FILTER_CHUNK_SIZE,
      "INDEXER_FILTER_CHUNK_SIZE",
      1,
      200,
      100,
    ),
    maxFilterChunks: integerSetting(
      env.INDEXER_MAX_FILTER_CHUNKS,
      "INDEXER_MAX_FILTER_CHUNKS",
      1,
      100,
      25,
    ),
    reorgLookback: integerSetting(
      env.INDEXER_REORG_LOOKBACK,
      "INDEXER_REORG_LOOKBACK",
      2,
      2_048,
      128,
    ),
    runTimeoutMs: integerSetting(
      env.INDEXER_RUN_TIMEOUT_MS,
      "INDEXER_RUN_TIMEOUT_MS",
      5_000,
      55_000,
      45_000,
    ),
  };
}

function catchupManifest(
  env: NodeJS.ProcessEnv,
  override?: AuditedDeploymentManifest,
) {
  return override ?? parseRobinhoodProductionManifest(env as PublicDeploymentEnvironment);
}

function quantity(value: unknown, label: string) {
  if (typeof value !== "string" || !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(value)) {
    throw new Error(`${label} is not a canonical RPC quantity.`);
  }
  return BigInt(value);
}

function safeIndex(value: unknown, label: string) {
  const parsed = quantity(value, label);
  if (parsed > BigInt(2_147_483_647)) throw new Error(`${label} exceeds the database range.`);
  return Number(parsed);
}

function blockTag(value: bigint) {
  if (value < BigInt(0)) throw new Error("Block tag cannot be negative.");
  return `0x${value.toString(16)}` as Hex;
}

interface RpcBlock {
  number?: unknown;
  hash?: unknown;
  parentHash?: unknown;
  timestamp?: unknown;
}

async function loadRpcBlock(
  rpc: Eip1193Provider,
  number: bigint | "latest",
  allowMissing = false,
) {
  const requested = number === "latest" ? "latest" : blockTag(number);
  const value = await rpc.request<unknown>({
    method: "eth_getBlockByNumber",
    params: [requested, false],
  });
  if (value === null && allowMissing) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Robinhood RPC returned an invalid block.");
  }
  const raw = value as RpcBlock;
  const parsedNumber = quantity(raw.number, "RPC block number");
  if (number !== "latest" && parsedNumber !== number) {
    throw new Error("Robinhood RPC returned the wrong block height.");
  }
  const timestamp = quantity(raw.timestamp, "RPC block timestamp");
  const milliseconds = timestamp * BigInt(1_000);
  if (milliseconds > BigInt(8_640_000_000_000_000)) {
    throw new Error("RPC block timestamp is outside the supported date range.");
  }
  return {
    number: parsedNumber,
    hash: normalizeBytes32(String(raw.hash), "RPC block hash"),
    parentHash: normalizeBytes32(String(raw.parentHash), "RPC parent hash"),
    timestamp: new Date(Number(milliseconds)).toISOString(),
  };
}

function chunks<T>(values: readonly T[], size: number) {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

async function mapConcurrent<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<R>,
) {
  const result = new Array<R>(values.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (next < values.length) {
        const index = next++;
        result[index] = await mapper(values[index]!, index);
      }
    }),
  );
  return result;
}

async function queryLogs(
  rpc: Eip1193Provider,
  filter: Record<string, unknown>,
  perQueryLimit: number,
) {
  const value = await rpc.request<unknown>({ method: "eth_getLogs", params: [filter] });
  if (!Array.isArray(value)) {
    throw new Error("Robinhood RPC returned an invalid log result.");
  }
  if (value.length >= perQueryLimit) {
    throw new Error(
      "Robinhood RPC log result reached its configured bound and may be truncated.",
    );
  }
  return value;
}

function parseRpcLog(
  value: unknown,
  allowedAddresses: ReadonlySet<string>,
  blocks: ReadonlyMap<string, { hash: `0x${string}` }>,
): ChainLogInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Robinhood RPC returned an invalid log.");
  }
  const log = value as Record<string, unknown>;
  if (log.removed === true) throw new Error("Robinhood RPC returned a removed log.");
  const contractAddress = normalizeAddress(String(log.address), "RPC log address");
  if (!allowedAddresses.has(contractAddress)) {
    throw new Error("Robinhood RPC log address escaped its filter.");
  }
  const number = quantity(log.blockNumber, "RPC log block number");
  const block = blocks.get(number.toString());
  if (!block || normalizeBytes32(String(log.blockHash), "RPC log block hash") !== block.hash) {
    throw new Error("RPC log does not match the canonical block window.");
  }
  if (!Array.isArray(log.topics) || log.topics.length < 1 || log.topics.length > 4) {
    throw new Error("RPC log topics are invalid.");
  }
  return {
    blockNumber: number,
    transactionHash: normalizeBytes32(String(log.transactionHash), "RPC log transaction"),
    transactionIndex: safeIndex(log.transactionIndex, "RPC transaction index"),
    logIndex: safeIndex(log.logIndex, "RPC log index"),
    contractAddress,
    topics: log.topics.map((topic, index) =>
      normalizeBytes32(String(topic), `RPC log topic ${index}`),
    ),
    data: normalizeHexData(String(log.data), "RPC log data"),
  };
}

function cursor(row: Record<string, unknown>, deploymentBlock: bigint) {
  const start = BigInt(normalizeUint256(String(row.start_block), "Cursor start"));
  if (start !== deploymentBlock) throw new Error("Indexer cursor start does not match deployment block.");
  const next = BigInt(normalizeUint256(String(row.next_block), "Cursor next block"));
  const hasLastBlock = row.last_processed_block !== null && row.last_processed_block !== undefined;
  const hasLastHash = row.last_processed_hash !== null && row.last_processed_hash !== undefined;
  if (hasLastBlock !== hasLastHash) throw new Error("Indexer cursor is internally inconsistent.");
  return {
    next,
    lastBlock: hasLastBlock
      ? BigInt(normalizeUint256(String(row.last_processed_block), "Cursor last block"))
      : null,
    lastHash: hasLastHash
      ? normalizeBytes32(String(row.last_processed_hash), "Cursor last hash")
      : null,
  };
}

async function readOrInitializeCursor(options: {
  repository: IndexerRepository;
  chainId: number;
  deploymentBlock: bigint;
}) {
  let row = await options.repository.readHealth(options.chainId, STREAM);
  if (!row) {
    await options.repository.initializeCursor({
      chainId: options.chainId,
      stream: STREAM,
      startBlock: options.deploymentBlock,
    });
    row = await options.repository.readHealth(options.chainId, STREAM);
  }
  if (!row) throw new Error("Indexer cursor initialization did not persist.");
  return cursor(row, options.deploymentBlock);
}

async function repairReorg(options: {
  rpc: Eip1193Provider;
  repository: IndexerRepository;
  chainId: number;
  deploymentBlock: bigint;
  reorgLookback: number;
  state: ReturnType<typeof cursor>;
}) {
  if (options.state.lastBlock === null || options.state.lastHash === null) {
    return { state: options.state, rolledBackBlocks: BigInt(0) };
  }
  const canonical = await loadRpcBlock(options.rpc, options.state.lastBlock, true);
  if (canonical?.hash === options.state.lastHash) {
    return { state: options.state, rolledBackBlocks: BigInt(0) };
  }
  const stored = await options.repository.loadRecentBlocks({
    chainId: options.chainId,
    atOrBelow: options.state.lastBlock,
    limit: options.reorgLookback,
  });
  const ancestor = await findCommonAncestor(stored, async (number) => {
    const block = await loadRpcBlock(options.rpc, BigInt(number), true);
    return block?.hash ?? null;
  });
  if (!ancestor) {
    throw new Error("No canonical ancestor exists inside the bounded reorg window.");
  }
  const rolledBackBlocks = await options.repository.rollback({
    chainId: options.chainId,
    ancestorBlock: ancestor.number,
    ancestorHash: ancestor.hash,
  });
  return {
    state: await readOrInitializeCursor(options),
    rolledBackBlocks,
  };
}

export async function verifyIndexerManifestIdentity(options: {
  rpc: Eip1193Provider;
  manifest: AuditedDeploymentManifest;
  atBlock: bigint;
}) {
  // Reuse the complete snapshot preflight so the indexer cannot drift to a
  // weaker definition of the audited manifest. Its sole read-only exception
  // is the globally paused launch switch used during staged backfill. Override
  // only blockNumber to pin every check to this finalized canonical block.
  const pinnedProvider: Eip1193Provider = {
    request<T = unknown>(args: Parameters<Eip1193Provider["request"]>[0]) {
      if (args.method === "eth_blockNumber") {
        return Promise.resolve(blockTag(options.atBlock) as T);
      }
      return options.rpc.request<T>(args);
    },
  };
  const verified = await assertAuditedIndexerDeployment(pinnedProvider, options.manifest);
  if (verified.blockNumber !== options.atBlock) {
    throw new Error("Audited deployment preflight did not use the finalized block.");
  }
}

async function tokenCall(
  rpc: Eip1193Provider,
  token: string,
  selector: string,
  atBlock: bigint,
) {
  return normalizeHexData(
    String(
      await rpc.request<unknown>({
        method: "eth_call",
        params: [{ to: token, data: selector }, blockTag(atBlock)],
      }),
    ),
    "Token call result",
  );
}

function optionalText(value: string, maxLength: number) {
  const trimmed = value.trim();
  return trimmed && trimmed.length <= maxLength ? trimmed : undefined;
}

async function loadLaunchMetadata(options: {
  rpc: Eip1193Provider;
  launch: DecodedLaunch;
  manifest: AuditedDeploymentManifest;
  atBlock: bigint;
}) {
  const { rpc, launch, manifest, atBlock } = options;
  const tokenRuntime = normalizeHexData(
    String(
      await rpc.request<unknown>({
        method: "eth_getCode",
        params: [launch.tokenAddress, blockTag(atBlock)],
      }),
    ),
    "Launched token runtime code",
  );
  const expectedCloneRuntime =
    `0x363d3d373d3d3d363d73${manifest.contracts.tokenImplementation.address
      .slice(2)
      .toLowerCase()}5af43d82803e903d91602b57fd5bf3`;
  if (tokenRuntime !== expectedCloneRuntime) {
    throw new Error("Launched token is not the audited LayPipe implementation clone.");
  }
  const [factory, poolId, hook, deployer] = await Promise.all([
    tokenCall(rpc, launch.tokenAddress, TOKEN_READ_SELECTORS.factory, atBlock).then((value) =>
      decodeAddressCall(value, "Token factory"),
    ),
    tokenCall(rpc, launch.tokenAddress, TOKEN_READ_SELECTORS.poolId, atBlock).then((value) =>
      decodeBytes32Call(value, "Token pool"),
    ),
    tokenCall(rpc, launch.tokenAddress, TOKEN_READ_SELECTORS.hook, atBlock).then((value) =>
      decodeAddressCall(value, "Token hook"),
    ),
    tokenCall(rpc, launch.tokenAddress, TOKEN_READ_SELECTORS.deployer, atBlock).then((value) =>
      decodeAddressCall(value, "Token deployer"),
    ),
  ]);
  if (
    factory !== manifest.contracts.factoryProxy.address.toLowerCase() ||
    poolId !== launch.poolId ||
    hook !== manifest.contracts.hook.address.toLowerCase() ||
    deployer !== launch.creatorAddress
  ) {
    throw new Error("Launched token bindings do not match the audited manifest event.");
  }

  const readText = async (selector: string, maxLength: number) => {
    return optionalText(
      decodeStringCall(await tokenCall(rpc, launch.tokenAddress, selector, atBlock)),
      maxLength,
    );
  };
  const [name, symbol, logoUri, description, metadataUri, socials] = await Promise.all([
    readText(TOKEN_READ_SELECTORS.name, 128),
    readText(TOKEN_READ_SELECTORS.symbol, 32),
    readText(TOKEN_READ_SELECTORS.logo, 2_048),
    readText(TOKEN_READ_SELECTORS.description, 4_096),
    readText(TOKEN_READ_SELECTORS.tokenURI, 2_048),
    tokenCall(rpc, launch.tokenAddress, TOKEN_READ_SELECTORS.socials, atBlock)
      .then(decodeSocialsCall)
      .then((value) =>
        Object.fromEntries(
          Object.entries(value)
            .map(([key, entry]) => [key, optionalText(entry, 2_048)] as const)
            .filter((entry): entry is readonly [string, string] => Boolean(entry[1])),
        ),
      ),
  ]);
  return {
    ...(name ? { name } : {}),
    ...(symbol ? { symbol } : {}),
    ...(logoUri ? { logoUri } : {}),
    ...(description ? { description } : {}),
    ...(metadataUri ? { metadataUri } : {}),
    ...(socials && Object.keys(socials).length > 0 ? { socials } : {}),
  };
}

function classifyLaunch(
  launch: DecodedLaunch,
  manifest: AuditedDeploymentManifest,
): "creator" | "self-burn" {
  if (launch.hookAddress !== manifest.contracts.hook.address.toLowerCase()) {
    throw new Error("TokenLaunched hook does not match the audited manifest.");
  }
  if (
    launch.tokenAddress === ZERO_ADDRESS ||
    !launch.tokenAddress.endsWith(LAYPIPE_TOKEN_SUFFIX) ||
    BigInt(launch.tokenAddress) <= BigInt(manifest.contracts.pipedog.address)
  ) {
    throw new Error("TokenLaunched token ordering violates the LayPipe pool invariant.");
  }
  if (launch.configId === manifest.launch.creator.id) {
    if (launch.feeRecipientAddress !== launch.creatorAddress) {
      throw new Error("Creator launch fee recipient does not match its creator.");
    }
    return "creator";
  }
  if (launch.configId === manifest.launch.selfBurn.id) {
    if (
      launch.feeRecipientAddress !==
      manifest.contracts.selfBurner.address.toLowerCase()
    ) {
      throw new Error("Self-burn launch fee recipient does not match the audited burner.");
    }
    return "self-burn";
  }
  throw new Error("TokenLaunched config ID is outside the audited manifest.");
}

export async function syncCanonicalIndexerOnce(options: {
  rpc: Eip1193Provider;
  manifest: AuditedDeploymentManifest;
  config: IndexerRuntimeConfig;
  repository?: IndexerRepository;
  verifyIdentity?: (options: {
    rpc: Eip1193Provider;
    manifest: AuditedDeploymentManifest;
    atBlock: bigint;
  }) => Promise<void>;
  safeHead?: bigint;
}) {
  const repository = options.repository ?? productionRepository;
  const { rpc, manifest, config } = options;
  if (manifest.environment !== "robinhood-production" || manifest.testOnly) {
    throw new Error("Production indexer accepts only the Robinhood audited manifest.");
  }
  const chainId = quantity(
    await rpc.request<unknown>({ method: "eth_chainId" }),
    "RPC chain ID",
  );
  if (chainId !== BigInt(manifest.chain.chainId)) {
    throw new Error("Indexer RPC chain does not match the audited deployment manifest.");
  }
  let safeHead = options.safeHead;
  if (safeHead === undefined) {
    const head = quantity(
      await rpc.request<unknown>({ method: "eth_blockNumber" }),
      "RPC head block",
    );
    safeHead = head >= BigInt(config.finalityBlocks)
      ? head - BigInt(config.finalityBlocks)
      : BigInt(0);
  }
  if (safeHead < manifest.deploymentBlock) {
    return {
      status: "idle" as const,
      safeHead: safeHead.toString(),
      nextBlock: manifest.deploymentBlock.toString(),
      rolledBackBlocks: "0",
    };
  }
  await (options.verifyIdentity ?? verifyIndexerManifestIdentity)({
    rpc,
    manifest,
    atBlock: safeHead,
  });

  let state = await readOrInitializeCursor({
    repository,
    chainId: manifest.chain.chainId,
    deploymentBlock: manifest.deploymentBlock,
  });
  if (state.lastBlock !== null && state.lastBlock > safeHead) {
    throw new Error("Indexer cursor is ahead of the observed safe head.");
  }
  const repair = await repairReorg({
    rpc,
    repository,
    chainId: manifest.chain.chainId,
    deploymentBlock: manifest.deploymentBlock,
    reorgLookback: config.reorgLookback,
    state,
  });
  state = repair.state;
  if (state.lastBlock !== null && state.lastBlock > safeHead) {
    throw new Error("Repaired indexer cursor is ahead of the observed safe head.");
  }
  if (state.next > safeHead) {
    return {
      status: "idle" as const,
      safeHead: safeHead.toString(),
      nextBlock: state.next.toString(),
      rolledBackBlocks: repair.rolledBackBlocks.toString(),
    };
  }

  const lastBlock = state.next + BigInt(config.batchSize - 1) < safeHead
    ? state.next + BigInt(config.batchSize - 1)
    : safeHead;
  const heights = Array.from(
    { length: Number(lastBlock - state.next + BigInt(1)) },
    (_value, index) => state.next + BigInt(index),
  );
  const rpcBlocks = await mapConcurrent(heights, 8, async (height) => {
    const block = await loadRpcBlock(rpc, height);
    if (!block) throw new Error("Canonical block disappeared during ingestion.");
    return block;
  });
  const blocks: ChainBlockInput[] = rpcBlocks.map((block) => ({
    number: block.number,
    hash: block.hash,
    parentHash: block.parentHash,
    timestamp: block.timestamp,
  }));
  const blockMap = new Map(
    rpcBlocks.map((block) => [block.number.toString(), { hash: block.hash }]),
  );
  const fromBlock = blockTag(state.next);
  const toBlock = blockTag(lastBlock);
  const factoryAddress = manifest.contracts.factoryProxy.address.toLowerCase();
  const hookAddress = manifest.contracts.hook.address.toLowerCase();
  const selfBurnerAddress = manifest.contracts.selfBurner.address.toLowerCase();
  const revenueRouterAddress = manifest.contracts.revenueRouter.address.toLowerCase();
  const [
    rawFactoryLogs,
    rawFactoryOperationalLogs,
    rawHookOperationalLogs,
    rawSelfBurnOperationalLogs,
    rawRevenueOperationalLogs,
  ] = await Promise.all([
    queryLogs(
      rpc,
      {
        fromBlock,
        toBlock,
        address: factoryAddress,
        topics: [TOKEN_LAUNCHED_TOPIC],
      },
      config.maxLogs,
    ),
    queryLogs(
      rpc,
      {
        fromBlock,
        toBlock,
        address: factoryAddress,
        topics: [FACTORY_OPERATIONAL_TOPICS],
      },
      config.maxLogs,
    ),
    queryLogs(
      rpc,
      {
        fromBlock,
        toBlock,
        address: hookAddress,
        topics: [HOOK_OPERATIONAL_TOPICS],
      },
      config.maxLogs,
    ),
    queryLogs(
      rpc,
      {
        fromBlock,
        toBlock,
        address: selfBurnerAddress,
        topics: [SELF_BURN_OPERATIONAL_TOPICS],
      },
      config.maxLogs,
    ),
    queryLogs(
      rpc,
      {
        fromBlock,
        toBlock,
        address: revenueRouterAddress,
        topics: [REVENUE_OPERATIONAL_TOPICS],
      },
      config.maxLogs,
    ),
  ]);
  const factoryLogs = rawFactoryLogs.map((value) =>
    parseRpcLog(value, new Set([factoryAddress]), blockMap),
  );
  const newLaunches = factoryLogs.map(decodeTokenLaunched);
  if (newLaunches.length > config.maxNewLaunches) {
    throw new Error("Launches in this batch exceed the configured metadata-read bound.");
  }

  const watchLimit = config.filterChunkSize * config.maxFilterChunks;
  const existing = await repository.loadLaunches({
    chainId: manifest.chain.chainId,
    limit: watchLimit,
  });
  const identityByPool = new Map(existing.map((value) => [value.poolId, value]));
  const identityByToken = new Map(existing.map((value) => [value.tokenAddress, value]));
  for (const launch of newLaunches) {
    const feeMode = classifyLaunch(launch, manifest);
    if (identityByPool.has(launch.poolId) || identityByToken.has(launch.tokenAddress)) {
      throw new Error("TokenLaunched conflicts with an already indexed launch identity.");
    }
    const identity: IndexedLaunchIdentity = {
      tokenAddress: launch.tokenAddress,
      poolId: launch.poolId,
      feeMode,
    };
    identityByPool.set(launch.poolId, identity);
    identityByToken.set(launch.tokenAddress, identity);
  }
  if (
    identityByPool.size > watchLimit ||
    identityByToken.size > watchLimit ||
    identityByPool.size !== identityByToken.size
  ) {
    throw new Error("LayPipe watch set exceeds the configured RPC filter bound.");
  }

  const poolChunks = chunks([...identityByPool.keys()], config.filterChunkSize);
  const swapPages = await mapConcurrent(poolChunks, 4, (poolIds) =>
    queryLogs(
      rpc,
      {
        fromBlock,
        toBlock,
        address: manifest.contracts.poolManager.address.toLowerCase(),
        topics: [POOL_MANAGER_SWAP_TOPIC, poolIds],
      },
      config.maxLogs,
    ),
  );
  const tokenChunks = chunks([...identityByToken.keys()], config.filterChunkSize);
  const transferPages = await mapConcurrent(tokenChunks, 4, (addresses) =>
    queryLogs(
      rpc,
      { fromBlock, toBlock, address: addresses, topics: [ERC20_TRANSFER_TOPIC] },
      config.maxLogs,
    ),
  );
  const rawLogCount =
    rawFactoryLogs.length +
    rawFactoryOperationalLogs.length +
    rawHookOperationalLogs.length +
    rawSelfBurnOperationalLogs.length +
    rawRevenueOperationalLogs.length +
    swapPages.reduce((sum, page) => sum + page.length, 0) +
    transferPages.reduce((sum, page) => sum + page.length, 0);
  if (rawLogCount > config.maxLogs) {
    throw new Error("Canonical log batch exceeds INDEXER_MAX_LOGS.");
  }

  const poolManagerAddress = manifest.contracts.poolManager.address.toLowerCase();
  const launchedPools = new Set(identityByPool.keys());
  const swaps = swapPages
    .flat()
    .map((value) => parseRpcLog(value, new Set([poolManagerAddress]), blockMap))
    .map((value) => decodePoolManagerSwap(value, launchedPools));
  const launchedTokens = new Set(identityByToken.keys());
  const transfers = transferPages
    .flat()
    .map((value) => parseRpcLog(value, launchedTokens, blockMap))
    .map((value) => decodeTokenTransfer(value, launchedTokens));
  const factoryOperational = rawFactoryOperationalLogs
    .map((value) => parseRpcLog(value, new Set([factoryAddress]), blockMap))
    .map(decodeFactoryOperationalEvent);
  const hookOperational = rawHookOperationalLogs
    .map((value) => parseRpcLog(value, new Set([hookAddress]), blockMap))
    .map((value) => decodeHookOperationalEvent(value, identityByPool));
  const selfBurnOperational = rawSelfBurnOperationalLogs
    .map((value) => parseRpcLog(value, new Set([selfBurnerAddress]), blockMap))
    .map((value) => decodeSelfBurnOperationalEvent(value, identityByPool));
  const revenueOperational = rawRevenueOperationalLogs
    .map((value) => parseRpcLog(value, new Set([revenueRouterAddress]), blockMap))
    .map(decodeRevenueOperationalEvent);

  const launchMetadata = await mapConcurrent(newLaunches, 4, async (launch) => ({
    launch,
    feeMode: classifyLaunch(launch, manifest),
    // Bind metadata to the exact event block. Reading at the batch head could
    // index a later mutable value that was never true when TokenLaunched ran.
    metadata: await loadLaunchMetadata({
      rpc,
      launch,
      manifest,
      atBlock: BigInt(launch.raw.blockNumber),
    }),
  }));
  const projections: IndexerProjection[] = [
    ...launchMetadata.map(({ launch, feeMode, metadata }) =>
      launchProjection(launch, { feeMode, ...metadata }),
    ),
    ...swaps.map((value) => value.projection),
    ...transfers.map((value) => value.projection),
    ...factoryOperational.map((value) => value.projection),
    ...hookOperational.map((value) => value.projection),
    ...selfBurnOperational.map((value) => value.projection),
    ...revenueOperational.map((value) => value.projection),
  ];
  const logs = [
    ...newLaunches.map((value) => value.raw),
    ...swaps.map((value) => value.raw),
    ...transfers.map((value) => value.raw),
    ...factoryOperational.map((value) => value.raw),
    ...hookOperational.map((value) => value.raw),
    ...selfBurnOperational.map((value) => value.raw),
    ...revenueOperational.map((value) => value.raw),
  ].sort((left, right) => {
    const byBlock = BigInt(left.blockNumber) - BigInt(right.blockNumber);
    if (byBlock !== BigInt(0)) return byBlock < BigInt(0) ? -1 : 1;
    return left.transactionIndex - right.transactionIndex || left.logIndex - right.logIndex;
  });
  const eventKeys = new Set<string>();
  for (const log of logs) {
    const key = `${log.transactionHash}:${log.logIndex}`;
    if (eventKeys.has(key)) throw new Error("RPC filters returned a duplicate canonical log.");
    eventKeys.add(key);
  }

  const tipCheck = await loadRpcBlock(rpc, lastBlock);
  if (!tipCheck || tipCheck.hash !== rpcBlocks.at(-1)!.hash) {
    throw new Error("Canonical block window changed before cursor commit.");
  }
  const ingested = await repository.ingest({
    chainId: manifest.chain.chainId,
    stream: STREAM,
    expectedNextBlock: state.next,
    blocks,
    logs,
    projections,
  });
  return {
    status: "ingested" as const,
    safeHead: safeHead.toString(),
    nextBlock: (lastBlock + BigInt(1)).toString(),
    rolledBackBlocks: repair.rolledBackBlocks.toString(),
    ...ingested,
  };
}

export async function runCanonicalIndexer(options?: {
  env?: NodeJS.ProcessEnv;
  fetcher?: typeof fetch;
  now?: () => number;
  syncOnce?: typeof syncCanonicalIndexerOnce;
  manifest?: AuditedDeploymentManifest;
  safeHead?: bigint;
  recordObservation?: typeof recordIndexerObservation;
}) {
  const env = options?.env ?? process.env;
  const config = readIndexerRuntimeConfig(env);
  const manifest = catchupManifest(env, options?.manifest);
  const now = options?.now ?? Date.now;
  const deadlineAt = now() + config.runTimeoutMs;
  const finalizationReserveMs = Math.min(
    INDEXER_FINALIZATION_RESERVE_MS,
    Math.max(0, config.runTimeoutMs - 1_000),
  );
  const ingestionDeadlineAt = deadlineAt - finalizationReserveMs;
  const rpc = createHttpIndexerRpc({
    url: env.ROBINHOOD_RPC_HTTP_URL,
    deadlineAt: ingestionDeadlineAt,
    fetcher: options?.fetcher,
  });
  const syncOnce = options?.syncOnce ?? syncCanonicalIndexerOnce;
  let invocationSafeHead = options?.safeHead;
  if (invocationSafeHead === undefined) {
    const head = quantity(
      await rpc.request<unknown>({ method: "eth_blockNumber" }),
      "RPC head block",
    );
    invocationSafeHead = head >= BigInt(config.finalityBlocks)
      ? head - BigInt(config.finalityBlocks)
      : BigInt(0);
  }
  let identityVerifiedAt: bigint | null = null;
  const verifyOnceAtSafeHead = async (verifyOptions: {
    rpc: Eip1193Provider;
    manifest: AuditedDeploymentManifest;
    atBlock: bigint;
  }) => {
    if (verifyOptions.atBlock !== invocationSafeHead) {
      throw new Error("Indexer sub-batch did not use the pinned invocation safe head.");
    }
    if (identityVerifiedAt === null) {
      await verifyIndexerManifestIdentity(verifyOptions);
      identityVerifiedAt = verifyOptions.atBlock;
      return;
    }
  };
  let batches = 0;
  let blockCount = 0;
  let eventCount = 0;
  let projectionCount = 0;
  let rolledBackBlocks = BigInt(0);
  let lastResult: Awaited<ReturnType<typeof syncCanonicalIndexerOnce>> | null = null;

  while (batches < config.maxBatchesPerRun) {
    // Stop before the route budget is consumed so an in-flight canonical write,
    // terminal observation/leader refresh, response, and lease release fit.
    // The loop is also statically capped even if a mocked clock stalls.
    if (now() >= ingestionDeadlineAt) break;
    const result = await syncOnce({
      rpc,
      manifest,
      config,
      verifyIdentity: verifyOnceAtSafeHead,
      safeHead: invocationSafeHead,
    });
    lastResult = result;
    rolledBackBlocks += BigInt(result.rolledBackBlocks);
    if (result.status === "idle") break;
    batches += 1;
    blockCount += result.blockCount;
    eventCount += result.eventCount;
    projectionCount += result.projectionCount;
    if (BigInt(result.nextBlock) > BigInt(result.safeHead)) break;
  }

  if (!lastResult) {
    return {
      status: "deadline" as const,
      safeHead: invocationSafeHead.toString(),
      nextBlock: null,
      batches: 0,
      blockCount: 0,
      eventCount: 0,
      projectionCount: 0,
      rolledBackBlocks: "0",
    };
  }
  const caughtUp = BigInt(lastResult.nextBlock) > BigInt(lastResult.safeHead);
  const result = {
    status:
      lastResult.status === "idle" || caughtUp
        ? ("caught-up" as const)
        : now() >= ingestionDeadlineAt
          ? ("deadline" as const)
          : ("bounded" as const),
    safeHead: lastResult.safeHead,
    nextBlock: lastResult.nextBlock,
    batches,
    blockCount,
    eventCount,
    projectionCount,
    rolledBackBlocks: rolledBackBlocks.toString(),
  };
  await (options?.recordObservation ?? recordIndexerObservation)({
    chainId: manifest.chain.chainId,
    stream: STREAM,
    safeHead: invocationSafeHead,
    status: result.status,
    observedAt: new Date(now()),
  });
  return result;
}
