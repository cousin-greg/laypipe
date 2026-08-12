import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { encodeAbiParameters, toFunctionSelector } from "viem";

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
      return loadTypeScript(`${unresolved.slice(root.length + 1)}${extname(unresolved) ? "" : ".ts"}`);
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

const reconciliation = loadTypeScript("lib/server/indexer/reconciliation.ts");

const address = (byte) => `0x${byte.repeat(40)}`;
const hash = (byte) => `0x${byte.repeat(64)}`;
const quantity = (value) => `0x${BigInt(value).toString(16)}`;
const word = (value) => `0x${BigInt(value).toString(16).padStart(64, "0")}`;

function callData(signature, argumentType, argument) {
  const selector = toFunctionSelector(signature);
  if (!argumentType) return selector;
  const encoded = encodeAbiParameters([{ type: argumentType }], [argument]);
  return `${selector}${encoded.slice(2)}`;
}

function callKey(to, data) {
  return `${to.toLowerCase()}:${data.toLowerCase()}`;
}

function setRead(reads, to, signature, result, argumentType, argument) {
  reads.set(callKey(to, callData(signature, argumentType, argument)), BigInt(result));
}

function manifest() {
  const identity = (value) => ({ address: value, runtimeCodehash: hash("4") });
  return {
    manifestVersion: 1,
    environment: "robinhood-production",
    testOnly: false,
    chain: { chainId: 4663, chainName: "Robinhood Chain" },
    deploymentBlock: 100n,
    release: { sourceCommit: "a".repeat(40) },
    contracts: {
      factoryProxy: identity(address("1")),
      factoryImplementation: identity(address("2")),
      tokenImplementation: identity(address("3")),
      hook: identity(address("4")),
      swapRouter: identity(address("5")),
      selfBurner: identity(address("6")),
      revenueRouter: identity(address("7")),
      poolManager: identity(address("8")),
      pipedog: identity(address("9")),
    },
    governance: {},
    launch: {},
    routing: {},
  };
}

function database(overrides = {}) {
  const calls = [];
  const rows = {
    cursor: [{
      start_block: "100",
      next_block: "121",
      last_processed_block: "120",
      last_processed_hash: hash("b"),
      observed_safe_head: "120",
    }],
    block: [{ block_number: "110", block_hash: hash("a") }],
    pools: [],
    "global-fees": [{ platform_deferred: "0", platform_collected: "0", launch_fees: "0" }],
    revenue: [{
      allocated: "0",
      allocated_sequester: "0",
      allocated_treasury: "0",
      allocated_operations: "0",
      sequestered: "0",
      sequester_bounties: "0",
      treasury_routed: "0",
      treasury_bounties: "0",
      operations_collected: "0",
    }],
    "burn-integrity": [{ mismatch_count: "0" }],
    migration: [{ migration_count: "0" }],
    ...overrides,
  };
  return {
    calls,
    async transaction(callback, options) {
      assert.equal(options.readOnly, true);
      assert.equal(options.isolationLevel, "RepeatableRead");
      const tx = {
        query(sql, params, queryOptions) {
          const key = /\/\* reconcile:([a-z-]+) \*\//.exec(sql)?.[1];
          assert.ok(key, "Every reconciliation query must be statically identified.");
          calls.push({ key, sql, params, queryOptions });
          return Promise.resolve(rows[key]);
        },
      };
      return Promise.all(callback(tx));
    },
  };
}

function rpc(reads) {
  const calls = [];
  return {
    calls,
    async request(args) {
      calls.push(args);
      if (args.method === "eth_chainId") return quantity(4663);
      if (args.method === "eth_blockNumber") return quantity(130);
      if (args.method === "eth_getBlockByNumber") {
        return { number: quantity(110), hash: hash("a") };
      }
      if (args.method === "eth_call") {
        assert.equal(args.params[1], quantity(110));
        if (reads) {
          const call = args.params[0];
          const key = callKey(call.to, call.data);
          assert.ok(reads.has(key), `Missing fixture read for ${key}`);
          return word(reads.get(key));
        }
        return word(0);
      }
      throw new Error(`Unexpected RPC method ${args.method}`);
    },
  };
}

