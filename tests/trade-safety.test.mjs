import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  encodeAbiParameters,
  encodeFunctionData,
  keccak256,
  parseAbi,
} from "viem";
import { tsImport } from "tsx/esm/api";

const trade = await tsImport("../lib/web3/trade-client.ts", import.meta.url);
const pendingTrades = await tsImport(
  "../lib/wallet/pending-trades.ts",
  import.meta.url,
);
const mutationLock = await tsImport(
  "../lib/wallet/mutation-lock.ts",
  import.meta.url,
);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const OWNER = "0x1111111111111111111111111111111111111111";
const PIPEDOG = "0x5Cb6F181081301b44905F3ae15419112ecaBd8A6";
const TOKEN = "0xf1111111111111111111111111111111111111fe";
const OTHER_TOKEN = "0xe1111111111111111111111111111111111111fe";
const FACTORY = "0x2222222222222222222222222222222222222222";
const IMPLEMENTATION = "0x3333333333333333333333333333333333333333";
const HOOK = "0x4444444444444444444444444444444444444444";
const ROUTER = "0x5555555555555555555555555555555555555555";
const OTHER = "0x6666666666666666666666666666666666666666";
const TX_HASH = `0x${"ab".repeat(32)}`;
const BLOCK_HASH = `0x${"cd".repeat(32)}`;

function memoryStorage() {
  const values = new Map();
  return {
    get length() { return values.size; },
    clear() { values.clear(); },
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    key(index) { return [...values.keys()][index] ?? null; },
    removeItem(key) { values.delete(key); },
    setItem(key, value) { values.set(key, String(value)); },
  };
}

function memoryLockManager() {
  const held = new Set();
  const calls = [];
  return {
    calls,
    async request(name, options, callback) {
      calls.push({ name, options });
      if (held.has(name)) return callback(null);
      held.add(name);
      try {
        return await callback({ name, mode: "exclusive" });
      } finally {
        held.delete(name);
      }
    },
  };
}

test("wallet mutation lock is exclusive per normalized wallet and releases after completion", async () => {
  const locks = memoryLockManager();
  let releaseFirst;
  let markFirstEntered;
  const firstEntered = new Promise((resolve) => {
    markFirstEntered = resolve;
  });
  const firstGate = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const first = mutationLock.withWalletMutationLock(locks, OWNER, async () => {
    markFirstEntered();
    await firstGate;
    return "first-complete";
  });
  await firstEntered;

  let contenderEntered = false;
  await assert.rejects(
    mutationLock.withWalletMutationLock(locks, OWNER, () => {
      contenderEntered = true;
    }),
    /another tab is already submitting/i,
  );
  assert.equal(contenderEntered, false);

  const otherWallet = await mutationLock.withWalletMutationLock(
    locks,
    OTHER,
    () => "other-wallet-complete",
  );
  assert.equal(otherWallet, "other-wallet-complete");
  assert.notEqual(
    mutationLock.walletMutationLockName(OWNER),
    mutationLock.walletMutationLockName(OTHER),
  );
  assert.equal(
    mutationLock.walletMutationLockName(PIPEDOG),
    mutationLock.walletMutationLockName(PIPEDOG.toLowerCase()),
  );
  assert.match(mutationLock.walletMutationLockName(OWNER), /:4663:/);

  releaseFirst();
  assert.equal(await first, "first-complete");
  assert.equal(
    await mutationLock.withWalletMutationLock(locks, OWNER, () => "released"),
    "released",
  );
  assert.equal(
    locks.calls.every(
      ({ options }) =>
        options.mode === "exclusive" && options.ifAvailable === true,
    ),
    true,
  );
});

test("wallet mutation lock fails closed without a usable Web Locks API", async () => {
  let entered = false;
  await assert.rejects(
    mutationLock.withWalletMutationLock(undefined, OWNER, () => {
      entered = true;
    }),
    /cannot provide the required cross-tab wallet lock/i,
  );
  assert.equal(entered, false);

  await assert.rejects(
    mutationLock.withWalletMutationLock(
      { request: async () => { throw new Error("lock service failed"); } },
      OWNER,
      () => {
        entered = true;
      },
    ),
    /wallet lock could not be acquired/i,
  );
  assert.equal(entered, false);
  assert.throws(
    () => mutationLock.walletMutationLockName("0x0000000000000000000000000000000000000000"),
    /valid nonzero wallet/i,
  );
});

test("pending trade intent survives reload and creates a wallet-wide mutation lock", () => {
  const storage = memoryStorage();
  const poolId = poolIdFor();
  const intent = {
    chainId: 4663,
    wallet: OWNER,
    tokenAddress: TOKEN,
    poolId,
    action: "approval",
    target: PIPEDOG,
    calldata: approvalData(10n),
    value: "0x0",
    approval: {
      side: "buy",
      token: PIPEDOG,
      amount: "10",
      kind: "approve-exact",
    },
    hash: null,
    invokedAt: Date.now(),
  };
  pendingTrades.savePendingTrade(storage, intent);
  assert.deepEqual(
    pendingTrades.readPendingTrade(storage, OWNER, TOKEN, poolId),
    intent,
  );
  assert.deepEqual(
    pendingTrades.readPendingTradeForWallet(storage, OWNER),
    intent,
  );
  assert.equal(
    pendingTrades.readPendingTrade(storage, OTHER, TOKEN, poolId),
    null,
  );
  assert.equal(
    pendingTrades.readPendingTrade(
      storage,
      OWNER,
      OTHER_TOKEN,
      poolIdFor(OTHER_TOKEN),
    ),
    null,
  );
  assert.throws(
    () => pendingTrades.savePendingTrade(storage, {
      ...intent,
      tokenAddress: OTHER_TOKEN,
      poolId: poolIdFor(OTHER_TOKEN),
    }),
    /wallet already has a pending trade action/i,
  );
  pendingTrades.savePendingTrade(storage, {
    ...intent,
    wallet: OTHER,
    tokenAddress: OTHER_TOKEN,
    poolId: poolIdFor(OTHER_TOKEN),
  });
  assert.equal(
    pendingTrades.readPendingTradeForWallet(storage, OTHER)?.tokenAddress,
    OTHER_TOKEN,
  );
  pendingTrades.savePendingTradeHash(storage, intent, TX_HASH);
  assert.equal(
    pendingTrades.readPendingTrade(storage, OWNER, TOKEN, poolId).hash,
    TX_HASH,
  );
  pendingTrades.removeExactPendingTrade(storage, { ...intent, hash: TX_HASH });
  assert.equal(
    pendingTrades.readPendingTrade(storage, OWNER, TOKEN, poolId),
    null,
  );
});

