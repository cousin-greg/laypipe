import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  encodeAbiParameters,
  keccak256,
  padHex,
  toBytes,
  toEventSelector,
  toHex,
} from "viem";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cache = new Map();

function loadTypeScript(relativePath) {
  const filename = resolve(root, relativePath);
  if (cache.has(filename)) return cache.get(filename).exports;
  const loaded = { exports: {} };
  cache.set(filename, loaded);
  const output = ts.transpileModule(readFileSync(filename, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: filename,
  }).outputText;
  const localRequire = (specifier) => {
    if (specifier.startsWith("@/")) {
      const unresolved = resolve(root, specifier.slice(2));
      const dependency = extname(unresolved) ? unresolved : `${unresolved}.ts`;
      return loadTypeScript(dependency.slice(root.length + 1));
    }
    if (!specifier.startsWith(".")) return require(specifier);
    const unresolved = resolve(dirname(filename), specifier);
    const dependency = extname(unresolved) ? unresolved : `${unresolved}.ts`;
    return loadTypeScript(dependency.slice(root.length + 1));
  };
  new Function("require", "module", "exports", "__filename", "__dirname", output)(
    localRequire,
    loaded,
    loaded.exports,
    filename,
    dirname(filename),
  );
  return loaded.exports;
}

const ingestion = loadTypeScript("lib/server/indexer/ingestion.ts");
const events = loadTypeScript("lib/server/indexer/events.ts");
const auth = loadTypeScript("lib/server/indexer/auth.ts");
const rpcModule = loadTypeScript("lib/server/indexer/rpc.ts");
const leaseModule = loadTypeScript("lib/server/indexer/lease.ts");
const webhookModule = loadTypeScript("lib/server/indexer/webhook.ts");
const model = loadTypeScript("lib/server/indexer/model.ts");
const observability = loadTypeScript("lib/server/observability.ts");
const repository = loadTypeScript("lib/server/indexer/repository.ts");

const address = (byte) => `0x${byte.repeat(40)}`;
const hash = (byte) => `0x${byte.repeat(64)}`;
const topicAddress = (value) => padHex(value, { size: 32 });
const topicUint = (value) => padHex(toHex(BigInt(value)), { size: 32 });
const quantity = (value) => toHex(BigInt(value));

const factory = address("f");
const poolManager = address("e");
const hook = address("d");
const burner = address("c");
const pipedog = address("1");
const token = `${address("a").slice(0, -2)}cc`;
const creator = address("9");
const recipient = address("8");
const poolId = hash("7");

function manifest() {
  const identity = (value) => ({ address: value, runtimeCodehash: hash("4") });
  return {
    manifestVersion: 1,
    environment: "robinhood-production",
    testOnly: false,
    chain: { chainId: 4663, chainName: "Robinhood Chain" },
    deploymentBlock: 100n,
    release: {},
    contracts: {
      factoryProxy: identity(factory),
      factoryImplementation: identity(address("2")),
      tokenImplementation: identity(address("3")),
      hook: identity(hook),
      swapRouter: identity(address("4")),
      selfBurner: identity(burner),
      revenueRouter: identity(address("5")),
      poolManager: identity(poolManager),
      pipedog: identity(pipedog),
    },
    governance: {},
    launch: {
      creator: { id: 1n, config: {} },
      selfBurn: { id: 2n, config: {} },
    },
    routing: {},
  };
}

function rawLog({
  address: contractAddress,
  blockNumber,
  blockHash,
  transactionHash,
  transactionIndex,
  logIndex,
  topics,
  data,
}) {
  return {
    address: contractAddress,
    blockNumber: quantity(blockNumber),
    blockHash,
    transactionHash,
    transactionIndex: quantity(transactionIndex),
    logIndex: quantity(logIndex),
    topics,
    data,
    removed: false,
  };
}

function operationalLog({
  contractAddress,
  signature,
  indexed = [],
  inputs = [],
  values = [],
  transactionHash = hash("5"),
  logIndex = 0,
}) {
  return {
    blockNumber: 100n,
    transactionHash,
    transactionIndex: 0,
    logIndex,
    contractAddress,
    topics: [keccak256(toBytes(signature)), ...indexed],
    data: encodeAbiParameters(inputs, values),
  };
}