function nonzeroFixture() {
  const deployment = manifest();
  const creatorPool = hash("c");
  const selfBurnPool = hash("d");
  const creatorToken = address("a");
  const selfBurnToken = address("b");
  const rows = {
    pools: [
      {
        pool_id: creatorPool,
        token_address: creatorToken,
        fee_mode: "creator",
        accrued: "100",
        swept_creator: "40",
        swept_platform: "20",
        creator_claimed: "10",
        self_burner_claimed: "0",
        non_burner_claims: "0",
        pipedog_in: "0",
        tokens_burned: "0",
        pipedog_bounty: "0",
        burn_count: "0",
        minted: "1000",
        burned: "0",
      },
      {
        pool_id: selfBurnPool,
        token_address: selfBurnToken,
        fee_mode: "self-burn",
        accrued: "200",
        swept_creator: "80",
        swept_platform: "40",
        creator_claimed: "50",
        self_burner_claimed: "50",
        non_burner_claims: "0",
        pipedog_in: "35",
        tokens_burned: "20",
        pipedog_bounty: "5",
        burn_count: "1",
        minted: "2000",
        burned: "20",
      },
    ],
    "global-fees": [{ platform_deferred: "60", platform_collected: "15", launch_fees: "7" }],
    revenue: [{
      allocated: "200",
      allocated_sequester: "50",
      allocated_treasury: "50",
      allocated_operations: "100",
      sequestered: "30",
      sequester_bounties: "2",
      treasury_routed: "20",
      treasury_bounties: "3",
      operations_collected: "40",
    }],
    "burn-integrity": [{ mismatch_count: "0" }],
    migration: [{ migration_count: "0" }],
  };
  const reads = new Map();
  const { hook, pipedog, revenueRouter, selfBurner } = deployment.contracts;

  setRead(reads, hook.address, "pending(bytes32)", 40, "bytes32", creatorPool);
  setRead(reads, hook.address, "tab(bytes32)", 30, "bytes32", creatorPool);
  setRead(reads, creatorToken, "totalSupply()", 1000);
  setRead(reads, hook.address, "pending(bytes32)", 80, "bytes32", selfBurnPool);
  setRead(reads, hook.address, "tab(bytes32)", 30, "bytes32", selfBurnPool);
  setRead(reads, selfBurnToken, "totalSupply()", 1980);
  setRead(reads, selfBurner.address, "unburned(bytes32)", 10, "bytes32", selfBurnPool);

  setRead(reads, hook.address, "platformTab()", 45);
  setRead(reads, pipedog.address, "balanceOf(address)", 105, "address", hook.address);
  setRead(reads, revenueRouter.address, "sequesterTank()", 18);
  setRead(reads, revenueRouter.address, "treasuryTank()", 27);
  setRead(reads, revenueRouter.address, "operationsTab()", 60);
  setRead(reads, revenueRouter.address, "totalRevenueAllocated()", 200);
  setRead(reads, revenueRouter.address, "totalPipedogSequestered()", 30);
  setRead(reads, revenueRouter.address, "totalPipedogTreasuryRouted()", 20);
  setRead(reads, revenueRouter.address, "totalPipedogOperationsCollected()", 40);
  setRead(reads, revenueRouter.address, "totalKeeperBounties()", 5);
  setRead(reads, revenueRouter.address, "totalMigrated()", 0);
  setRead(reads, revenueRouter.address, "unallocated()", 0);
  setRead(reads, pipedog.address, "balanceOf(address)", 105, "address", revenueRouter.address);
  setRead(reads, pipedog.address, "balanceOf(address)", 10, "address", selfBurner.address);

  return {
    deployment,
    creatorPool,
    selfBurnPool,
    creatorToken,
    selfBurnToken,
    rows,
    reads,
  };
}

function reconcileFixture(fixture) {
  return reconciliation.runReadOnlyReconciliation({
    database: database(fixture.rows),
    rpc: rpc(fixture.reads),
    manifest: fixture.deployment,
    pinnedBlock: 110n,
    finalityBlocks: 10,
    maxPools: 100,
    rpcConcurrency: 4,
    verifyManifestSnapshot: async () => undefined,
  });
}

function mismatchMap(report) {
  return new Map(
    report.mismatches.map((item) => [
      `${item.scope}:${item.key}:${item.field}`,
      { indexed: item.indexed, onchain: item.onchain },
    ]),
  );
}

test("read-only reconciliation pins one finalized block and passes exact zero-state accounting", async () => {
  const db = database();
  const provider = rpc();
  let verified = false;
  const report = await reconciliation.runReadOnlyReconciliation({
    database: db,
    rpc: provider,
    manifest: manifest(),
    pinnedBlock: 110n,
    finalityBlocks: 10,
    maxPools: 100,
    rpcConcurrency: 4,
    verifyManifestSnapshot: async (pinned) => {
      verified = true;
      assert.equal(
        await pinned.request({ method: "eth_blockNumber" }),
        quantity(110),
      );
      await assert.rejects(
        pinned.request({ method: "eth_call", params: [{ to: address("1"), data: "0x" }, "latest"] }),
        (error) => error?.code === "RPC_BLOCK_UNPINNED",
      );
    },
  });
  assert.equal(verified, true);
  assert.equal(report.ok, true);
  assert.equal(report.chain.pinnedBlockHash, hash("a"));
  assert.equal(report.coverage.mismatchCount, 0);
  assert.equal(report.accounting.revenue.allocated, "0");
  assert.equal(db.calls.length, 7);
  assert.ok(provider.calls.every((call) => !["eth_sendTransaction", "eth_sendRawTransaction"].includes(call.method)));
});