test("a stale trade reconciler cannot erase a newer same-pool intent", () => {
  const storage = memoryStorage();
  const original = {
    chainId: 4663,
    wallet: OWNER,
    tokenAddress: TOKEN,
    poolId: poolIdFor(),
    action: "approval",
    target: PIPEDOG,
    calldata: approvalData(10n),
    value: "0x0",
    approval: {
      side: "buy",
      token: PIPEDOG,
      amount: "10",
      kind: "approve-exact",
    },
    hash: null,
    invokedAt: Date.now(),
  };
  pendingTrades.savePendingTrade(storage, original);
  pendingTrades.savePendingTradeHash(storage, original, TX_HASH);
  const staleResolved = pendingTrades.readPendingTradeForWallet(storage, OWNER);
  pendingTrades.removeExactPendingTrade(storage, staleResolved);

  const replacement = { ...original, invokedAt: original.invokedAt + 1 };
  pendingTrades.savePendingTrade(storage, replacement);
  assert.throws(
    () => pendingTrades.removeExactPendingTrade(storage, staleResolved),
    /does not match the saved exact record/i,
  );
  assert.throws(
    () => pendingTrades.removeExactUnsubmittedPendingTrade(storage, original),
    /no longer matches the saved exact record/i,
  );
  assert.deepEqual(
    pendingTrades.readPendingTradeForWallet(storage, OWNER),
    replacement,
  );
});

test("pending trade storage fails closed on unreadable, malformed, invalid, duplicate, and over-cap state", () => {
  const key = "laypipe.pending-trades.v1";
  const unreadable = memoryStorage();
  unreadable.getItem = () => {
    throw new Error("storage denied");
  };
  assert.throws(
    () => pendingTrades.readPendingTrade(unreadable, OWNER, TOKEN, poolIdFor()),
    /trading is blocked/i,
  );

  for (const value of ["{broken", JSON.stringify({}), JSON.stringify([{}])]) {
    const storage = memoryStorage();
    storage.setItem(key, value);
    assert.throws(
      () => pendingTrades.readPendingTrade(storage, OWNER, TOKEN, poolIdFor()),
      /blocked/i,
    );
  }

  const overCap = memoryStorage();
  overCap.setItem(key, JSON.stringify(Array.from({ length: 21 }, () => ({}))));
  assert.throws(
    () => pendingTrades.readPendingTrade(overCap, OWNER, TOKEN, poolIdFor()),
    /over capacity/i,
  );

  const storage = memoryStorage();
  const intent = {
    chainId: 4663,
    wallet: OWNER,
    tokenAddress: TOKEN,
    poolId: poolIdFor(),
    action: "approval",
    target: PIPEDOG,
    calldata: approvalData(10n),
    value: "0x0",
    approval: {
      side: "buy",
      token: PIPEDOG,
      amount: "10",
      kind: "approve-exact",
    },
    hash: null,
    invokedAt: Date.now(),
  };
  pendingTrades.savePendingTrade(storage, intent);
  assert.throws(
    () => pendingTrades.savePendingTrade(storage, intent),
    /wallet already has a pending trade action/i,
  );
  const duplicateWallet = memoryStorage();
  duplicateWallet.setItem(key, JSON.stringify([
    intent,
    {
      ...intent,
      tokenAddress: OTHER_TOKEN,
      poolId: poolIdFor(OTHER_TOKEN),
    },
  ]));
  assert.throws(
    () => pendingTrades.readPendingTradeForWallet(duplicateWallet, OWNER),
    /more than one saved trade action exists for this wallet/i,
  );
  assert.throws(
    () =>
      pendingTrades.savePendingTradeHash(
        storage,
        { ...intent, calldata: approvalData(11n) },
        TX_HASH,
      ),
    /does not match the saved exact intent/i,
  );
});

test("persisted trade intent retains every field needed for canonical reload reconciliation", () => {
  const storage = memoryStorage();
  const createdAtMs = Date.now();
  const intent = {
    chainId: 4663,
    wallet: OWNER,
    tokenAddress: TOKEN,
    poolId: poolIdFor(),
    action: "trade",
    target: ROUTER,
    calldata: "0x1234",
    value: "0x0",
    trade: {
      side: "buy",
      inputAmount: "10000",
      expectedOutput: "10000",
      minimumOutput: "9900",
      slippageBps: 100,
      verifiedBlockNumber: "100",
      deadlineBlock: (100n + trade.TRADE_DEADLINE_BLOCK_BUDGET).toString(),
      createdAtMs,
      expiresAtMs: createdAtMs + 30_000,
    },
    hash: null,
    invokedAt: createdAtMs,
  };
  pendingTrades.savePendingTrade(storage, intent);
  pendingTrades.savePendingTradeHash(storage, intent, TX_HASH);
  const restored = pendingTrades.readPendingTrade(
    storage,
    OWNER,
    TOKEN,
    poolIdFor(),
  );
  assert.deepEqual(restored, { ...intent, hash: TX_HASH });

  assert.throws(
    () =>
      pendingTrades.savePendingTrade(memoryStorage(), {
        ...intent,
        trade: { ...intent.trade, deadlineBlock: "103" },
        hash: null,
      }),
    /could not be validated/i,
  );
});