test("bounded worker ingests factory launches, canonical PoolManager swaps, and token transfers atomically", async () => {
  const block100 = {
    number: quantity(100),
    hash: hash("a"),
    parentHash: hash("0"),
    timestamp: quantity(1_786_000_000),
  };
  const block101 = {
    number: quantity(101),
    hash: hash("b"),
    parentHash: block100.hash,
    timestamp: quantity(1_786_000_001),
  };
  const transactionHash = hash("6");
  const launchLog = rawLog({
    address: factory,
    blockNumber: 100,
    blockHash: block100.hash,
    transactionHash,
    transactionIndex: 0,
    logIndex: 3,
    topics: [
      events.TOKEN_LAUNCHED_TOPIC,
      topicAddress(token),
      topicAddress(creator),
      poolId,
    ],
    data: encodeAbiParameters(
      [
        { type: "uint256" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "address" },
        { type: "address" },
      ],
      [2n, 5n, 10n, hook, burner],
    ),
  });
  const swapLog = rawLog({
    address: poolManager,
    blockNumber: 100,
    blockHash: block100.hash,
    transactionHash,
    transactionIndex: 0,
    logIndex: 2,
    topics: [events.POOL_MANAGER_SWAP_TOPIC, poolId, topicAddress(address("6"))],
    data: encodeAbiParameters(
      [
        { type: "int128" },
        { type: "int128" },
        { type: "uint160" },
        { type: "uint128" },
        { type: "int24" },
        { type: "uint24" },
      ],
      [-5n, 10n, 123n, 456n, 200, 10_000],
    ),
  });
  const transferLog = rawLog({
    address: token,
    blockNumber: 100,
    blockHash: block100.hash,
    transactionHash,
    transactionIndex: 0,
    logIndex: 1,
    topics: [
      events.ERC20_TRANSFER_TOPIC,
      topicAddress(address("0")),
      topicAddress(recipient),
    ],
    data: encodeAbiParameters([{ type: "uint256" }], [1_000n]),
  });
  const hookFeeLog = rawLog({
    address: hook,
    blockNumber: 100,
    blockHash: block100.hash,
    transactionHash,
    transactionIndex: 0,
    logIndex: 4,
    topics: [events.HOOK_OPERATIONAL_TOPICS[0], poolId],
    data: encodeAbiParameters([{ type: "uint256" }], [77n]),
  });
  const launchFeeLog = rawLog({
    address: factory,
    blockNumber: 100,
    blockHash: block100.hash,
    transactionHash,
    transactionIndex: 0,
    logIndex: 5,
    topics: [events.FACTORY_OPERATIONAL_TOPICS[0], topicAddress(address("5"))],
    data: encodeAbiParameters([{ type: "uint256" }], [88n]),
  });
  const revenueLog = rawLog({
    address: address("5"),
    blockNumber: 101,
    blockHash: block101.hash,
    transactionHash: hash("8"),
    transactionIndex: 0,
    logIndex: 0,
    topics: [events.REVENUE_OPERATIONAL_TOPICS[0]],
    data: encodeAbiParameters(
      [{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }],
      [25n, 25n, 50n],
    ),
  });
  const burnLog = rawLog({
    address: burner,
    blockNumber: 101,
    blockHash: block101.hash,
    transactionHash: hash("9"),
    transactionIndex: 1,
    logIndex: 0,
    topics: [events.SELF_BURN_OPERATIONAL_TOPICS[0], poolId, topicAddress(token)],
    data: encodeAbiParameters(
      [{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }],
      [90n, 180n, 10n],
    ),
  });

  const stringResult = (value) => encodeAbiParameters([{ type: "string" }], [value]);
  const callResults = new Map([
    [events.TOKEN_READ_SELECTORS.factory, encodeAbiParameters([{ type: "address" }], [factory])],
    [events.TOKEN_READ_SELECTORS.poolId, encodeAbiParameters([{ type: "bytes32" }], [poolId])],
    [events.TOKEN_READ_SELECTORS.hook, encodeAbiParameters([{ type: "address" }], [hook])],
    [events.TOKEN_READ_SELECTORS.deployer, encodeAbiParameters([{ type: "address" }], [creator])],
    [events.TOKEN_READ_SELECTORS.name, stringResult("Pipe Runner")],
    [events.TOKEN_READ_SELECTORS.symbol, stringResult("RUN")],
    [events.TOKEN_READ_SELECTORS.logo, stringResult("ipfs://image")],
    [events.TOKEN_READ_SELECTORS.description, stringResult("Exact on-chain metadata")],
    [events.TOKEN_READ_SELECTORS.tokenURI, stringResult("ipfs://metadata")],
    [
      events.TOKEN_READ_SELECTORS.socials,
      encodeAbiParameters(
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
        [
          {
            telegram: "",
            twitter: "https://x.com/runner",
            discord: "",
            website: "https://runner.test",
            extra: "",
          },
        ],
      ),
    ],
  ]);
  const filters = [];
  const tokenCallBlockTags = [];
  const tokenCloneRuntime =
    `0x363d3d373d3d3d363d73${address("3").slice(2)}5af43d82803e903d91602b57fd5bf3`;
  const rpc = {
    async request({ method, params }) {
      if (method === "eth_chainId") return quantity(4663);
      if (method === "eth_blockNumber") return quantity(102);
      if (method === "eth_getBlockByNumber") {
        const requested = params[0];
        if (requested === quantity(100)) return block100;
        if (requested === quantity(101)) return block101;
        throw new Error(`unexpected block ${requested}`);
      }
      if (method === "eth_getLogs") {
        const filter = params[0];
        filters.push(filter);
        if (
          filter.address === factory &&
          filter.topics[0] === events.TOKEN_LAUNCHED_TOPIC
        ) return [launchLog];
        if (filter.address === factory) return [launchFeeLog];
        if (filter.address === hook) return [hookFeeLog];
        if (filter.address === burner) return [burnLog];
        if (filter.address === address("5")) return [revenueLog];
        if (filter.address === poolManager) return [swapLog];
        if (Array.isArray(filter.address) && filter.address.includes(token)) {
          return [transferLog];
        }
        return [];
      }
      if (method === "eth_getCode") return tokenCloneRuntime;
      if (method === "eth_call") {
        tokenCallBlockTags.push(params[1]);
        const result = callResults.get(params[0].data);
        if (!result) throw new Error(`unexpected token selector ${params[0].data}`);
        return result;
      }
      throw new Error(`unexpected RPC method ${method}`);
    },
  };

  let health = null;
  let committed;
  const repository = {
    async initializeCursor({ startBlock }) {
      health = {
        start_block: String(startBlock),
        next_block: String(startBlock),
        last_processed_block: null,
        last_processed_hash: null,
      };
    },
    async readHealth() {
      return health;
    },
    async loadLaunches() {
      return [];
    },
    async loadRecentBlocks() {
      throw new Error("reorg scan should not run on an empty cursor");
    },
    async rollback() {
      throw new Error("rollback should not run");
    },
    async ingest(input) {
      committed = model.normalizeCanonicalBatch(input);
      return {
        chainId: input.chainId,
        firstBlock: "100",
        lastBlock: "101",
        blockCount: input.blocks.length,
        eventCount: input.logs.length,
        projectionCount: input.projections.length,
      };
    },
  };

  const result = await ingestion.syncCanonicalIndexerOnce({
    rpc,
    manifest: manifest(),
    safeHead: 101n,
    config: {
      finalityBlocks: 1,
      batchSize: 10,
      maxLogs: 100,
      maxNewLaunches: 10,
      filterChunkSize: 10,
      maxFilterChunks: 10,
      reorgLookback: 16,
      runTimeoutMs: 30_000,
    },
    repository,
    verifyIdentity: async () => undefined,
  });

  assert.equal(result.status, "ingested");
  assert.equal(result.nextBlock, "102");
  assert.equal(committed.logs.length, 7);
  assert.deepEqual(committed.logs.map((log) => log.eventName), [
    "Transfer",
    "Swap",
    "TokenLaunched",
    "FeeAccrued",
    "LaunchFeeRouted",
    "RevenueAllocated",
    "Burned",
  ]);
  const launch = committed.projections.find((projection) => projection.kind === "launch");
  const swap = committed.projections.find((projection) => projection.kind === "swap");
  const transfer = committed.projections.find((projection) => projection.kind === "transfer");
  const feeKinds = committed.projections
    .filter((projection) => projection.kind === "fee")
    .map((projection) => projection.feeKind)
    .sort();
  const revenue = committed.projections.find((projection) => projection.kind === "revenue");
  const burn = committed.projections.find((projection) => projection.kind === "burn");
  assert.equal(launch.name, "Pipe Runner");
  assert.equal(launch.metadataUri, "ipfs://metadata");
  assert.equal(launch.socials.twitter, "https://x.com/runner");
  assert.equal(swap.side, "buy");
  assert.equal(swap.pipedogAmount, 5n);
  assert.equal(swap.tokenAmount, 10n);
  assert.equal(transfer.amount, 1_000n);
  assert.deepEqual(feeKinds, ["accrued", "launch-fee"]);
  assert.equal(revenue.amount, 100n);
  assert.equal(burn.tokensBurned, 180n);
  assert.ok(tokenCallBlockTags.length > 0);
  assert.ok(
    tokenCallBlockTags.every((tag) => tag === quantity(100)),
    "launch metadata must be read at the exact TokenLaunched block",
  );
  assert.ok(
    filters.some(
      (filter) =>
        filter.address === poolManager &&
        filter.topics[0] === events.POOL_MANAGER_SWAP_TOPIC &&
        filter.topics[1].includes(poolId),
    ),
    "PoolManager swaps must be filtered by canonical LayPipe pool IDs",
  );
});