test("nonzero creator, self-burn, supply, and revenue accounting reconciles exactly", async () => {
  const report = await reconcileFixture(nonzeroFixture());

  assert.equal(report.ok, true);
  assert.equal(report.coverage.pools, 2);
  assert.equal(report.coverage.selfBurnPools, 1);
  assert.equal(report.coverage.burnEvents, "1");
  assert.equal(report.coverage.mismatchCount, 0);
  assert.deepEqual(report.accounting, {
    hook: {
      accrued: "300",
      pending: "120",
      creatorOwed: "60",
      platformDeferred: "45",
      launchFees: "7",
    },
    revenue: {
      allocated: "200",
      sequestered: "30",
      treasuryRouted: "20",
      operationsCollected: "40",
      keeperBounties: "5",
      sequesterTank: "18",
      treasuryTank: "27",
      operationsTab: "60",
    },
    selfBurn: {
      pipedogSpent: "35",
      pipedogBounties: "5",
      tokensBurned: "20",
      unburned: "10",
    },
    tokenSupply: {
      minted: "3000",
      burned: "20",
      current: "2980",
    },
  });
});

test("nonzero per-pool creator and platform fee drift is localized and fail-closed", async () => {
  const fixture = nonzeroFixture();
  fixture.rows.pools[0].swept_platform = "21";
  fixture.rows.pools[0].creator_claimed = "11";
  fixture.rows["global-fees"][0].platform_deferred = "61";

  const report = await reconcileFixture(fixture);
  const mismatches = mismatchMap(report);

  assert.equal(report.ok, false);
  assert.equal(report.coverage.mismatchCount, 4);
  assert.deepEqual(mismatches.get(`hook:${fixture.creatorPool}:pending`), {
    indexed: "39",
    onchain: "40",
  });
  assert.deepEqual(mismatches.get(`hook:${fixture.creatorPool}:creator-tab`), {
    indexed: "29",
    onchain: "30",
  });
  assert.deepEqual(mismatches.get("hook:global:platform-tab"), {
    indexed: "46",
    onchain: "45",
  });
  assert.deepEqual(mismatches.get("hook:global:pipedog-balance"), {
    indexed: "104",
    onchain: "105",
  });
});

test("nonzero burn drift detects event, pool-mode, settlement, and supply inconsistencies", async () => {
  const fixture = nonzeroFixture();
  fixture.rows["burn-integrity"][0].mismatch_count = "2";
  fixture.rows.pools[0].tokens_burned = "1";
  fixture.rows.pools[0].burn_count = "1";
  fixture.rows.pools[1].pipedog_in = "46";
  fixture.rows.pools[1].non_burner_claims = "1";
  fixture.rows.pools[1].burned = "19";

  const report = await reconcileFixture(fixture);
  const mismatches = mismatchMap(report);

  assert.equal(report.ok, false);
  assert.equal(report.coverage.burnEvents, "2");
  assert.equal(report.accounting.selfBurn.tokensBurned, "21");
  assert.equal(report.coverage.mismatchCount, 6);
  assert.deepEqual(mismatches.get("self-burn:all:burn-event-transfer-mismatches"), {
    indexed: "2",
    onchain: "0",
  });
  assert.deepEqual(mismatches.get(`self-burn:${fixture.creatorPool}:burns-on-creator-pool`), {
    indexed: "1",
    onchain: "0",
  });
  assert.deepEqual(mismatches.get(`token-supply:${fixture.selfBurnToken}:total-supply`), {
    indexed: "1981",
    onchain: "1980",
  });
  assert.deepEqual(mismatches.get(`self-burn:${fixture.selfBurnPool}:unburned-pipedog`), {
    indexed: "underflow",
    onchain: "10",
  });
  assert.deepEqual(mismatches.get(`self-burn:${fixture.selfBurnPool}:claims-to-non-burner`), {
    indexed: "1",
    onchain: "0",
  });
  assert.deepEqual(mismatches.get("self-burn:global:pipedog-balance"), {
    indexed: "0",
    onchain: "10",
  });
});