const tokenReads = parseAbi([
  "function factory() view returns (address)",
  "function poolId() view returns (bytes32)",
  "function hook() view returns (address)",
  "function decimals() view returns (uint8)",
]);

function poolIdFor(token = TOKEN, hook = HOOK, tickSpacing = 60) {
  return keccak256(
    encodeAbiParameters(
      [
        {
          type: "tuple",
          components: [
            { name: "currency0", type: "address" },
            { name: "currency1", type: "address" },
            { name: "fee", type: "uint24" },
            { name: "tickSpacing", type: "int24" },
            { name: "hooks", type: "address" },
          ],
        },
      ],
      [{ currency0: PIPEDOG, currency1: token, fee: 0, tickSpacing, hooks: hook }],
    ),
  );
}

function contract(address) {
  return { address, runtimeCodehash: `0x${"11".repeat(32)}` };
}

function manifest() {
  return {
    manifestVersion: 1,
    environment: "robinhood-production",
    testOnly: false,
    chain: { chainId: 4663, chainName: "Robinhood Chain" },
    deploymentBlock: 1n,
    release: {
      sourceCommit: "a".repeat(40),
      compilerVersion: "0.8.26",
      abiBundleSha256: `0x${"22".repeat(32)}`,
      artifactBundleSha256: `0x${"33".repeat(32)}`,
    },
    contracts: {
      factoryProxy: contract(FACTORY),
      factoryImplementation: contract(OTHER),
      tokenImplementation: contract(IMPLEMENTATION),
      hook: contract(HOOK),
      swapRouter: contract(ROUTER),
      selfBurner: contract("0x7777777777777777777777777777777777777777"),
      revenueRouter: contract("0x8888888888888888888888888888888888888888"),
      poolManager: contract("0x9999999999999999999999999999999999999999"),
      pipedog: contract(PIPEDOG),
    },
    governance: { finalOwner: OTHER, treasury: OTHER, operations: OTHER },
    launch: {
      launchEnabled: true,
      launchFee: 1n,
      creator: {
        id: 0n,
        config: { tickSpacing: 60, selfBurn: false },
      },
      selfBurn: {
        id: 1n,
        config: { tickSpacing: 60, selfBurn: true },
      },
    },
    routing: {},
  };
}

function identity(overrides = {}) {
  return {
    chainId: 4663,
    tokenAddress: TOKEN,
    poolId: poolIdFor(),
    hookAddress: HOOK,
    configId: "0",
    feeMode: "creator",
    ...overrides,
  };
}

function encoded(value, type = "uint256") {
  return encodeAbiParameters([{ type }], [value]);
}

function selector(data) {
  return data.slice(0, 10).toLowerCase();
}

function mockProvider({
  initialAllowance = 10n,
  expectedOutput = 25n,
  submissionBlock = 100n,
  afterEstimate,
  sendError,
  sendResult = TX_HASH,
} = {}) {
  let allowance = initialAllowance;
  let estimated = false;
  const calls = [];
  return {
    calls,
    get allowance() {
      return allowance;
    },
    async request({ method, params = [] }) {
      calls.push({ method, params });
      if (method === "eth_accounts") {
        return afterEstimate?.account && estimated ? [afterEstimate.account] : [OWNER];
      }
      if (method === "eth_chainId") {
        return afterEstimate?.chainId && estimated
          ? `0x${afterEstimate.chainId.toString(16)}`
          : "0x1237";
      }
      if (method === "eth_blockNumber") {
        const number = afterEstimate?.blockNumber && estimated
          ? afterEstimate.blockNumber
          : submissionBlock;
        return `0x${number.toString(16)}`;
      }
      if (method === "eth_getCode") {
        return trade.__testExpectedCloneRuntime(IMPLEMENTATION);
      }
      if (method === "eth_call") {
        const transaction = params[0];
        const target = transaction.to.toLowerCase();
        const sig = selector(transaction.data);
        if (target === TOKEN.toLowerCase()) {
          if (sig === selector(encodeFunctionData({ abi: tokenReads, functionName: "factory" }))) {
            return encoded(FACTORY, "address");
          }
          if (sig === selector(encodeFunctionData({ abi: tokenReads, functionName: "poolId" }))) {
            return encoded(poolIdFor(), "bytes32");
          }
          if (sig === selector(encodeFunctionData({ abi: tokenReads, functionName: "hook" }))) {
            return encoded(HOOK, "address");
          }
          if (sig === selector(encodeFunctionData({ abi: tokenReads, functionName: "decimals" }))) {
            return encoded(18, "uint8");
          }
        }
        if (sig === "0xdd62ed3e") return encoded(allowance);
        if (sig === "0x70a08231") return encoded(1_000_000n);
        if (sig === "0x095ea7b3") return encoded(true, "bool");
        if (target === ROUTER.toLowerCase()) return encoded(expectedOutput);
        throw new Error(`Unexpected eth_call ${target} ${sig}`);
      }
      if (method === "eth_estimateGas") {
        estimated = true;
        afterEstimate?.run?.();
        return "0x5208";
      }
      if (method === "eth_sendTransaction") {
        if (sendError) throw sendError;
        const transaction = params[0];
        if (selector(transaction.data) === "0x095ea7b3") {
          allowance = BigInt(`0x${transaction.data.slice(-64)}`);
        }
        return sendResult;
      }
      throw new Error(`Unexpected method ${method}`);
    },
  };
}