test("an eth_getLogs result at the exact query ceiling fails before cursor advance", async () => {
  const block100 = {
    number: quantity(100),
    hash: hash("a"),
    parentHash: hash("0"),
    timestamp: quantity(1_786_000_000),
  };
  let ingestCalls = 0;
  let cursorNextBlock = "100";
  const repository = {
    async initializeCursor() {
      throw new Error("cursor is already initialized");
    },
    async readHealth() {
      return {
        start_block: "100",
        next_block: cursorNextBlock,
        last_processed_block: null,
        last_processed_hash: null,
      };
    },
    async loadLaunches() {
      return [];
    },
    async loadRecentBlocks() {
      throw new Error("reorg scan should not run on an empty cursor");
    },
    async rollback() {
      throw new Error("rollback should not run");
    },
    async ingest() {
      ingestCalls += 1;
      cursorNextBlock = "101";
      throw new Error("saturated log results must never be ingested");
    },
  };
  const rpc = {
    async request({ method, params }) {
      if (method === "eth_chainId") return quantity(4663);
      if (method === "eth_getBlockByNumber") {
        assert.equal(params[0], quantity(100));
        return block100;
      }
      if (method === "eth_getLogs") {
        const filter = params[0];
        if (
          filter.address === factory &&
          filter.topics[0] === events.TOKEN_LAUNCHED_TOPIC
        ) {
          return Array.from({ length: 100 }, () => ({}));
        }
        return [];
      }
      throw new Error(`unexpected RPC method ${method}`);
    },
  };

  await assert.rejects(
    ingestion.syncCanonicalIndexerOnce({
      rpc,
      manifest: manifest(),
      safeHead: 100n,
      config: {
        finalityBlocks: 1,
        batchSize: 10,
        maxLogs: 100,
        maxNewLaunches: 10,
        filterChunkSize: 10,
        maxFilterChunks: 10,
        reorgLookback: 16,
        runTimeoutMs: 30_000,
      },
      repository,
      verifyIdentity: async () => undefined,
    }),
    /reached its configured bound and may be truncated/,
  );
  assert.equal(ingestCalls, 0);
  assert.equal(cursorNextBlock, "100");
});

test("a cursor ahead of the observed safe head fails before reorg or ingest work", async () => {
  let reorgCalls = 0;
  let ingestCalls = 0;
  const repository = {
    async initializeCursor() {
      throw new Error("cursor is already initialized");
    },
    async readHealth() {
      return {
        start_block: "100",
        next_block: "102",
        last_processed_block: "101",
        last_processed_hash: hash("a"),
      };
    },
    async loadLaunches() {
      return [];
    },
    async loadRecentBlocks() {
      reorgCalls += 1;
      return [];
    },
    async rollback() {
      reorgCalls += 1;
      return 0n;
    },
    async ingest() {
      ingestCalls += 1;
      throw new Error("ingest must not run");
    },
  };
  const rpc = {
    async request({ method }) {
      if (method === "eth_chainId") return quantity(4663);
      throw new Error(`unexpected RPC method ${method}`);
    },
  };

  await assert.rejects(
    ingestion.syncCanonicalIndexerOnce({
      rpc,
      manifest: manifest(),
      safeHead: 100n,
      config: {
        finalityBlocks: 1,
        batchSize: 10,
        maxLogs: 100,
        maxNewLaunches: 10,
        filterChunkSize: 10,
        maxFilterChunks: 10,
        reorgLookback: 16,
        runTimeoutMs: 30_000,
      },
      repository,
      verifyIdentity: async () => undefined,
    }),
    /cursor is ahead of the observed safe head/,
  );
  assert.equal(reorgCalls, 0);
  assert.equal(ingestCalls, 0);
});

test("operational event signatures stay pinned to the committed contract ABI bundle", () => {
  const normalizedEvent = (event) => ({
    type: event.type,
    name: event.name,
    anonymous: event.anonymous ?? false,
    inputs: event.inputs.map((input) => ({
      name: input.name,
      type: input.type,
      indexed: input.indexed ?? false,
      ...(input.components
        ? {
            components: input.components.map((component) => ({
              name: component.name,
              type: component.type,
              indexed: component.indexed ?? false,
            })),
          }
        : {}),
    })),
  });
  const contracts = {
    factory: "LaypipeFactory",
    hook: "PipedogHook",
    selfBurner: "LaypipeSelfBurner",
    revenueRouter: "PipedogRevenueRouter",
  };
  const topicGroups = {
    factory: events.FACTORY_OPERATIONAL_TOPICS,
    hook: events.HOOK_OPERATIONAL_TOPICS,
    selfBurner: events.SELF_BURN_OPERATIONAL_TOPICS,
    revenueRouter: events.REVENUE_OPERATIONAL_TOPICS,
  };
  for (const [key, contractName] of Object.entries(contracts)) {
    const abi = JSON.parse(
      readFileSync(resolve(root, `contracts/abi/${contractName}.json`), "utf8"),
    );
    const byName = new Map(
      abi.filter((entry) => entry.type === "event").map((entry) => [entry.name, entry]),
    );
    const names = events.INDEXED_OPERATIONAL_EVENT_NAMES[key];
    const committedEvents = names.map((name) => {
      const event = byName.get(name);
      assert.ok(event, `${contractName}.${name} is missing from the committed ABI`);
      return event;
    });
    const expectedTopics = committedEvents.map(toEventSelector);
    assert.deepEqual([...topicGroups[key]].sort(), expectedTopics.sort());
    assert.deepEqual(
      events.INDEXED_OPERATIONAL_EVENT_ABIS[key].map(normalizedEvent),
      committedEvents.map(normalizedEvent),
      `${contractName} indexed fields or decoded parameter shapes drifted`,
    );
  }
});

