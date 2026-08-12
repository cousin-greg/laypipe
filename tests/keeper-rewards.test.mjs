import assert from "node:assert/strict";
import test from "node:test";
import { tsImport } from "tsx/esm/api";
import {
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionResult,
  parseAbi,
} from "viem";

const live = await tsImport("../lib/keeper/live.ts", import.meta.url);
const readModel = await tsImport("../lib/server/keeper/read-model.ts", import.meta.url);
const http = await tsImport("../lib/server/keeper/http.ts", import.meta.url);
const pending = await tsImport("../lib/wallet/pending-keeper-actions.ts", import.meta.url);
const keeper = await tsImport("../lib/web3/keeper-client.ts", import.meta.url);

const wallet = "0x1111111111111111111111111111111111111111";
const otherWallet = "0x2222222222222222222222222222222222222222";
const hook = "0x3333333333333333333333333333333333333333";
const router = "0x4444444444444444444444444444444444444444";
const treasury = "0x5555555555555555555555555555555555555555";
const token = "0x6666666666666666666666666666666666666666";
const poolId = `0x${"77".repeat(32)}`;
const hash = (byte) => `0x${byte.repeat(64)}`;

class MemoryStorage {
  #values = new Map();
  get length() { return this.#values.size; }
  clear() { this.#values.clear(); }
  getItem(key) { return this.#values.get(key) ?? null; }
  key(index) { return [...this.#values.keys()][index] ?? null; }
  removeItem(key) { this.#values.delete(key); }
  setItem(key, value) { this.#values.set(key, String(value)); }
}

function manifest() {
  const identity = (address) => ({ address, runtimeCodehash: hash("a") });
  return {
    contracts: {
      hook: identity(hook),
      revenueRouter: identity(router),
    },
    governance: { treasury },
    routing: {
      revenueMaxSequesterPerCall: 100n,
      revenueMaxTreasuryRoutePerCall: 80n,
      revenueBountyBps: 100,
    },
  };
}

function indexer() {
  return {
    stream: "laypipe",
    nextBlock: "102",
    lastProcessedBlock: "101",
    lastProcessedHash: hash("1"),
    observedSafeHead: "101",
    observedAt: "2026-08-12T12:00:00.000Z",
    lastRunStatus: "caught-up",
    updatedAt: "2026-08-12T12:00:00.000Z",
  };
}

function response() {
  return {
    source: "live",
    chainId: 4663,
    wallet,
    asOfBlock: "101",
    accounting: {
      totalBountyPipedog: "5",
      sequesterBountyPipedog: "2",
      treasuryBountyPipedog: "3",
      sequesterCalls: "1",
      treasuryCalls: "1",
      sweepCalls: "2",
    },
    recentActions: [
      {
        kind: "treasury",
        transactionHash: hash("2"),
        blockNumber: "101",
        blockTimestamp: "2026-08-12T11:59:00.000Z",
        processedPipedog: "100",
        routedPipedog: "97",
        bountyPipedog: "3",
        poolId: null,
      },
      {
        kind: "sweep",
        transactionHash: hash("3"),
        blockNumber: "100",
        blockTimestamp: "2026-08-12T11:58:00.000Z",
        processedPipedog: "40",
        routedPipedog: "40",
        bountyPipedog: "0",
        poolId,
      },
    ],
    sweepCandidates: [{
      poolId,
      tokenAddress: token,
      name: "Pipe",
      symbol: "PIPE",
      indexedPendingPipedog: "9",
    }],
    eligibility: {
      status: "wallet-verification-required",
      reason: "Verify current state.",
    },
    indexer: indexer(),
  };
}

test("keeper API parser binds wallet and enforces exact reward conservation", () => {
  const parsed = live.parseKeeperRewardsResponse(response(), wallet);
  assert.equal(parsed.accounting.totalBountyPipedog, "5");
  assert.equal(parsed.recentActions[0].processedPipedog, "100");
  assert.equal(parsed.recentActions[0].routedPipedog, "97");

  const unbounded = "1" + "0".repeat(100);
  const cumulative = live.parseKeeperRewardsResponse({
    ...response(),
    accounting: {
      totalBountyPipedog: unbounded,
      sequesterBountyPipedog: unbounded,
      treasuryBountyPipedog: "0",
      sequesterCalls: unbounded,
      treasuryCalls: "0",
      sweepCalls: unbounded,
    },
  }, wallet);
  assert.equal(cumulative.accounting.sequesterCalls, unbounded);

  assert.throws(
    () => live.parseKeeperRewardsResponse(response(), otherWallet),
    /does not match the connected wallet/i,
  );
  assert.throws(
    () => live.parseKeeperRewardsResponse({
      ...response(),
      accounting: { ...response().accounting, totalBountyPipedog: "6" },
    }, wallet),
    /inconsistent bounty accounting/i,
  );
  assert.throws(
    () => live.parseKeeperRewardsResponse({
      ...response(),
      recentActions: [{
        ...response().recentActions[0],
        processedPipedog: "99",
      }],
    }, wallet),
    /inconsistent processed and routed/i,
  );
  assert.throws(
    () => live.parseKeeperRewardsResponse({
      ...response(),
      recentActions: [{
        ...response().recentActions[1],
        bountyPipedog: "1",
      }],
    }, wallet),
    /zero-bounty sweep/i,
  );
});

test("keeper read model is repeatable-read, event exact, and never attributes platform collection", async () => {
  const watermarkRows = [{
    stream: "laypipe",
    next_block: "102",
    last_processed_block: "101",
    last_processed_hash: hash("1"),
    observed_safe_head: "101",
    observed_at: "2026-08-12T12:00:00.000Z",
    last_run_status: "caught-up",
    updated_at: "2026-08-12T12:00:00.000Z",
  }];
  const rows = new Map([
    [readModel.KEEPER_WATERMARK_SQL, watermarkRows],
    [readModel.KEEPER_ACCOUNTING_SQL, [{
      total_bounty: "5",
      sequester_bounty: "2",
      treasury_bounty: "3",
      sequester_calls: "1",
      treasury_calls: "1",
      sweep_calls: "2",
    }]],
    [readModel.KEEPER_RECENT_ACTIONS_SQL, [{
      kind: "sequestered",
      transaction_hash: hash("2"),
      block_number: "101",
      block_timestamp: "2026-08-12T11:59:00.000Z",
      processed: "100",
      routed: "98",
      bounty: "2",
      pool_id: null,
    }]],
    [readModel.KEEPER_SWEEP_CANDIDATES_SQL, [{
      pool_id: poolId,
      token_address: token,
      name: "Pipe",
      symbol: "PIPE",
      indexed_pending: "9",
    }]],
  ]);
  const calls = [];
  const query = async (sql, parameters) => {
    calls.push({ sql, parameters });
    return rows.get(sql) ?? [];
  };
  const database = {
    query,
    async transaction(factory, options) {
      assert.deepEqual(
        { isolationLevel: options.isolationLevel, readOnly: options.readOnly, deferrable: options.deferrable },
        { isolationLevel: "RepeatableRead", readOnly: true, deferrable: true },
      );
      return Promise.all(factory({ query }));
    },
  };
  const result = await readModel.loadKeeperRewards(
    database,
    { wallet },
    { now: () => Date.parse("2026-08-12T12:00:30.000Z") },
  );
  assert.equal(result.accounting.totalBountyPipedog, "5");
  assert.equal(result.recentActions[0].kind, "sequester");
  assert.equal(result.recentActions[0].processedPipedog, "100");
  assert.equal(result.sweepCandidates[0].indexedPendingPipedog, "9");
  assert.doesNotMatch(readModel.KEEPER_ACCOUNTING_SQL, /platform-collected|PlatformPayoutCollected/i);
  assert.match(readModel.KEEPER_ACCOUNTING_SQL, /keeper_caller_accounting/);
  assert.doesNotMatch(readModel.KEEPER_ACCOUNTING_SQL, /FROM revenue_events|FROM fee_events/);
  assert.doesNotMatch(readModel.KEEPER_RECENT_ACTIONS_SQL, /platform-collected|PlatformPayoutCollected/i);
  assert.match(readModel.KEEPER_SWEEP_CANDIDATES_SQL, /keeper_pool_fee_state/);
  assert.doesNotMatch(readModel.KEEPER_SWEEP_CANDIDATES_SQL, /fee_events|launches/);
  assert.ok(calls.length >= 5);
});

test("keeper HTTP requires same-origin live requests and rate limits before reads", async () => {
  const base = new Request("https://laypipe.fun/api/keeper", {
    method: "POST",
    headers: { origin: "https://laypipe.fun", "content-type": "application/json" },
    body: JSON.stringify({ wallet }),
  });
  const calls = [];
  const dependencies = {
    marketMode: () => "live",
    requestIp: () => "192.0.2.1",
    rateLimit: async (value) => { calls.push(value); },
    database: async () => ({
      query: async () => { throw new Error("stale"); },
      transaction: async () => { throw new Error("unreachable"); },
    }),
  };
  const result = await http.handleKeeperRewardsRequest(base, dependencies);
  assert.equal(result.status, 503);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].namespace, "keeper-rewards-ip-wallet");
  assert.match(calls[1].identity, new RegExp(wallet));

  const missingOrigin = await http.handleKeeperRewardsRequest(
    new Request("https://laypipe.fun/api/keeper", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ wallet }),
    }),
    dependencies,
  );
  assert.equal(missingOrigin.status, 403);
});

function pendingIntent(action = { kind: "sweep", poolId }, overrides = {}) {
  const call = keeper.keeperActionCall(manifest(), action);
  return {
    chainId: 4663,
    wallet,
    action: action.kind,
    poolId: action.kind === "sweep" ? action.poolId : null,
    target: call.target,
    calldata: call.data,
    hash: null,
    invokedAt: Date.now(),
    ...overrides,
  };
}

test("pending keeper intent is crash-recoverable and binds exact target/calldata/hash", () => {
  const storage = new MemoryStorage();
  const intent = pendingIntent();
  pending.savePendingKeeperAction(storage, intent);
  assert.deepEqual(
    pending.readPendingKeeperActionForWallet(storage, wallet),
    { status: "pending", intent },
  );
  pending.savePendingKeeperActionHash(storage, intent, hash("9"));
  const hashed = { ...intent, hash: hash("9") };
  assert.deepEqual(
    pending.readPendingKeeperActionForWallet(storage, wallet),
    { status: "pending", intent: hashed },
  );
  assert.throws(
    () => pending.removeExactPendingKeeperAction(storage, { ...hashed, calldata: "0x1234" }),
    /integrity|does not match/i,
  );
  pending.removeExactPendingKeeperAction(storage, hashed);
  assert.deepEqual(pending.readPendingKeeperActionForWallet(storage, wallet), { status: "clear" });

  const rejected = pendingIntent({ kind: "collect-platform" });
  pending.savePendingKeeperAction(storage, rejected);
  pending.removeExactUnsubmittedKeeperAction(storage, rejected);
  assert.deepEqual(pending.readPendingKeeperActionForWallet(storage, wallet), { status: "clear" });
});

test("pending keeper reads fail closed on corrupt or unknown calldata", () => {
  const storage = new MemoryStorage();
  storage.setItem(pending.PENDING_KEEPER_ACTIONS_STORAGE_KEY, "{");
  assert.equal(pending.readPendingKeeperActionForWallet(storage, wallet).status, "recovery-required");
  pending.resetPendingKeeperActionStore(storage);
  storage.setItem(
    pending.PENDING_KEEPER_ACTIONS_STORAGE_KEY,
    JSON.stringify([{ ...pendingIntent(), calldata: "0x1234" }]),
  );
  assert.equal(pending.readPendingKeeperActionForWallet(storage, wallet).status, "recovery-required");
});

const abi = parseAbi([
  "function pending(bytes32 poolId) view returns (uint256)",
  "function platformTab() view returns (uint256)",
  "function sequesterTank() view returns (uint256)",
  "function treasuryTank() view returns (uint256)",
  "function unallocated() view returns (uint256)",
  "event PipedogSequestered(address indexed caller, uint256 pipedogSequestered, uint256 bounty, address indexed sink)",
]);

function word(functionName, value) {
  return encodeFunctionResult({ abi, functionName, result: value });
}

function providerFixture({ rejectSend = false, blockNumber = "0x66" } = {}) {
  const calls = [];
  const provider = {
    async request({ method, params }) {
      calls.push({ method, params });
      if (method === "eth_accounts") return [wallet];
      if (method === "eth_chainId") return "0x1237";
      if (method === "eth_blockNumber") return blockNumber;
      if (method === "eth_estimateGas") return "0x5208";
      if (method === "eth_sendTransaction") {
        if (rejectSend) throw Object.assign(new Error("rejected"), { code: 4001 });
        return hash("8");
      }
      if (method === "eth_call") {
        const data = params[0].data;
        if (data.startsWith("0x1808eeb8")) return word("pending", 9n);
        if (data.startsWith("0xbbccad03")) return word("platformTab", 7n);
        if (data.startsWith("0x53c8f6d4")) return word("sequesterTank", 50n);
        if (data.startsWith("0xd6dc79d7")) return word("treasuryTank", 40n);
        if (data.startsWith("0xdf1c455c")) return word("unallocated", 20n);
        throw new Error(`Unexpected call ${data}`);
      }
      throw new Error(`Unexpected method ${method}`);
    },
  };
  return { provider, calls };
}

test("keeper jobs derive exact current gross/routed/bounty values and never expose self-burn", async () => {
  const { provider, calls } = providerFixture();
  let verifications = 0;
  const client = new keeper.KeeperClient(provider, manifest(), {
    verifyDeployment: async () => {
      verifications += 1;
      return { blockNumber: 100n, blockTag: "0x64" };
    },
  });
  const result = await client.readJobs(wallet, [poolId]);
  assert.equal(verifications, 1);
  assert.deepEqual(result.jobs.map((job) => job.action.kind), [
    "sweep",
    "collect-platform",
    "sequester",
    "route-treasury",
  ]);
  const sequester = result.jobs.find((job) => job.action.kind === "sequester");
  assert.equal(sequester.amountPipedog, 55n);
  assert.equal(sequester.bountyPipedog, 0n);
  assert.equal(sequester.routedPipedog, 55n);
  assert.equal(sequester.eligible, true);
  assert.ok(calls.every((call) => call.method !== "eth_sendTransaction"));
});

test("keeper submission performs two fresh manifest snapshots and final context checks", async () => {
  const { provider, calls } = providerFixture({ rejectSend: true });
  let verifications = 0;
  const client = new keeper.KeeperClient(provider, manifest(), {
    verifyDeployment: async () => {
      verifications += 1;
      return { blockNumber: BigInt(100 + verifications), blockTag: `0x${(100 + verifications).toString(16)}` };
    },
  });
  await assert.rejects(
    client.submitAction(wallet, { kind: "sweep", poolId }),
    (error) => !keeper.isKeeperSubmissionIndeterminate(error) && error.code === 4001,
  );
  assert.equal(verifications, 2);
  const send = calls.findIndex((call) => call.method === "eth_sendTransaction");
  assert.ok(send > 0);
  assert.deepEqual(calls.slice(send - 3, send).map((call) => call.method), [
    "eth_accounts",
    "eth_chainId",
    "eth_blockNumber",
  ]);
});

test("keeper submission rejects a regressed wallet head before invocation or send", async () => {
  const { provider, calls } = providerFixture({ blockNumber: "0x65" });
  let verifications = 0;
  let submissionInvocations = 0;
  const client = new keeper.KeeperClient(provider, manifest(), {
    verifyDeployment: async () => {
      verifications += 1;
      return {
        blockNumber: BigInt(100 + verifications),
        blockTag: `0x${(100 + verifications).toString(16)}`,
      };
    },
  });

  await assert.rejects(
    client.submitAction(
      wallet,
      { kind: "sweep", poolId },
      { onSubmissionInvoked: () => { submissionInvocations += 1; } },
    ),
    /wallet RPC head is behind the final verified keeper snapshot/i,
  );

  assert.equal(verifications, 2);
  assert.equal(submissionInvocations, 0);
  assert.ok(calls.some((call) => call.method === "eth_blockNumber"));
  assert.ok(calls.every((call) => call.method !== "eth_sendTransaction"));
});

function eventLog(eventName, args) {
  const topics = encodeEventTopics({ abi, eventName, args });
  const event = abi.find((entry) => entry.type === "event" && entry.name === eventName);
  const unindexed = event.inputs.filter((input) => !input.indexed);
  const values = unindexed.map((input) => args[input.name]);
  return {
    address: router,
    topics,
    data: encodeAbiParameters(unindexed, values),
  };
}

function confirmationProvider({ value = "0x0", status = "0x1", logs = [] } = {}) {
  const txHash = hash("8");
  const blockHash = hash("9");
  const data = keeper.keeperActionCall(manifest(), { kind: "sequester" }).data;
  return {
    async request({ method }) {
      if (method === "eth_chainId") return "0x1237";
      if (method === "eth_getTransactionReceipt") return {
        transactionHash: txHash,
        blockHash,
        blockNumber: "0x64",
        status,
        from: wallet,
        to: router,
        logs,
      };
      if (method === "eth_getTransactionByHash") return {
        hash: txHash,
        from: wallet,
        to: router,
        input: data,
        value,
        blockHash,
        blockNumber: "0x64",
      };
      if (method === "eth_getBlockByNumber") return {
        hash: blockHash,
        number: "0x64",
        transactions: [txHash],
      };
      if (method === "eth_blockNumber") return "0x65";
      throw new Error(`Unexpected confirmation method ${method}`);
    },
  };
}

test("keeper confirmation binds canonical zero-value calldata and exact bounty event", async () => {
  const sink = "0x000000000000000000000000000000000000dEaD";
  const log = eventLog("PipedogSequestered", {
    caller: wallet,
    pipedogSequestered: 99n,
    bounty: 1n,
    sink,
  });
  const client = new keeper.KeeperClient(providerFixture().provider, manifest(), {
    confirmationProvider: confirmationProvider({ logs: [log] }),
  });
  const confirmed = await client.confirmAction(hash("8"), {
    account: wallet,
    action: { kind: "sequester" },
  }, { pollIntervalMs: 1 });
  assert.equal(confirmed.amountPipedog, 99n);
  assert.equal(confirmed.bountyPipedog, 1n);
  assert.equal(confirmed.noOp, false);

  const wrongValue = new keeper.KeeperClient(providerFixture().provider, manifest(), {
    confirmationProvider: confirmationProvider({ value: "0x1", logs: [log] }),
  });
  await assert.rejects(
    wrongValue.confirmAction(hash("8"), {
      account: wallet,
      action: { kind: "sequester" },
    }, { pollIntervalMs: 1 }),
    /input, value, sender, target, or block/i,
  );
});

test("canonical sweep status-one without event is an honest no-op, not a reward", async () => {
  const call = keeper.keeperActionCall(manifest(), { kind: "sweep", poolId });
  const txHash = hash("8");
  const blockHash = hash("9");
  const confirmation = {
    async request({ method }) {
      if (method === "eth_chainId") return "0x1237";
      if (method === "eth_getTransactionReceipt") return {
        transactionHash: txHash, blockHash, blockNumber: "0x64", status: "0x1",
        from: wallet, to: hook, logs: [],
      };
      if (method === "eth_getTransactionByHash") return {
        hash: txHash, from: wallet, to: hook, input: call.data, value: "0x0",
        blockHash, blockNumber: "0x64",
      };
      if (method === "eth_getBlockByNumber") return {
        hash: blockHash, number: "0x64", transactions: [txHash],
      };
      if (method === "eth_blockNumber") return "0x65";
      throw new Error(method);
    },
  };
  const client = new keeper.KeeperClient(providerFixture().provider, manifest(), {
    confirmationProvider: confirmation,
  });
  const result = await client.confirmAction(txHash, {
    account: wallet,
    action: { kind: "sweep", poolId },
  }, { pollIntervalMs: 1 });
  assert.equal(result.noOp, true);
  assert.equal(result.amountPipedog, 0n);
  assert.equal(result.bountyPipedog, 0n);
});