function approvalData(amount) {
  return encodeFunctionData({
    abi: parseAbi(["function approve(address spender,uint256 amount) returns (bool)"]),
    functionName: "approve",
    args: [ROUTER, amount],
  });
}

function tradeLog(quote, { inputSpent = quote.inputAmount, outputReceived = quote.minimumOutput } = {}) {
  return {
    address: ROUTER,
    topics: [
      trade.__testTradeEventTopic(quote.side),
      quote.poolId,
      trade.__testAddressTopic(quote.owner),
      trade.__testAddressTopic(quote.owner),
    ],
    data: encodeAbiParameters(
      [{ type: "uint256" }, { type: "uint256" }],
      [inputSpent, outputReceived],
    ),
  };
}

function confirmationProvider({
  from = OWNER,
  to = ROUTER,
  input,
  value = "0x0",
  status = "0x1",
  blockNumber = 100n,
  head = 101n,
  blockHash = BLOCK_HASH,
  receiptBlockHash = blockHash,
  transactionBlockHash = receiptBlockHash,
  logs = [],
  allowance = 0n,
  receipt = true,
} = {}) {
  const calls = [];
  return {
    calls,
    async request({ method }) {
      calls.push(method);
      if (method === "eth_chainId") return "0x1237";
      if (method === "eth_getTransactionReceipt") {
        if (!receipt) return null;
        return {
          transactionHash: TX_HASH,
          blockHash: receiptBlockHash,
          blockNumber: `0x${blockNumber.toString(16)}`,
          status,
          from,
          to,
          logs,
        };
      }
      if (method === "eth_getTransactionByHash") {
        return {
          hash: TX_HASH,
          from,
          to,
          input: typeof input === "function" ? input() : input,
          value,
          blockHash: transactionBlockHash,
          blockNumber: `0x${blockNumber.toString(16)}`,
        };
      }
      if (method === "eth_getBlockByNumber") {
        return {
          hash: blockHash,
          number: `0x${blockNumber.toString(16)}`,
          transactions: [TX_HASH],
        };
      }
      if (method === "eth_blockNumber") return `0x${head.toString(16)}`;
      if (method === "eth_call") return encoded(allowance);
      throw new Error(`Unexpected confirmation method ${method}`);
    },
  };
}

const verifiedSnapshot = async () => ({ blockNumber: 100n, blockTag: "0x64" });

test("pool identity is reconstructed from canonical PIPEDOG and audited config", () => {
  const resolved = trade.resolveVerifiedTradePool(manifest(), identity());
  assert.equal(resolved.poolId.toLowerCase(), poolIdFor().toLowerCase());
  assert.equal(resolved.key.currency0.toLowerCase(), PIPEDOG.toLowerCase());
  assert.equal(resolved.key.currency1.toLowerCase(), TOKEN.toLowerCase());
  assert.equal(resolved.key.fee, 0);

  assert.throws(
    () => trade.resolveVerifiedTradePool(manifest(), identity({ hookAddress: OTHER })),
    /hook does not match/i,
  );
  assert.throws(
    () => trade.resolveVerifiedTradePool(manifest(), identity({ configId: "1" })),
    /fee mode does not match/i,
  );
  assert.throws(
    () => trade.resolveVerifiedTradePool(manifest(), identity({ poolId: `0x${"00".repeat(32)}` })),
    /pool ID does not match/i,
  );
});

test("trusted quotes require exact allowance and derive a nonzero slippage floor", async () => {
  const wrong = mockProvider({ initialAllowance: 0n });
  const wrongClient = new trade.LaypipeTradeClient(wrong, manifest(), identity(), {
    verifyDeployment: verifiedSnapshot,
    now: () => 1_000,
  });
  await assert.rejects(
    wrongClient.prepareQuote({ owner: OWNER, side: "buy", inputAmount: 10n, slippageBps: 100 }),
    /single-use allowance equal to the exact input/i,
  );

  const provider = mockProvider({ initialAllowance: 10n, expectedOutput: 25n });
  const client = new trade.LaypipeTradeClient(provider, manifest(), identity(), {
    verifyDeployment: verifiedSnapshot,
    now: () => 1_000,
  });
  const quote = await client.prepareQuote({
    owner: OWNER,
    side: "buy",
    inputAmount: 10n,
    slippageBps: 100,
  });
  assert.equal(quote.expectedOutput, 25n);
  assert.equal(quote.minimumOutput, 24n);
  assert.equal(quote.verifiedBlockNumber, 100n);
  assert.equal(
    quote.deadlineBlock,
    quote.verifiedBlockNumber + trade.TRADE_DEADLINE_BLOCK_BUDGET,
  );
  assert.equal(quote.expiresAtMs, 31_000);
  assert.ok(
    provider.calls.some(
      ({ method, params }) =>
        method === "eth_call" && params[0].to.toLowerCase() === ROUTER.toLowerCase(),
    ),
  );
});