test("fee, burn, and revenue decoders preserve exact base units and reconcile their lanes", () => {
  const knownByPool = new Map([
    [poolId, { tokenAddress: token, poolId, feeMode: "self-burn" }],
  ]);
  const caller = address("6");
  const treasury = address("5");
  const sink = "0x000000000000000000000000000000000000dead";
  const feeLogs = [
    operationalLog({
      contractAddress: hook,
      signature: "FeeAccrued(bytes32,uint256)",
      indexed: [poolId],
      inputs: [{ type: "uint256" }],
      values: [1_001n],
      logIndex: 1,
    }),
    operationalLog({
      contractAddress: hook,
      signature: "FeesSwept(bytes32,address,uint256,uint256)",
      indexed: [poolId, topicAddress(caller)],
      inputs: [{ type: "uint256" }, { type: "uint256" }],
      values: [700n, 300n],
      logIndex: 2,
    }),
    operationalLog({
      contractAddress: hook,
      signature: "CreatorFeesClaimed(bytes32,address,uint256)",
      indexed: [poolId, topicAddress(burner)],
      inputs: [{ type: "uint256" }],
      values: [700n],
      logIndex: 3,
    }),
    operationalLog({
      contractAddress: hook,
      signature: "PlatformPayoutDeferred(uint256)",
      inputs: [{ type: "uint256" }],
      values: [300n],
      logIndex: 4,
    }),
    operationalLog({
      contractAddress: hook,
      signature: "PlatformPayoutCollected(address,uint256)",
      indexed: [topicAddress(treasury)],
      inputs: [{ type: "uint256" }],
      values: [300n],
      logIndex: 5,
    }),
  ];
  const fees = feeLogs.map(
    (log) => events.decodeHookOperationalEvent(log, knownByPool).projection,
  );
  assert.deepEqual(fees.map((event) => event.feeKind), [
    "accrued",
    "swept",
    "creator-claimed",
    "platform-deferred",
    "platform-collected",
  ]);
  assert.equal(fees[2].recipientAddress, burner);
  assert.equal(fees[4].recipientAddress, treasury);
  const accrued = fees.filter((event) => event.feeKind === "accrued")
    .reduce((sum, event) => sum + event.amount, 0n);
  const swept = fees.find((event) => event.feeKind === "swept");
  const creatorClaimed = fees.find((event) => event.feeKind === "creator-claimed").amount;
  const platformDeferred = fees.find((event) => event.feeKind === "platform-deferred").amount;
  const platformCollected = fees.find((event) => event.feeKind === "platform-collected").amount;
  assert.equal(accrued - swept.creatorAmount - swept.platformAmount, 1n);
  assert.equal(swept.creatorAmount - creatorClaimed, 0n);
  assert.equal(platformDeferred - platformCollected, 0n);

  const launchFee = events.decodeFactoryOperationalEvent(
    operationalLog({
      contractAddress: factory,
      signature: "LaunchFeeRouted(address,uint256)",
      indexed: [topicAddress(treasury)],
      inputs: [{ type: "uint256" }],
      values: [(1n << 255n) + 123n],
      logIndex: 6,
    }),
  ).projection;
  assert.equal(launchFee.feeKind, "launch-fee");
  assert.equal(launchFee.amount, (1n << 255n) + 123n);
  assert.equal(launchFee.recipientAddress, treasury);

  const revenueLogs = [
    operationalLog({
      contractAddress: address("5"),
      signature: "RevenueAllocated(uint256,uint256,uint256)",
      inputs: [{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }],
      values: [250n, 250n, 500n],
      logIndex: 7,
    }),
    operationalLog({
      contractAddress: address("5"),
      signature: "PipedogSequestered(address,uint256,uint256,address)",
      indexed: [topicAddress(caller), topicAddress(sink)],
      inputs: [{ type: "uint256" }, { type: "uint256" }],
      values: [240n, 10n],
      logIndex: 8,
    }),
    operationalLog({
      contractAddress: address("5"),
      signature: "TreasuryPipedogRouted(address,address,uint256,uint256)",
      indexed: [topicAddress(caller), topicAddress(treasury)],
      inputs: [{ type: "uint256" }, { type: "uint256" }],
      values: [245n, 5n],
      logIndex: 9,
    }),
    operationalLog({
      contractAddress: address("5"),
      signature: "OperationsPipedogCollected(address,uint256)",
      indexed: [topicAddress(recipient)],
      inputs: [{ type: "uint256" }],
      values: [500n],
      logIndex: 10,
    }),
  ];
  const revenue = revenueLogs.map(
    (log) => events.decodeRevenueOperationalEvent(log).projection,
  );
  const allocated = revenue.find((event) => event.routeKind === "allocated");
  const sequestered = revenue.find((event) => event.routeKind === "sequestered");
  const treasuryRouted = revenue.find((event) => event.routeKind === "treasury");
  const operations = revenue.find((event) => event.routeKind === "operations");
  assert.equal(allocated.amount, 1_000n);
  assert.equal(
    allocated.sequesterAmount - sequestered.amount - sequestered.bounty,
    0n,
  );
  assert.equal(
    allocated.treasuryAmount - treasuryRouted.amount - treasuryRouted.bounty,
    0n,
  );
  assert.equal(allocated.operationsAmount - operations.amount, 0n);

  const burnLog = operationalLog({
    contractAddress: burner,
    signature: "Burned(bytes32,address,uint256,uint256,uint256)",
    indexed: [poolId, topicAddress(token)],
    inputs: [{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }],
    values: [900n, (1n << 200n) + 7n, 100n],
    logIndex: 11,
  });
  const burned = events.decodeSelfBurnOperationalEvent(
    burnLog,
    knownByPool,
  ).projection;
  assert.equal(burned.pipedogIn, 900n);
  assert.equal(burned.tokensBurned, (1n << 200n) + 7n);
  assert.equal(burned.pipedogBounty, 100n);
  assert.throws(
    () => events.decodeSelfBurnOperationalEvent(
      {
        ...burnLog,
        topics: [
          events.SELF_BURN_OPERATIONAL_TOPICS[0],
          poolId,
          topicAddress(address("b")),
        ],
      },
      knownByPool,
    ),
    /does not match/,
  );
});