test("nonzero revenue counter, lane, allocation, and custody drift is reported independently", async () => {
  const fixture = nonzeroFixture();
  const { pipedog, revenueRouter } = fixture.deployment.contracts;
  setRead(fixture.reads, revenueRouter.address, "totalRevenueAllocated()", 201);
  setRead(fixture.reads, revenueRouter.address, "totalPipedogSequestered()", 31);
  setRead(fixture.reads, revenueRouter.address, "totalPipedogTreasuryRouted()", 21);
  setRead(fixture.reads, revenueRouter.address, "totalPipedogOperationsCollected()", 41);
  setRead(fixture.reads, revenueRouter.address, "totalKeeperBounties()", 6);
  setRead(fixture.reads, revenueRouter.address, "sequesterTank()", 19);
  setRead(fixture.reads, revenueRouter.address, "treasuryTank()", 28);
  setRead(fixture.reads, revenueRouter.address, "operationsTab()", 61);
  setRead(fixture.reads, revenueRouter.address, "unallocated()", 1);
  setRead(fixture.reads, pipedog.address, "balanceOf(address)", 105, "address", revenueRouter.address);

  const report = await reconcileFixture(fixture);
  const mismatches = mismatchMap(report);
  const expected = new Map([
    ["revenue:global:total-revenue-allocated", { indexed: "200", onchain: "201" }],
    ["revenue:global:total-pipedog-sequestered", { indexed: "30", onchain: "31" }],
    ["revenue:global:total-pipedog-treasury-routed", { indexed: "20", onchain: "21" }],
    ["revenue:global:total-pipedog-operations-collected", { indexed: "40", onchain: "41" }],
    ["revenue:global:total-keeper-bounties", { indexed: "5", onchain: "6" }],
    ["revenue:global:sequester-tank", { indexed: "18", onchain: "19" }],
    ["revenue:global:treasury-tank", { indexed: "27", onchain: "28" }],
    ["revenue:global:operations-tab", { indexed: "60", onchain: "61" }],
    ["revenue:global:unallocated-pipedog", { indexed: "0", onchain: "1" }],
    ["revenue:global:pipedog-balance", { indexed: "109", onchain: "105" }],
  ]);

  assert.equal(report.ok, false);
  assert.equal(report.coverage.mismatchCount, expected.size);
  assert.deepEqual(mismatches, expected);
});

test("router migration evidence or a nonzero migrated counter always blocks reconciliation", async (t) => {
  const cases = [
    { name: "indexed migration with nonzero migrated amount", indexed: "1", onchain: 75 },
    { name: "missing indexed migration", indexed: "0", onchain: 75 },
    { name: "spurious indexed migration", indexed: "1", onchain: 0 },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const fixture = nonzeroFixture();
      fixture.rows.migration[0].migration_count = scenario.indexed;
      setRead(
        fixture.reads,
        fixture.deployment.contracts.revenueRouter.address,
        "totalMigrated()",
        scenario.onchain,
      );

      const report = await reconcileFixture(fixture);

      assert.equal(report.ok, false);
      assert.equal(report.coverage.mismatchCount, 1);
      assert.deepEqual(report.mismatches[0], {
        scope: "revenue",
        key: "global",
        field: "unsupported-router-migration",
        indexed: scenario.indexed,
        onchain: String(scenario.onchain),
      });
      assert.ok(report.omissions.some((item) => item.includes("purpose-built carry-forward")));
    });
  }
});

test("reconciliation rejects non-final blocks and database snapshots behind the pinned head", async () => {
  await assert.rejects(
    reconciliation.runReadOnlyReconciliation({
      database: database(),
      rpc: rpc(),
      manifest: manifest(),
      pinnedBlock: 121n,
      finalityBlocks: 10,
      maxPools: 100,
      rpcConcurrency: 4,
      verifyManifestSnapshot: async () => undefined,
    }),
    (error) => error?.code === "BLOCK_NOT_FINALIZED",
  );

  const behind = database({
    cursor: [{
      start_block: "100",
      next_block: "111",
      last_processed_block: "110",
      last_processed_hash: hash("a"),
      observed_safe_head: "109",
    }],
  });
  await assert.rejects(
    reconciliation.runReadOnlyReconciliation({
      database: behind,
      rpc: rpc(),
      manifest: manifest(),
      pinnedBlock: 110n,
      finalityBlocks: 10,
      maxPools: 100,
      rpcConcurrency: 4,
      verifyManifestSnapshot: async () => undefined,
    }),
    (error) => error?.code === "DATABASE_OBSERVATION_BEHIND",
  );
});

test("reconciliation configuration requires an explicit decimal block and bounded concurrency", () => {
  assert.throws(
    () => reconciliation.readReconciliationConfig({ INDEXER_FINALITY_BLOCKS: "10" }),
    (error) => error?.code === "CONFIG_INVALID",
  );
  assert.deepEqual(
    reconciliation.readReconciliationConfig({
      RECONCILIATION_BLOCK_NUMBER: "123",
      INDEXER_FINALITY_BLOCKS: "10",
      RECONCILIATION_MAX_POOLS: "50",
      RECONCILIATION_RPC_CONCURRENCY: "4",
      RECONCILIATION_TIMEOUT_MS: "45000",
    }),
    {
      pinnedBlock: 123n,
      finalityBlocks: 10,
      maxPools: 50,
      rpcConcurrency: 4,
      timeoutMs: 45000,
    },
  );
});