test("approval and trade transactions simulate first, have no native value, and never approve max uint", async () => {
  const approvalProvider = mockProvider({ initialAllowance: 0n });
  const approvalClient = new trade.LaypipeTradeClient(
    approvalProvider,
    manifest(),
    identity(),
    { verifyDeployment: verifiedSnapshot },
  );
  const pendingApproval = await approvalClient.sendNextApproval(OWNER, "buy", 10n);
  assert.equal(pendingApproval.amount, 10n);
  const approvalSendIndex = approvalProvider.calls.findIndex(({ method }) => method === "eth_sendTransaction");
  const approvalEstimateIndex = approvalProvider.calls.findIndex(({ method }) => method === "eth_estimateGas");
  assert.ok(approvalEstimateIndex >= 0 && approvalEstimateIndex < approvalSendIndex);
  const approvalTransaction = approvalProvider.calls[approvalSendIndex].params[0];
  assert.equal("value" in approvalTransaction, false);
  assert.equal(BigInt(`0x${approvalTransaction.data.slice(-64)}`), 10n);

  const provider = mockProvider({ initialAllowance: 10n, expectedOutput: 25n });
  const client = new trade.LaypipeTradeClient(provider, manifest(), identity(), {
    verifyDeployment: verifiedSnapshot,
    now: () => 1_000,
  });
  const quote = await client.prepareQuote({ owner: OWNER, side: "buy", inputAmount: 10n, slippageBps: 100 });
  const beforeSend = provider.calls.length;
  const pending = await client.sendTrade(quote);
  assert.equal(pending.hash, TX_HASH);
  const mutationCalls = provider.calls.slice(beforeSend);
  const routerSimulation = mutationCalls.findIndex(
    ({ method, params }) => method === "eth_call" && params[0].to.toLowerCase() === ROUTER.toLowerCase(),
  );
  const estimate = mutationCalls.findIndex(({ method }) => method === "eth_estimateGas");
  const send = mutationCalls.findIndex(({ method }) => method === "eth_sendTransaction");
  assert.ok(routerSimulation >= 0 && routerSimulation < estimate && estimate < send);
  const submittedData = mutationCalls[send].params[0].data;
  assert.equal(BigInt(`0x${submittedData.slice(-64)}`), quote.deadlineBlock);
  assert.deepEqual(
    mutationCalls.slice(estimate + 1, send).map(({ method }) => method).sort(),
    ["eth_accounts", "eth_blockNumber", "eth_chainId"].sort(),
  );
  assert.equal("value" in mutationCalls[send].params[0], false);
});

test("sell flow approves the launched token, never PIPEDOG or native value", async () => {
  const provider = mockProvider({ initialAllowance: 0n });
  const client = new trade.LaypipeTradeClient(provider, manifest(), identity(), {
    verifyDeployment: verifiedSnapshot,
  });
  const pending = await client.sendNextApproval(OWNER, "sell", 7n);
  assert.equal(pending.token.toLowerCase(), TOKEN.toLowerCase());
  const sent = provider.calls.find(({ method }) => method === "eth_sendTransaction").params[0];
  assert.equal(sent.to.toLowerCase(), TOKEN.toLowerCase());
  assert.equal(BigInt(`0x${sent.data.slice(-64)}`), 7n);
  assert.equal("value" in sent, false);
});

test("quote age and minimum-output invariants fail closed", () => {
  assert.equal(trade.applyTradeSlippage(10_000n, 100), 9_900n);
  assert.throws(() => trade.applyTradeSlippage(10_000n, 49), /between 0.5% and 5%/i);
  assert.throws(() => trade.applyTradeSlippage(10_000n, 501), /between 0.5% and 5%/i);
  assert.throws(() => trade.applyTradeSlippage(1n, 100), /too small/i);
});

test("trade submission rechecks time, canonical head, chain, and account after estimation", async () => {
  const cases = [
    {
      name: "block drift",
      afterEstimate: {
        blockNumber: 100n + trade.TRADE_DEADLINE_BLOCK_BUDGET + 1n,
      },
      expected: /block drift|deadline/i,
    },
    {
      name: "chain drift",
      afterEstimate: { chainId: 1n },
      expected: /chain changed/i,
    },
    {
      name: "account drift",
      afterEstimate: { account: OTHER },
      expected: /account changed/i,
    },
  ];
  for (const scenario of cases) {
    const provider = mockProvider({ afterEstimate: scenario.afterEstimate });
    const client = new trade.LaypipeTradeClient(provider, manifest(), identity(), {
      verifyDeployment: verifiedSnapshot,
      now: () => 1_000,
    });
    const quote = await client.prepareQuote({
      owner: OWNER,
      side: "buy",
      inputAmount: 10n,
      slippageBps: 100,
    });
    await assert.rejects(client.sendTrade(quote), scenario.expected, scenario.name);
    assert.equal(
      provider.calls.some(({ method }) => method === "eth_sendTransaction"),
      false,
      scenario.name,
    );
  }

  let now = 1_000;
  const provider = mockProvider({ afterEstimate: { run: () => { now = 31_001; } } });
  const client = new trade.LaypipeTradeClient(provider, manifest(), identity(), {
    verifyDeployment: verifiedSnapshot,
    now: () => now,
  });
  const quote = await client.prepareQuote({
    owner: OWNER,
    side: "buy",
    inputAmount: 10n,
    slippageBps: 100,
  });
  await assert.rejects(client.sendTrade(quote), /quote.*expired/i);
  assert.equal(provider.calls.some(({ method }) => method === "eth_sendTransaction"), false);
});