test("admin decoders retain exact address, boolean, signed tick, cap, and migration evidence", () => {
  const oldAddress = address("2");
  const newAddress = address("3");
  const configLog = operationalLog({
    contractAddress: factory,
    signature: "LaunchConfigAdded(uint256,(uint256,int24,int24,uint16,uint24,uint24,uint32,bool,bool))",
    indexed: [topicUint(4n)],
    inputs: [
      {
        type: "tuple",
        components: [
          { name: "supply", type: "uint256" },
          { name: "tickSpacing", type: "int24" },
          { name: "startTick", type: "int24" },
          { name: "creatorFeeBps", type: "uint16" },
          { name: "baseFeeRate", type: "uint24" },
          { name: "launchFeeRate", type: "uint24" },
          { name: "launchFeeDecay", type: "uint32" },
          { name: "enabled", type: "bool" },
          { name: "selfBurn", type: "bool" },
        ],
      },
    ],
    values: [{
      supply: (1n << 255n) + 5n,
      tickSpacing: 60,
      startTick: -120,
      creatorFeeBps: 7_000,
      baseFeeRate: 7_000,
      launchFeeRate: 7_000,
      launchFeeDecay: 0,
      enabled: false,
      selfBurn: true,
    }],
    logIndex: 12,
  });
  const config = events.decodeFactoryOperationalEvent(configLog).projection;
  assert.equal(config.eventName, "LaunchConfigAdded");
  assert.deepEqual(config.details, {
    configId: "4",
    config: {
      supply: ((1n << 255n) + 5n).toString(),
      tickSpacing: "60",
      startTick: "-120",
      creatorFeeBps: "7000",
      baseFeeRate: "7000",
      launchFeeRate: "7000",
      launchFeeDecay: "0",
      enabled: false,
      selfBurn: true,
    },
  });

  const upgraded = events.decodeFactoryOperationalEvent(
    operationalLog({
      contractAddress: factory,
      signature: "Upgraded(address)",
      indexed: [topicAddress(newAddress)],
      logIndex: 13,
    }),
  ).projection;
  assert.equal(upgraded.subjectAddress, newAddress);

  const creatorUpdate = events.decodeHookOperationalEvent(
    operationalLog({
      contractAddress: hook,
      signature: "CreatorUpdated(bytes32,address,address)",
      indexed: [poolId, topicAddress(oldAddress), topicAddress(newAddress)],
      logIndex: 14,
    }),
    new Map([[poolId, { tokenAddress: token, poolId, feeMode: "creator" }]]),
  ).projection;
  assert.deepEqual(creatorUpdate.details, { poolId, oldCreator: oldAddress, newCreator: newAddress });

  const capUpdate = events.decodeRevenueOperationalEvent(
    operationalLog({
      contractAddress: address("5"),
      signature: "MaxSequesterPerCallUpdated(uint256,uint256)",
      inputs: [{ type: "uint256" }, { type: "uint256" }],
      values: [10n, (1n << 255n) + 1n],
      logIndex: 15,
    }),
  ).projection;
  assert.deepEqual(capUpdate.details, {
    oldCap: "10",
    newCap: ((1n << 255n) + 1n).toString(),
  });

  const migrated = events.decodeRevenueOperationalEvent(
    operationalLog({
      contractAddress: address("5"),
      signature: "Migrated(address,uint256)",
      indexed: [topicAddress(newAddress)],
      inputs: [{ type: "uint256" }],
      values: [999n],
      logIndex: 16,
    }),
  ).projection;
  assert.equal(migrated.subjectAddress, newAddress);
  assert.deepEqual(migrated.details, { successor: newAddress, amount: "999" });
});

test("PoolManager swap decoder follows executable v4 caller-delta signs", () => {
  const swap = (amount0, amount1) => ({
    blockNumber: 100n,
    transactionHash: hash("5"),
    transactionIndex: 0,
    logIndex: amount0 < 0n ? 1 : 2,
    contractAddress: poolManager,
    topics: [events.POOL_MANAGER_SWAP_TOPIC, poolId, topicAddress(address("6"))],
    data: encodeAbiParameters(
      [
        { type: "int128" },
        { type: "int128" },
        { type: "uint160" },
        { type: "uint128" },
        { type: "int24" },
        { type: "uint24" },
      ],
      [amount0, amount1, 123n, 456n, 200, 10_000],
    ),
  });
  const buy = events.decodePoolManagerSwap(swap(-5n, 10n), new Set([poolId]));
  const sell = events.decodePoolManagerSwap(swap(4n, -8n), new Set([poolId]));
  assert.equal(buy.projection.side, "buy");
  assert.equal(buy.projection.pipedogAmount, 5n);
  assert.equal(buy.projection.tokenAmount, 10n);
  assert.equal(sell.projection.side, "sell");
  assert.equal(sell.projection.pipedogAmount, 4n);
  assert.equal(sell.projection.tokenAmount, 8n);
});

test("runtime configuration is disabled by default and uses a ten-block free-tier batch", () => {
  assert.throws(
    () => ingestion.readIndexerRuntimeConfig({}),
    /INDEXER_ENABLED/,
  );
  const config = ingestion.readIndexerRuntimeConfig({
    INDEXER_ENABLED: "true",
    INDEXER_FINALITY_BLOCKS: "20",
  });
  assert.equal(config.batchSize, 10);
  assert.equal(config.maxBatchesPerRun, 25);
  assert.equal(config.finalityBlocks, 20);
  assert.equal(ingestion.INDEXER_FINALIZATION_RESERVE_MS, 22_000);
});