test("deadline policy tolerates fast L2 cadence but remains bounded by wall time and blocks", async () => {
  assert.equal(trade.TRADE_QUOTE_TTL_MS, 30_000);
  assert.equal(trade.TRADE_WALLET_SUBMISSION_GRACE_MS, 30_000);
  assert.equal(trade.TRADE_DEADLINE_STRESS_BLOCKS_PER_SECOND, 20);
  assert.equal(trade.TRADE_DEADLINE_BLOCK_BUDGET, 1_200n);

  let fastNow = 1_000;
  const fastProvider = mockProvider({
    afterEstimate: {
      // Forty L2 blocks/second across nearly the complete 30-second UI
      // window is twice the policy's rate assumption and still reaches,
      // but does not exceed, the bounded router deadline.
      blockNumber: 1_300n,
      run: () => {
        fastNow = 30_999;
      },
    },
  });
  let fastVerificationCount = 0;
  const fastVerifiedSnapshot = async () => {
    const blockNumber = fastVerificationCount === 0 ? 100n : 1_299n;
    fastVerificationCount += 1;
    return {
      blockNumber,
      blockTag: `0x${blockNumber.toString(16)}`,
    };
  };
  const fastClient = new trade.LaypipeTradeClient(
    fastProvider,
    manifest(),
    identity(),
    { verifyDeployment: fastVerifiedSnapshot, now: () => fastNow },
  );
  const fastQuote = await fastClient.prepareQuote({
    owner: OWNER,
    side: "buy",
    inputAmount: 10n,
    slippageBps: 100,
  });
  assert.equal(fastQuote.deadlineBlock, 1_300n);
  assert.equal((await fastClient.sendTrade(fastQuote)).hash, TX_HASH);
  const protectedRouterCalls = fastProvider.calls.filter(
    ({ method, params }) =>
      method === "eth_call" &&
      params[0].to.toLowerCase() === ROUTER.toLowerCase(),
  );
  assert.equal(protectedRouterCalls.at(-1).params[1], "0x513");

  const overBudgetProvider = mockProvider({
    afterEstimate: { blockNumber: 1_301n },
  });
  const overBudgetClient = new trade.LaypipeTradeClient(
    overBudgetProvider,
    manifest(),
    identity(),
    { verifyDeployment: verifiedSnapshot, now: () => 1_000 },
  );
  const overBudgetQuote = await overBudgetClient.prepareQuote({
    owner: OWNER,
    side: "buy",
    inputAmount: 10n,
    slippageBps: 100,
  });
  await assert.rejects(
    overBudgetClient.sendTrade(overBudgetQuote),
    /block drift|deadline/i,
  );
  assert.equal(
    overBudgetProvider.calls.some(({ method }) => method === "eth_sendTransaction"),
    false,
  );

  let slowNow = 1_000;
  const slowProvider = mockProvider({
    afterEstimate: {
      blockNumber: 101n,
      run: () => {
        slowNow = 31_001;
      },
    },
  });
  const slowClient = new trade.LaypipeTradeClient(
    slowProvider,
    manifest(),
    identity(),
    { verifyDeployment: verifiedSnapshot, now: () => slowNow },
  );
  const slowQuote = await slowClient.prepareQuote({
    owner: OWNER,
    side: "buy",
    inputAmount: 10n,
    slippageBps: 100,
  });
  await assert.rejects(slowClient.sendTrade(slowQuote), /quote.*expired/i);
  assert.equal(
    slowProvider.calls.some(({ method }) => method === "eth_sendTransaction"),
    false,
  );
});

test("deadline is quote-bound and cannot be extended in client state", async () => {
  const provider = mockProvider();
  const client = new trade.LaypipeTradeClient(provider, manifest(), identity(), {
    verifyDeployment: verifiedSnapshot,
    now: () => 1_000,
  });
  const quote = await client.prepareQuote({
    owner: OWNER,
    side: "buy",
    inputAmount: 10n,
    slippageBps: 100,
  });
  await assert.rejects(
    client.sendTrade({ ...quote, deadlineBlock: quote.deadlineBlock + 1n }),
    /deadline was modified/i,
  );
  assert.equal(provider.calls.some(({ method }) => method === "eth_sendTransaction"), false);
});

test("only explicit EIP-1193 rejection is safe after invoking sendTransaction", async () => {
  const explicit = Object.assign(new Error("User rejected"), { code: 4001 });
  const explicitProvider = mockProvider({ initialAllowance: 0n, sendError: explicit });
  const explicitClient = new trade.LaypipeTradeClient(
    explicitProvider,
    manifest(),
    identity(),
    { verifyDeployment: verifiedSnapshot },
  );
  await assert.rejects(
    explicitClient.sendNextApproval(OWNER, "buy", 10n),
    (error) => !trade.isTradeSubmissionIndeterminate(error) && error.code === 4001,
  );

  for (const sendFailure of [
    Object.assign(new Error("transport disconnected"), { code: 4900 }),
    new Error("User rejected without a standards code"),
  ]) {
    const provider = mockProvider({ initialAllowance: 0n, sendError: sendFailure });
    const client = new trade.LaypipeTradeClient(provider, manifest(), identity(), {
      verifyDeployment: verifiedSnapshot,
    });
    await assert.rejects(
      client.sendNextApproval(OWNER, "buy", 10n),
      (error) =>
        trade.isTradeSubmissionIndeterminate(error) &&
        /may have broadcast/i.test(error.message),
    );
  }

  const malformedProvider = mockProvider({ initialAllowance: 0n, sendResult: "0x1234" });
  const malformedClient = new trade.LaypipeTradeClient(
    malformedProvider,
    manifest(),
    identity(),
    { verifyDeployment: verifiedSnapshot },
  );
  await assert.rejects(
    malformedClient.sendNextApproval(OWNER, "buy", 10n),
    (error) => trade.isTradeSubmissionIndeterminate(error),
  );
});

test("exact recovery callbacks run before send and post-hash persistence failure is indeterminate", async () => {
  const blockedProvider = mockProvider({ initialAllowance: 0n });
  const blockedClient = new trade.LaypipeTradeClient(
    blockedProvider,
    manifest(),
    identity(),
    { verifyDeployment: verifiedSnapshot },
  );
  await assert.rejects(
    blockedClient.sendNextApproval(OWNER, "buy", 10n, {
      onSubmissionInvoked: (submission) => {
        assert.equal(submission.target.toLowerCase(), PIPEDOG.toLowerCase());
        assert.equal(submission.calldata, approvalData(10n));
        throw new Error("storage unavailable");
      },
    }),
    /storage unavailable/i,
  );
  assert.equal(
    blockedProvider.calls.some(({ method }) => method === "eth_sendTransaction"),
    false,
  );

  const submittedProvider = mockProvider({ initialAllowance: 0n });
  const submittedClient = new trade.LaypipeTradeClient(
    submittedProvider,
    manifest(),
    identity(),
    { verifyDeployment: verifiedSnapshot },
  );
  await assert.rejects(
    submittedClient.sendNextApproval(OWNER, "buy", 10n, {
      onSubmissionInvoked: () => undefined,
      onSubmitted: (hash) => {
        assert.equal(hash, TX_HASH);
        throw new Error("hash persistence failed");
      },
    }),
    (error) =>
      trade.isTradeSubmissionIndeterminate(error) &&
      /recovery intent could not be saved/i.test(error.message),
  );
  assert.equal(
    submittedProvider.calls.some(({ method }) => method === "eth_sendTransaction"),
    true,
  );
});