test("catch-up runner advances multiple ten-block batches and stops when caught up", async () => {
  const calls = [];
  const observations = [];
  const results = [
    { status: "ingested", safeHead: "129", nextBlock: "110", rolledBackBlocks: "0", blockCount: 10, eventCount: 2, projectionCount: 2 },
    { status: "ingested", safeHead: "129", nextBlock: "120", rolledBackBlocks: "0", blockCount: 10, eventCount: 1, projectionCount: 1 },
    { status: "ingested", safeHead: "129", nextBlock: "130", rolledBackBlocks: "1", blockCount: 10, eventCount: 0, projectionCount: 0 },
  ];
  const result = await ingestion.runCanonicalIndexer({
    env: {
      INDEXER_ENABLED: "true",
      INDEXER_FINALITY_BLOCKS: "20",
      ROBINHOOD_RPC_HTTP_URL: "https://rpc.test/v2/key",
      INDEXER_MAX_BATCHES_PER_RUN: "25",
      INDEXER_RUN_TIMEOUT_MS: "45000",
    },
    syncOnce: async (options) => {
      calls.push(options);
      return results.shift();
    },
    manifest: manifest(),
    safeHead: 129n,
    recordObservation: async (value) => observations.push(value),
  });
  assert.equal(result.status, "caught-up");
  assert.equal(result.batches, 3);
  assert.equal(result.blockCount, 30);
  assert.equal(result.eventCount, 3);
  assert.equal(result.rolledBackBlocks, "1");
  assert.equal(calls.length, 3);
  assert.equal(calls[0].config.batchSize, 10);
  assert.strictEqual(calls[0].verifyIdentity, calls[1].verifyIdentity);
  assert.ok(calls.every((call) => call.safeHead === 129n));
  assert.equal(observations.length, 1);
  assert.equal(observations[0].status, "caught-up");
  assert.equal(observations[0].safeHead, 129n);
});

test("indexer observations persist the pinned safe head and terminal status", async () => {
  const calls = [];
  await repository.recordIndexerObservation(
    {
      chainId: 4663,
      stream: "laypipe",
      safeHead: 129n,
      status: "caught-up",
      observedAt: new Date("2026-08-11T12:00:00.000Z"),
    },
    {
      async query(sql, params, options) {
        calls.push({ sql, params, options });
        return [{ updated: true }];
      },
    },
  );
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /laypipe_runtime_record_observation/);
  assert.deepEqual(calls[0].params, [
    4663,
    "laypipe",
    "129",
    "2026-08-11T12:00:00.000Z",
    "caught-up",
  ]);
  assert.ok(calls[0].options.fetchOptions.signal instanceof AbortSignal);

  for (const rejectedRows of [[], [{ updated: false }]]) {
    await assert.rejects(
      repository.recordIndexerObservation(
        {
          chainId: 4663,
          stream: "laypipe",
          safeHead: 128n,
          status: "bounded",
          observedAt: new Date("2026-08-11T12:00:01.000Z"),
        },
        { async query() { return rejectedRows; } },
      ),
      /missing or non-monotonic/,
    );
  }
});

test("catch-up runner stops at max batches, idle, and deadline without an unbounded loop", async () => {
  let maxCalls = 0;
  const bounded = await ingestion.runCanonicalIndexer({
    env: {
      INDEXER_ENABLED: "true",
      INDEXER_FINALITY_BLOCKS: "20",
      ROBINHOOD_RPC_HTTP_URL: "https://rpc.test/v2/key",
      INDEXER_MAX_BATCHES_PER_RUN: "2",
      INDEXER_RUN_TIMEOUT_MS: "45000",
    },
    syncOnce: async () => {
      maxCalls += 1;
      return { status: "ingested", safeHead: "999", nextBlock: String(maxCalls * 10), rolledBackBlocks: "0", blockCount: 10, eventCount: 0, projectionCount: 0 };
    },
    manifest: manifest(),
    safeHead: 999n,
    recordObservation: async () => undefined,
  });
  assert.equal(bounded.status, "bounded");
  assert.equal(maxCalls, 2);

  let idleCalls = 0;
  const idle = await ingestion.runCanonicalIndexer({
    env: {
      INDEXER_ENABLED: "true",
      INDEXER_FINALITY_BLOCKS: "20",
      ROBINHOOD_RPC_HTTP_URL: "https://rpc.test/v2/key",
      INDEXER_RUN_TIMEOUT_MS: "45000",
    },
    syncOnce: async () => {
      idleCalls += 1;
      return { status: "idle", safeHead: "99", nextBlock: "100", rolledBackBlocks: "0" };
    },
    manifest: manifest(),
    safeHead: 99n,
    recordObservation: async () => undefined,
  });
  assert.equal(idle.status, "caught-up");
  assert.equal(idleCalls, 1);

  let clock = 1_000;
  let deadlineCalls = 0;
  const deadline = await ingestion.runCanonicalIndexer({
    env: {
      INDEXER_ENABLED: "true",
      INDEXER_FINALITY_BLOCKS: "20",
      ROBINHOOD_RPC_HTTP_URL: "https://rpc.test/v2/key",
      INDEXER_RUN_TIMEOUT_MS: "5000",
    },
    now: () => clock,
    syncOnce: async () => {
      deadlineCalls += 1;
      clock = 4_500;
      return { status: "ingested", safeHead: "999", nextBlock: "10", rolledBackBlocks: "0", blockCount: 10, eventCount: 0, projectionCount: 0 };
    },
    manifest: manifest(),
    safeHead: 999n,
    recordObservation: async () => undefined,
  });
  assert.equal(deadline.status, "deadline");
  assert.equal(deadlineCalls, 1);

  let maxClock = 1_000;
  let maxDeadlineCalls = 0;
  const maxDeadlineObservations = [];
  const maxDeadline = await ingestion.runCanonicalIndexer({
    env: {
      INDEXER_ENABLED: "true",
      INDEXER_FINALITY_BLOCKS: "20",
      ROBINHOOD_RPC_HTTP_URL: "https://rpc.test/v2/key",
      INDEXER_RUN_TIMEOUT_MS: "55000",
    },
    now: () => maxClock,
    syncOnce: async () => {
      maxDeadlineCalls += 1;
      // 1,000 + 55,000 - 22,000 = the reserved finalization boundary.
      maxClock = 34_000;
      return { status: "ingested", safeHead: "999", nextBlock: "10", rolledBackBlocks: "0", blockCount: 10, eventCount: 0, projectionCount: 0 };
    },
    manifest: manifest(),
    safeHead: 999n,
    recordObservation: async (value) => maxDeadlineObservations.push(value),
  });
  assert.equal(maxDeadline.status, "deadline");
  assert.equal(maxDeadlineCalls, 1);
  assert.equal(maxDeadlineObservations.length, 1);
  assert.equal(maxDeadlineObservations[0].status, "deadline");
});

test("indexer manifest gate reuses the complete snapshot preflight at the finalized block", () => {
  const source = readFileSync(
    resolve(root, "lib/server/indexer/ingestion.ts"),
    "utf8",
  );
  assert.match(source, /assertAuditedIndexerDeployment\(pinnedProvider, options\.manifest\)/);
  assert.match(
    source,
    /if \(args\.method === "eth_blockNumber"\)[\s\S]*blockTag\(options\.atBlock\)/,
  );
  assert.match(source, /verified\.blockNumber !== options\.atBlock/);
});