test("approval confirmation binds zero-value calldata and rereads the resulting allowance", async () => {
  const provider = mockProvider({ initialAllowance: 7n });
  const confirmation = confirmationProvider({
    to: PIPEDOG,
    input: approvalData(0n),
    allowance: 0n,
  });
  const client = new trade.LaypipeTradeClient(provider, manifest(), identity(), {
    verifyDeployment: verifiedSnapshot,
    confirmationProvider: confirmation,
  });
  const pending = await client.clearAllowance(OWNER, "buy");
  assert.ok(pending);
  const confirmed = await client.confirmApproval(pending, OWNER);
  assert.equal(confirmed.allowance, 0n);
  assert.equal(confirmed.allowanceMatchesIntent, true);
  assert.ok(confirmation.calls.includes("eth_getTransactionByHash"));
  assert.ok(confirmation.calls.includes("eth_call"));

  const staleConfirmation = confirmationProvider({
    to: PIPEDOG,
    input: approvalData(0n),
    allowance: 1n,
  });
  const staleClient = new trade.LaypipeTradeClient(provider, manifest(), identity(), {
    verifyDeployment: verifiedSnapshot,
    confirmationProvider: staleConfirmation,
  });
  const stale = await staleClient.confirmApproval(pending, OWNER);
  assert.equal(stale.allowanceMatchesIntent, false);
});

test("trade confirmation binds canonical transaction and accepts bounded partial fills", async () => {
  const provider = mockProvider();
  const quotingClient = new trade.LaypipeTradeClient(provider, manifest(), identity(), {
    verifyDeployment: verifiedSnapshot,
    now: () => 1_000,
  });
  const quote = await quotingClient.prepareQuote({
    owner: OWNER,
    side: "buy",
    inputAmount: 10n,
    slippageBps: 100,
  });
  const expectedData = trade.encodeLaypipeTradeCall({
    side: quote.side,
    pool: trade.resolveVerifiedTradePool(manifest(), identity()),
    inputAmount: quote.inputAmount,
    minimumOutput: quote.minimumOutput,
    recipient: quote.owner,
    deadlineBlock: quote.deadlineBlock,
  });
  const confirmation = confirmationProvider({
    input: expectedData,
    logs: [tradeLog(quote, { inputSpent: 6n, outputReceived: 26n })],
    allowance: 0n,
  });
  const client = new trade.LaypipeTradeClient(provider, manifest(), identity(), {
    verifyDeployment: verifiedSnapshot,
    confirmationProvider: confirmation,
  });
  const confirmed = await client.confirmTrade(
    { hash: TX_HASH, simulatedOutput: 25n },
    quote,
  );
  assert.equal(confirmed.inputSpent, 6n);
  assert.equal(confirmed.outputReceived, 26n);
  assert.equal(confirmed.allowanceCleared, true);
});

test("trade confirmation rejects reversion, calldata/value mismatch, noncanonical blocks, and bad logs", async () => {
  const provider = mockProvider();
  const quotingClient = new trade.LaypipeTradeClient(provider, manifest(), identity(), {
    verifyDeployment: verifiedSnapshot,
    now: () => 1_000,
  });
  const quote = await quotingClient.prepareQuote({
    owner: OWNER,
    side: "buy",
    inputAmount: 10n,
    slippageBps: 100,
  });
  const expectedData = trade.encodeLaypipeTradeCall({
    side: quote.side,
    pool: trade.resolveVerifiedTradePool(manifest(), identity()),
    inputAmount: quote.inputAmount,
    minimumOutput: quote.minimumOutput,
    recipient: quote.owner,
    deadlineBlock: quote.deadlineBlock,
  });
  const pending = { hash: TX_HASH, simulatedOutput: 25n };
  const failures = [
    {
      options: { input: expectedData, status: "0x0", logs: [tradeLog(quote)] },
      expected: /reverted on-chain/i,
    },
    {
      options: { input: "0x1234", logs: [tradeLog(quote)] },
      expected: /input, value, sender, target, or block/i,
    },
    {
      options: { input: expectedData, value: "0x1", logs: [tradeLog(quote)] },
      expected: /input, value, sender, target, or block/i,
    },
    {
      options: {
        input: expectedData,
        blockHash: `0x${"ef".repeat(32)}`,
        receiptBlockHash: BLOCK_HASH,
        logs: [tradeLog(quote)],
      },
      expected: /canonical block/i,
    },
    {
      options: { input: expectedData, logs: [] },
      expected: /exactly one expected router trade event/i,
    },
    {
      options: {
        input: expectedData,
        logs: [tradeLog(quote, { outputReceived: quote.minimumOutput - 1n })],
      },
      expected: /amounts do not match/i,
    },
  ];
  for (const failure of failures) {
    const client = new trade.LaypipeTradeClient(provider, manifest(), identity(), {
      verifyDeployment: verifiedSnapshot,
      confirmationProvider: confirmationProvider(failure.options),
    });
    await assert.rejects(client.confirmTrade(pending, quote), failure.expected);
  }

  const revertedClient = new trade.LaypipeTradeClient(
    provider,
    manifest(),
    identity(),
    {
      verifyDeployment: verifiedSnapshot,
      confirmationProvider: confirmationProvider({
        input: expectedData,
        status: "0x0",
        logs: [tradeLog(quote)],
      }),
    },
  );
  await assert.rejects(
    revertedClient.confirmTrade(pending, quote),
    (error) => trade.isCanonicalTradeReverted(error),
  );
});

test("receipt timeout stays pending-unknown rather than proving failure", async () => {
  const client = new trade.LaypipeTradeClient(
    mockProvider(),
    manifest(),
    identity(),
    {
      verifyDeployment: verifiedSnapshot,
      confirmationProvider: confirmationProvider({ receipt: false }),
    },
  );
  await assert.rejects(
    client.waitForReceipt(TX_HASH, {
      expectedFrom: OWNER,
      expectedTo: ROUTER,
      expectedData: "0x1234",
      timeoutMs: 5,
      pollIntervalMs: 1,
    }),
    /still pending/i,
  );
});

test("receipt timeout and cancellation bound a confirmation provider that never settles", async () => {
  const never = {
    request({ method }) {
      if (method === "eth_chainId") return Promise.resolve("0x1237");
      return new Promise(() => {});
    },
  };
  const client = new trade.LaypipeTradeClient(
    mockProvider(),
    manifest(),
    identity(),
    { verifyDeployment: verifiedSnapshot, confirmationProvider: never },
  );
  const started = Date.now();
  await assert.rejects(
    client.waitForReceipt(TX_HASH, {
      expectedFrom: OWNER,
      expectedTo: ROUTER,
      expectedData: "0x1234",
      timeoutMs: 8,
      pollIntervalMs: 1,
    }),
    /timed out|pending/i,
  );
  assert.ok(Date.now() - started < 250);

  const controller = new AbortController();
  const cancelled = client.waitForReceipt(TX_HASH, {
    expectedFrom: OWNER,
    expectedTo: ROUTER,
    expectedData: "0x1234",
    timeoutMs: 5_000,
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 1);
  await assert.rejects(cancelled, /cancelled/i);
});

test("public confirmation RPC attaches a per-request abort signal", async () => {
  let signal;
  const provider = trade.createRobinhoodTradeConfirmationProvider(
    async (_url, init) => {
      signal = init.signal;
      return Response.json({ jsonrpc: "2.0", id: 1, result: "0x1237" });
    },
  );
  assert.equal(await provider.request({ method: "eth_chainId" }), "0x1237");
  assert.ok(signal instanceof AbortSignal);
});

test("token detail preserves fixture fail-closed gating and shared TokenAvatar", () => {
  const page = readFileSync(resolve(root, "app/token/[slug]/page.tsx"), "utf8");
  const panel = readFileSync(resolve(root, "app/token/[slug]/TradePanel.tsx"), "utf8");
  const clientSource = readFileSync(resolve(root, "lib/web3/trade-client.ts"), "utf8");
  assert.match(page, /<TokenAvatar token=\{token\}/);
  assert.match(page, /enabled=\{marketMode === "live"\}/);
  assert.match(panel, /data-trading-state="fixture-disabled"/);
  assert.match(panel, /Fixture data never activates approval, trade, or router mutations/);
  assert.match(panel, /isTradeSubmissionIndeterminate/);
  assert.match(panel, /retrying is blocked/);
  assert.match(panel, /I checked wallet activity; clear lock/);
  assert.match(panel, /Recheck canonical receipt/);
  assert.match(panel, /readPendingTradeForWallet\(window\.localStorage, account\)/);
  assert.match(panel, /if \(restored\.hash && !differentPool\) reconcileRestoredTrade\(restored\)/);
  assert.match(panel, /pendingForDifferentPool/);
  assert.match(panel, /Open pending coin/);
  assert.match(panel, /pendingStoreBinding\?\.wallet === account\.toLowerCase\(\)/);
  assert.match(panel, /pendingStoreBinding\.revision === wallet\.revision/);
  assert.match(panel, /setPendingStoreBinding\(\{\s*wallet: account\.toLowerCase\(\),\s*revision: wallet\.revision/);
  assert.match(panel, /\[account, liveConfigured, token, wallet\.revision\]/);
  assert.match(panel, /crossTabLockSupported !== true/);
  assert.match(panel, /withWalletMutationLock\(navigator\.locks, account/);
  assert.equal(
    panel.match(/withWalletSubmissionLock\(\(\) =>/g)?.length,
    3,
    "approval, allowance clear, and trade sends must all hold the wallet lock",
  );
  assert.match(panel, /isCanonicalTradeReverted/);
  assert.match(panel, /if \(!restoredIntent \|\| restoredIntent\.hash \|\| !pendingStoreReady \|\| !account\) return/);
  assert.match(panel, /inFlightRef\.current/);
  assert.match(panel, /result\?\.allowanceCleared === false/);
  assert.match(panel, /disabled=\{controlsLocked\}/);
  assert.match(panel, /Submit window/);
  assert.match(panel, /Router block cap/);
  assert.match(panel, /quote\.deadlineBlock\.toString\(\)/);
  assert.doesNotMatch(panel, /MAX_UINT|unlimited approval/i);

  assert.match(panel, /onSubmissionInvoked:[\s\S]*persistSubmission\(nextIntent\)/);
  const clearAllowanceFlow = clientSource.slice(
    clientSource.indexOf("async clearAllowance"),
    clientSource.indexOf("async prepareQuote"),
  );
  assert.ok(
    clearAllowanceFlow.indexOf("callbacks.onSubmissionInvoked?.(submission)") <
      clearAllowanceFlow.indexOf("const hash = await this.send(transaction)"),
    "the exact recovery callback must run before invoking wallet submission",
  );
});