test("worker rolls back to an RPC-confirmed stored ancestor before replay", async () => {
  const canonical100 = {
    number: quantity(100),
    hash: hash("a"),
    parentHash: hash("0"),
    timestamp: quantity(1_786_000_000),
  };
  const canonical101 = {
    number: quantity(101),
    hash: hash("b"),
    parentHash: canonical100.hash,
    timestamp: quantity(1_786_000_001),
  };
  const orphan101 = hash("c");
  const rpc = {
    async request({ method, params }) {
      if (method === "eth_chainId") return quantity(4663);
      if (method === "eth_blockNumber") return quantity(102);
      if (method === "eth_getBlockByNumber") {
        if (params[0] === quantity(100)) return canonical100;
        if (params[0] === quantity(101)) return canonical101;
      }
      if (method === "eth_getLogs") return [];
      throw new Error(`unexpected RPC request ${method} ${params?.[0]}`);
    },
  };
  let health = {
    start_block: "100",
    next_block: "102",
    last_processed_block: "101",
    last_processed_hash: orphan101,
  };
  let rollbackRequest;
  let committed;
  const repository = {
    async initializeCursor() {
      throw new Error("cursor already exists");
    },
    async readHealth() {
      return health;
    },
    async loadLaunches() {
      return [];
    },
    async loadRecentBlocks() {
      return [
        { number: "101", hash: orphan101 },
        { number: "100", hash: canonical100.hash },
      ];
    },
    async rollback(options) {
      rollbackRequest = options;
      health = {
        start_block: "100",
        next_block: "101",
        last_processed_block: "100",
        last_processed_hash: canonical100.hash,
      };
      return 1n;
    },
    async ingest(input) {
      committed = model.normalizeCanonicalBatch(input);
      return {
        chainId: input.chainId,
        firstBlock: "101",
        lastBlock: "101",
        blockCount: 1,
        eventCount: 0,
        projectionCount: 0,
      };
    },
  };
  const result = await ingestion.syncCanonicalIndexerOnce({
    rpc,
    manifest: manifest(),
    config: {
      finalityBlocks: 1,
      batchSize: 10,
      maxLogs: 100,
      maxNewLaunches: 10,
      filterChunkSize: 10,
      maxFilterChunks: 10,
      reorgLookback: 16,
      runTimeoutMs: 30_000,
    },
    repository,
    verifyIdentity: async () => undefined,
  });
  assert.deepEqual(rollbackRequest, {
    chainId: 4663,
    ancestorBlock: "100",
    ancestorHash: canonical100.hash,
  });
  assert.equal(result.rolledBackBlocks, "1");
  assert.equal(committed.expectedNextBlock, "101");
  assert.equal(committed.blocks[0].parentHash, canonical100.hash);
});

test("Alchemy authorization hashes the exact raw body and rejects re-serialized JSON", () => {
  const key = "a-secure-test-signing-key-that-is-at-least-32-bytes";
  const rawBody = '{"id":"evt_1", "webhookId":"wh_1","type":"GRAPHQL","event":{}}';
  const signature = createHmac("sha256", key).update(rawBody, "utf8").digest("hex");
  auth.verifyAlchemyWebhookSignature({ rawBody, signature, signingKey: key });
  assert.deepEqual(auth.parseAlchemyWebhookEnvelope(rawBody), {
    id: "evt_1",
    webhookId: "wh_1",
    type: "GRAPHQL",
  });
  assert.throws(
    () =>
      auth.verifyAlchemyWebhookSignature({
        rawBody: JSON.stringify(JSON.parse(rawBody)),
        signature,
        signingKey: key,
      }),
    /signature is invalid/,
  );
});

test("cron authorization uses a configured 32-byte bearer secret", () => {
  const secret = "cron-secret-that-is-definitely-at-least-32-bytes";
  auth.authorizeIndexerCron(`Bearer ${secret}`, secret);
  assert.throws(
    () => auth.authorizeIndexerCron("Bearer wrong", secret),
    /authorization failed/,
  );
  assert.throws(
    () => auth.authorizeIndexerCron(`Bearer ${secret}`, "short"),
    /not configured/,
  );
});

test("HTTP RPC client binds each concurrent response to its own request ID", async () => {
  const client = rpcModule.createHttpIndexerRpc({
    url: "https://rpc.test/v2/secret-is-never-logged",
    deadlineAt: Date.now() + 5_000,
    fetcher: async (_url, init) => {
      const request = JSON.parse(init.body);
      if (request.id === 1) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
      }
      return Response.json({
        jsonrpc: "2.0",
        id: request.id,
        result: request.method,
      });
    },
  });
  assert.deepEqual(
    await Promise.all([
      client.request({ method: "first" }),
      client.request({ method: "second" }),
    ]),
    ["first", "second"],
  );
});

test("Upstash lease coalesces concurrent wake-ups and releases by token", async () => {
  const previousUrl = process.env.UPSTASH_REDIS_REST_KV_REST_API_URL;
  const previousToken = process.env.UPSTASH_REDIS_REST_KV_REST_API_TOKEN;
  process.env.UPSTASH_REDIS_REST_KV_REST_API_URL = "https://laypipe-test.upstash.io";
  process.env.UPSTASH_REDIS_REST_KV_REST_API_TOKEN = "test-upstash-token";
  let storedToken = null;
  const fetcher = async (_url, init) => {
    const command = JSON.parse(init.body);
    if (command[0] === "SET") {
      assert.deepEqual(command.slice(0, 2), ["SET", "laypipe:indexer:lease:v1"]);
      assert.deepEqual(command.slice(3), ["NX", "EX", 60]);
      if (storedToken !== null) return Response.json({ result: null });
      storedToken = command[2];
      return Response.json({ result: "OK" });
    }
    if (command[0] === "EVAL") {
      assert.equal(command[2], "1");
      assert.equal(command[3], "laypipe:indexer:lease:v1");
      assert.match(command[1], /GET[\s\S]*DEL/);
      const matches = storedToken === command[4];
      if (matches) storedToken = null;
      return Response.json({ result: matches ? 1 : 0 });
    }
    throw new Error(`unexpected Redis command ${command[0]}`);
  };
  try {
    const first = await leaseModule.acquireIndexerLease({ fetcher });
    const duplicate = await leaseModule.acquireIndexerLease({ fetcher });
    assert.equal(first.acquired, true);
    assert.equal(duplicate.acquired, false);
    await first.release();
    const next = await leaseModule.acquireIndexerLease({ fetcher });
    assert.equal(next.acquired, true);
    await next.release();
  } finally {
    if (previousUrl === undefined) {
      delete process.env.UPSTASH_REDIS_REST_KV_REST_API_URL;
    } else {
      process.env.UPSTASH_REDIS_REST_KV_REST_API_URL = previousUrl;
    }
    if (previousToken === undefined) {
      delete process.env.UPSTASH_REDIS_REST_KV_REST_API_TOKEN;
    } else {
      process.env.UPSTASH_REDIS_REST_KV_REST_API_TOKEN = previousToken;
    }
  }
});

test("lease fails closed on invalid acquire responses and uses TTL when release cleanup fails", async () => {
  const previousUrl = process.env.UPSTASH_REDIS_REST_KV_REST_API_URL;
  const previousToken = process.env.UPSTASH_REDIS_REST_KV_REST_API_TOKEN;
  process.env.UPSTASH_REDIS_REST_KV_REST_API_URL = "https://laypipe-test.upstash.io";
  process.env.UPSTASH_REDIS_REST_KV_REST_API_TOKEN = "test-upstash-token";
  try {
    await assert.rejects(
      leaseModule.acquireIndexerLease({
        fetcher: async () => Response.json({ result: "INVALID" }),
      }),
      /invalid response/,
    );
    let calls = 0;
    const lease = await leaseModule.acquireIndexerLease({
      fetcher: async () => {
        calls += 1;
        if (calls === 1) return Response.json({ result: "OK" });
        throw new Error("simulated release outage");
      },
    });
    await lease.release();
    await lease.release();
    assert.equal(calls, 2, "release is best-effort and idempotent");
  } finally {
    if (previousUrl === undefined) {
      delete process.env.UPSTASH_REDIS_REST_KV_REST_API_URL;
    } else {
      process.env.UPSTASH_REDIS_REST_KV_REST_API_URL = previousUrl;
    }
    if (previousToken === undefined) {
      delete process.env.UPSTASH_REDIS_REST_KV_REST_API_TOKEN;
    } else {
      process.env.UPSTASH_REDIS_REST_KV_REST_API_TOKEN = previousToken;
    }
  }
});

test("missing Redis uses a local no-op lease outside production", async () => {
  const previousUrl = process.env.UPSTASH_REDIS_REST_KV_REST_API_URL;
  const previousToken = process.env.UPSTASH_REDIS_REST_KV_REST_API_TOKEN;
  delete process.env.UPSTASH_REDIS_REST_KV_REST_API_URL;
  delete process.env.UPSTASH_REDIS_REST_KV_REST_API_TOKEN;
  let fetched = false;
  try {
    const lease = await leaseModule.acquireIndexerLease({
      fetcher: async () => {
        fetched = true;
        throw new Error("must not fetch without credentials");
      },
    });
    assert.equal(lease.acquired, true);
    await lease.release();
    assert.equal(fetched, false);
  } finally {
    if (previousUrl !== undefined) {
      process.env.UPSTASH_REDIS_REST_KV_REST_API_URL = previousUrl;
    }
    if (previousToken !== undefined) {
      process.env.UPSTASH_REDIS_REST_KV_REST_API_TOKEN = previousToken;
    }
  }
});

test("both indexer routes acquire the lease and acknowledge a busy worker with 202", () => {
  for (const relativePath of [
    "app/api/indexer/sync/route.ts",
    "app/api/indexer/webhook/route.ts",
  ]) {
    const source = readFileSync(resolve(root, relativePath), "utf8");
    assert.match(source, /acquireIndexerLease\(\)/);
    assert.match(source, /if \(!lease\.acquired\)/);
    assert.match(source, /status: 202/);
    assert.match(source, /status: "busy"/);
    assert.match(source, /finally \{[\s\S]*await lease\.release\(\)/);
  }
});

test("operational logging skips routine success and emits bounded domain summaries", async () => {
  const originalLog = console.log;
  const lines = [];
  console.log = (value) => lines.push(value);
  try {
    const response = await observability.observeOperationalRequest(
      new Request("https://laypipe.fun/api/indexer/sync", {
        headers: {
          "x-vercel-id": "iad1::request-test",
          authorization: "Bearer must-never-be-logged",
        },
      }),
      "/api/indexer/sync",
      async () => Response.json({ status: "caught-up" }),
    );
    assert.equal(response.status, 200);
  } finally {
    console.log = originalLog;
  }
  assert.equal(lines.length, 0);
  console.log = (value) => lines.push(value);
  try {
    observability.emitOperationalSummary("laypipe.indexer.completed", {
      runStatus: "caught-up",
      safeHead: "129",
      nextBlock: "130",
      detail: "x".repeat(256),
    });
  } finally {
    console.log = originalLog;
  }
  assert.equal(lines.length, 1);
  const completed = JSON.parse(lines[0]);
  assert.equal(completed.event, "laypipe.indexer.completed");
  assert.equal(completed.runStatus, "caught-up");
  assert.equal(completed.safeHead, "129");
  assert.equal(completed.detail.length, 128);
  assert.doesNotMatch(lines.join("\n"), /must-never-be-logged/);
});

test("chunked webhook body stops at the byte ceiling without Content-Length", async () => {
  const encoder = new TextEncoder();
  let cancelled = false;
  let step = 0;
  const body = new ReadableStream({
    pull(controller) {
      step += 1;
      controller.enqueue(encoder.encode(step === 1 ? "12345678" : "abcdefgh"));
      if (step > 2) controller.close();
    },
    cancel() {
      cancelled = true;
    },
  });
  const request = new Request("https://laypipe.fun/api/indexer/webhook", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    duplex: "half",
  });
  await assert.rejects(
    webhookModule.readBoundedWebhookBody(request, 10),
    (error) => error?.status === 413 && error?.code === "BODY_TOO_LARGE",
  );
  assert.equal(cancelled, true);
});

test("bounded webhook preserves the exact signed UTF-8 bytes", async () => {
  const raw = '{"id":"evt_1", "webhookId":"wh_1","type":"GRAPHQL"}';
  const request = new Request("https://laypipe.fun/api/indexer/webhook", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: raw,
  });
  const result = await webhookModule.readBoundedWebhookBody(request, 1024);
  assert.equal(result.text, raw);
  assert.deepEqual(result.bytes, new TextEncoder().encode(raw));
});
