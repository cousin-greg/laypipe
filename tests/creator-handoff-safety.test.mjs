import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const viem = require("viem");
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

const handoff = loadTypeScript("lib/web3/creator-handoff-client.ts");
const pending = loadTypeScript("lib/wallet/pending-creator-updates.ts");
const mutations = loadTypeScript("lib/wallet/pending-wallet-mutations.ts");
const mutationLocks = loadTypeScript("lib/wallet/mutation-lock.ts");
const address = (byte) => `0x${byte.repeat(40)}`;
const hash = (byte) => `0x${byte.repeat(64)}`;
const creator = address("a");
const newCreator = viem.getAddress(address("b"));
const otherCreator = viem.getAddress(address("c"));
const hookAddress = address("f");
const poolId = hash("d");
const txHash = hash("9");
const blockHash = hash("8");
const handoffAbi = viem.parseAbi([
  "function poolConfigs(bytes32 poolId) view returns (address creator, uint40 launchTime, uint16 creatorFeeBps, uint24 baseFeeRate, uint24 launchFeeRate, uint32 launchFeeDecay, bool exists)",
  "function updateCreator(bytes32 poolId, address newCreator)",
  "event CreatorUpdated(bytes32 indexed poolId, address indexed oldCreator, address indexed newCreator)",
]);

function manifest() {
  return { contracts: { hook: { address: hookAddress } } };
}

const verify = async () => ({ blockNumber: 124n, blockTag: "0x7c" });

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

function exclusiveLocks() {
  const held = new Set();
  return {
    async request(name, options, callback) {
      assert.deepEqual(options, { mode: "exclusive", ifAvailable: true });
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

function poolConfig(currentCreator = creator) {
  return viem.encodeFunctionResult({
    abi: handoffAbi,
    functionName: "poolConfigs",
    result: [currentCreator, 1, 7000, 10000, 10000, 0, true],
  });
}

function submissionProvider(options = {}) {
  const calls = [];
  let currentCreator = options.currentCreator ?? creator;
  let configReads = 0;
  const provider = {
    calls,
    async request(args) {
      calls.push(args);
      if (args.method === "eth_accounts") return [creator];
      if (args.method === "eth_chainId") return "0x1237";
      if (args.method === "eth_call") {
        const data = args.params[0].data;
        if (data.startsWith(viem.toFunctionSelector("poolConfigs(bytes32)"))) {
          configReads += 1;
          if (options.creatorAfterFirstRead && configReads > 1) {
            currentCreator = options.creatorAfterFirstRead;
          }
          return poolConfig(currentCreator);
        }
        return "0x";
      }
      if (args.method === "eth_estimateGas") return "0x5208";
      if (args.method === "eth_sendTransaction") {
        options.onSend?.();
        if (options.sendNever) return new Promise(() => {});
        if (options.sendError) throw options.sendError;
        return options.sendResult ?? txHash;
      }
      throw new Error(`Unexpected ${args.method}`);
    },
  };
  return provider;
}

function creatorUpdatedLog(overrides = {}) {
  return {
    address: hookAddress,
    topics: viem.encodeEventTopics({
      abi: handoffAbi,
      eventName: "CreatorUpdated",
      args: {
        poolId: overrides.poolId ?? poolId,
        oldCreator: overrides.oldCreator ?? creator,
        newCreator: overrides.newCreator ?? newCreator,
      },
    }),
    data: "0x",
  };
}

function confirmationProvider(overrides = {}) {
  const calldata = viem.encodeFunctionData({
    abi: handoffAbi,
    functionName: "updateCreator",
    args: [poolId, newCreator],
  });
  const receipt = {
    transactionHash: txHash,
    blockHash,
    blockNumber: "0x64",
    status: overrides.status ?? "0x1",
    from: creator,
    to: hookAddress,
    logs: overrides.logs ?? [creatorUpdatedLog()],
  };
  const transaction = {
    hash: txHash,
    from: creator,
    to: hookAddress,
    input: overrides.input ?? calldata,
    value: overrides.value ?? "0x0",
    blockHash,
    blockNumber: "0x64",
  };
  return {
    async request(args) {
      if (args.method === "eth_chainId") return "0x1237";
      if (args.method === "eth_getTransactionReceipt") return receipt;
      if (args.method === "eth_getTransactionByHash") return transaction;
      if (args.method === "eth_getBlockByNumber") {
        return {
          hash: overrides.canonicalBlockHash ?? blockHash,
          number: "0x64",
          transactions: overrides.transactions ?? [txHash],
        };
      }
      if (args.method === "eth_blockNumber") return overrides.head ?? "0x65";
      throw new Error(`Unexpected ${args.method}`);
    },
  };
}

test("creator destination requires the exact checksum and rejects zero or same creator", () => {
  assert.equal(handoff.parseChecksummedCreatorAddress(newCreator, creator), newCreator);
  assert.throws(
    () => handoff.parseChecksummedCreatorAddress(newCreator.toLowerCase(), creator),
    /checksummed address exactly/i,
  );
  assert.throws(
    () => handoff.parseChecksummedCreatorAddress(` ${newCreator}`, creator),
    /no surrounding spaces/i,
  );
  assert.throws(
    () => handoff.parseChecksummedCreatorAddress(address("0"), creator),
    /zero address/i,
  );
  assert.throws(
    () => handoff.parseChecksummedCreatorAddress(viem.getAddress(creator), creator),
    /must differ/i,
  );
});

test("durable creator handoff intent survives reload and exact removal is fail closed", () => {
  const storage = memoryStorage();
  const intent = {
    chainId: 4663,
    wallet: creator,
    hook: hookAddress,
    poolId,
    oldCreator: creator,
    newCreator,
    hash: null,
    invokedAt: Date.now(),
  };
  pending.savePendingCreatorUpdate(storage, intent);
  assert.deepEqual(
    pending.readPendingCreatorUpdateStateForWallet(storage, creator),
    { status: "pending", intent },
  );
  assert.throws(
    () => mutations.assertNoPendingWalletMutation(storage, creator),
    /unresolved LayPipe action/i,
  );
  pending.savePendingCreatorUpdateHash(storage, creator, poolId, txHash, intent.invokedAt);
  const saved = { ...intent, hash: txHash };
  assert.throws(
    () => pending.removeExactPendingCreatorUpdate(storage, { ...saved, newCreator: otherCreator }),
    /does not match the saved exact intent/i,
  );
  assert.equal(pending.readPendingCreatorUpdateStateForWallet(storage, creator).status, "pending");
  pending.removeExactPendingCreatorUpdate(storage, saved);
  assert.deepEqual(pending.readPendingCreatorUpdateStateForWallet(storage, creator), { status: "clear" });
});

test("manual creator-handoff recovery only removes the exact hashless intent", () => {
  const storage = memoryStorage();
  const intent = {
    chainId: 4663,
    wallet: creator,
    hook: hookAddress,
    poolId,
    oldCreator: creator,
    newCreator,
    hash: null,
    invokedAt: Date.now(),
  };
  pending.savePendingCreatorUpdate(storage, intent);
  assert.throws(
    () => pending.removeExactUnsubmittedPendingCreatorUpdate(
      storage,
      { ...intent, newCreator: otherCreator },
    ),
    /does not match the saved exact intent/i,
  );
  assert.equal(
    pending.readPendingCreatorUpdateStateForWallet(storage, creator).status,
    "pending",
  );
  pending.savePendingCreatorUpdateHash(
    storage,
    creator,
    poolId,
    txHash,
    intent.invokedAt,
  );
  assert.throws(
    () => pending.removeExactUnsubmittedPendingCreatorUpdate(
      storage,
      { ...intent, hash: txHash },
    ),
    /only be cleared by canonical reconciliation/i,
  );
});

test("active creator submission blocks same-wallet clear and cross-wallet reset", async () => {
  const storage = memoryStorage();
  const locks = exclusiveLocks();
  const intent = {
    chainId: 4663,
    wallet: creator,
    hook: hookAddress,
    poolId,
    oldCreator: creator,
    newCreator,
    hash: null,
    invokedAt: Date.now(),
  };
  let release;
  let signalEntered;
  const entered = new Promise((resolve) => { signalEntered = resolve; });
  const active = mutationLocks.withCreatorHandoffMutationLocks(
    locks,
    creator,
    async () => {
      pending.savePendingCreatorUpdate(storage, intent);
      signalEntered();
      await new Promise((resolve) => { release = resolve; });
    },
  );
  await entered;

  await assert.rejects(
    mutationLocks.withCreatorHandoffMutationLocks(
      locks,
      creator,
      () => pending.removeExactUnsubmittedPendingCreatorUpdate(storage, intent),
    ),
    /another creator handoff or recovery action is active/i,
  );
  await assert.rejects(
    mutationLocks.withCreatorHandoffMutationLocks(
      locks,
      otherCreator,
      () => pending.resetPendingCreatorUpdateStore(storage),
    ),
    /another creator handoff or recovery action is active/i,
  );
  assert.equal(
    pending.readPendingCreatorUpdateStateForWallet(storage, creator).status,
    "pending",
  );
  release();
  await active;
});

test("global creator store lock prevents two-wallet lost updates", async () => {
  const storage = memoryStorage();
  const locks = exclusiveLocks();
  const otherPoolId = hash("e");
  const firstIntent = {
    chainId: 4663,
    wallet: creator,
    hook: hookAddress,
    poolId,
    oldCreator: creator,
    newCreator,
    hash: null,
    invokedAt: Date.now(),
  };
  const secondIntent = {
    ...firstIntent,
    wallet: otherCreator,
    poolId: otherPoolId,
    oldCreator: otherCreator,
    newCreator: viem.getAddress(address("d")),
    invokedAt: Date.now() + 1,
  };
  let release;
  let signalEntered;
  const entered = new Promise((resolve) => { signalEntered = resolve; });
  const first = mutationLocks.withCreatorHandoffMutationLocks(
    locks,
    creator,
    async () => {
      pending.savePendingCreatorUpdate(storage, firstIntent);
      signalEntered();
      await new Promise((resolve) => { release = resolve; });
    },
  );
  await entered;
  await assert.rejects(
    mutationLocks.withCreatorHandoffMutationLocks(
      locks,
      otherCreator,
      () => pending.savePendingCreatorUpdate(storage, secondIntent),
    ),
    /another creator handoff or recovery action is active/i,
  );
  release();
  await first;
  await mutationLocks.withCreatorHandoffMutationLocks(
    locks,
    otherCreator,
    () => pending.savePendingCreatorUpdate(storage, secondIntent),
  );
  assert.equal(
    pending.readPendingCreatorUpdateStateForWallet(storage, creator).status,
    "pending",
  );
  assert.equal(
    pending.readPendingCreatorUpdateStateForWallet(storage, otherCreator).status,
    "pending",
  );
});

test("corrupt creator-handoff storage blocks every wallet mutation", () => {
  const storage = memoryStorage();
  storage.setItem(pending.PENDING_CREATOR_UPDATES_STORAGE_KEY, "not-json");
  assert.deepEqual(
    pending.readPendingCreatorUpdateStateForWallet(storage, creator),
    { status: "recovery-required", reason: "malformed" },
  );
  assert.throws(
    () => mutations.assertNoPendingWalletMutation(storage, creator),
    /cannot be trusted/i,
  );
});

test("creator-handoff storage rejects expiry, duplicates, extra fields, bad checksum, and failed writes", () => {
  const now = Date.now();
  const valid = (overrides = {}) => ({
    chainId: 4663,
    wallet: creator,
    hook: hookAddress,
    poolId,
    oldCreator: creator,
    newCreator,
    hash: null,
    invokedAt: now,
    ...overrides,
  });

  for (const [value, reason] of [
    [[valid({ invokedAt: now - 31 * 24 * 60 * 60 * 1_000 })], "expired"],
    [[valid(), valid()], "corrupt"],
    [[{ ...valid(), extra: true }], "corrupt"],
    [[valid({ newCreator: newCreator.toLowerCase() })], "corrupt"],
    [Array.from({ length: 21 }, (_, index) => valid({ wallet: address(((index % 9) + 1).toString()) })), "over-cap"],
  ]) {
    const storage = memoryStorage();
    storage.setItem(pending.PENDING_CREATOR_UPDATES_STORAGE_KEY, JSON.stringify(value));
    assert.deepEqual(
      pending.readPendingCreatorUpdateStateForWallet(storage, creator, now),
      { status: "recovery-required", reason },
    );
  }

  const unreadable = {
    getItem() { throw new Error("blocked"); },
    setItem() { throw new Error("blocked"); },
    removeItem() { throw new Error("blocked"); },
  };
  assert.deepEqual(
    pending.readPendingCreatorUpdateStateForWallet(unreadable, creator, now),
    { status: "recovery-required", reason: "unreadable" },
  );
  assert.throws(
    () => pending.savePendingCreatorUpdate(unreadable, valid(), now),
    /could not be read|could not be written/i,
  );
});

test("creator handoff rechecks audited manifest, indexed state, chain and account immediately before send", async () => {
  const storage = memoryStorage();
  const invokedAt = Date.now();
  const provider = submissionProvider({
    onSend: () => {
      const saved = pending.readPendingCreatorUpdateStateForWallet(storage, creator);
      assert.equal(saved.status, "pending");
      assert.equal(saved.intent.hash, null);
      assert.equal(saved.intent.newCreator, newCreator);
    },
  });
  let verifyCount = 0;
  const client = new handoff.CreatorHandoffClient(
    provider,
    manifest(),
    async () => { verifyCount += 1; return verify(); },
    { confirmationProvider: confirmationProvider() },
  );
  const callbacks = [];
  const submitted = await client.updateCreator(creator, poolId, creator, newCreator, {
    onSubmissionInvoked: () => {
      pending.savePendingCreatorUpdate(storage, {
        chainId: 4663,
        wallet: creator,
        hook: hookAddress,
        poolId,
        oldCreator: creator,
        newCreator,
        hash: null,
        invokedAt,
      });
      callbacks.push("invoked");
    },
    onSubmitted: (submittedHash) => callbacks.push(submittedHash),
  });
  assert.equal(submitted.hash, txHash);
  assert.equal(verifyCount, 2);
  assert.deepEqual(callbacks, ["invoked", txHash]);
  const methods = provider.calls.map((call) => call.method);
  assert.deepEqual(
    methods.slice(-3),
    ["eth_accounts", "eth_chainId", "eth_sendTransaction"],
  );
  const sendIndex = methods.lastIndexOf("eth_sendTransaction");
  const lastCreatorRead = methods.lastIndexOf("eth_call", sendIndex - 1);
  assert.ok(lastCreatorRead > -1 && lastCreatorRead < sendIndex);
  assert.equal(methods.slice(lastCreatorRead + 1, sendIndex).includes("eth_sendTransaction"), false);
  const sent = provider.calls.at(-1).params[0];
  assert.equal(sent.from, creator);
  assert.equal(sent.to, hookAddress);
  assert.equal(sent.value, "0x0");
  assert.equal(
    sent.data,
    viem.encodeFunctionData({ abi: handoffAbi, functionName: "updateCreator", args: [poolId, newCreator] }),
  );
  assert.ok(methods.indexOf("eth_call") > -1);
  assert.ok(methods.indexOf("eth_estimateGas") > -1);
});

test("stale indexed creator, hook disagreement, and state drift block submission", async () => {
  const staleClient = new handoff.CreatorHandoffClient(
    submissionProvider(), manifest(), verify, { confirmationProvider: confirmationProvider() },
  );
  await assert.rejects(
    staleClient.updateCreator(creator, poolId, otherCreator, newCreator),
    /not the freshly indexed current creator/i,
  );

  const disagreementClient = new handoff.CreatorHandoffClient(
    submissionProvider({ currentCreator: otherCreator }), manifest(), verify,
    { confirmationProvider: confirmationProvider() },
  );
  await assert.rejects(
    disagreementClient.updateCreator(creator, poolId, creator, newCreator),
    /index and audited hook disagree/i,
  );

  const driftProvider = submissionProvider({ creatorAfterFirstRead: otherCreator });
  const driftClient = new handoff.CreatorHandoffClient(
    driftProvider, manifest(), verify, { confirmationProvider: confirmationProvider() },
  );
  await assert.rejects(
    driftClient.updateCreator(creator, poolId, creator, newCreator),
    /index and audited hook disagree/i,
  );
  assert.equal(driftProvider.calls.some((call) => call.method === "eth_sendTransaction"), false);
});

test("only explicit wallet rejection is retry-safe after the durable intent boundary", async () => {
  const timeoutClient = new handoff.CreatorHandoffClient(
    submissionProvider({ sendError: Object.assign(new Error("timeout"), { code: -32000 }) }),
    manifest(), verify, { confirmationProvider: confirmationProvider() },
  );
  await assert.rejects(
    timeoutClient.updateCreator(creator, poolId, creator, newCreator),
    (error) => handoff.isCreatorHandoffSubmissionIndeterminate(error),
  );

  const rejectedClient = new handoff.CreatorHandoffClient(
    submissionProvider({ sendError: Object.assign(new Error("rejected"), { code: 4001 }) }),
    manifest(), verify, { confirmationProvider: confirmationProvider() },
  );
  await assert.rejects(
    rejectedClient.updateCreator(creator, poolId, creator, newCreator),
    (error) => !handoff.isCreatorHandoffSubmissionIndeterminate(error) && error.code === 4001,
  );
});

test("wallet RPC hangs are bounded and a send timeout remains indeterminate", async () => {
  let submissionInvoked = false;
  const sendClient = new handoff.CreatorHandoffClient(
    submissionProvider({ sendNever: true }),
    manifest(),
    verify,
    {
      confirmationProvider: confirmationProvider(),
      walletRequestTimeoutMs: 5,
    },
  );
  await assert.rejects(
    sendClient.updateCreator(creator, poolId, creator, newCreator, {
      onSubmissionInvoked: () => { submissionInvoked = true; },
    }),
    (error) =>
      handoff.isCreatorHandoffSubmissionIndeterminate(error) &&
      /may have broadcast/i.test(error.message),
  );
  assert.equal(submissionInvoked, true);

  const readProvider = submissionProvider();
  const originalRequest = readProvider.request.bind(readProvider);
  readProvider.request = (args) =>
    args.method === "eth_call"
      ? new Promise(() => {})
      : originalRequest(args);
  const readClient = new handoff.CreatorHandoffClient(
    readProvider,
    manifest(),
    verify,
    {
      confirmationProvider: confirmationProvider(),
      walletRequestTimeoutMs: 5,
    },
  );
  submissionInvoked = false;
  await assert.rejects(
    readClient.updateCreator(creator, poolId, creator, newCreator, {
      onSubmissionInvoked: () => { submissionInvoked = true; },
    }),
    (error) =>
      !handoff.isCreatorHandoffSubmissionIndeterminate(error) &&
      /wallet RPC eth_call timed out/i.test(error.message),
  );
  assert.equal(submissionInvoked, false);
});

test("confirmation binds depth-two canonical transaction and exactly one CreatorUpdated event", async () => {
  const validClient = new handoff.CreatorHandoffClient(
    submissionProvider(), manifest(), verify, { confirmationProvider: confirmationProvider() },
  );
  const confirmed = await validClient.confirmCreatorHandoff(
    txHash,
    { account: creator, poolId, oldCreator: creator, newCreator },
    { pollIntervalMs: 1 },
  );
  assert.equal(confirmed.newCreator, newCreator);

  for (const [overrides, pattern] of [
    [{ value: "0x1" }, /calldata, value, sender, target, or block/i],
    [{ input: "0x1234" }, /calldata, value, sender, target, or block/i],
    [{ logs: [creatorUpdatedLog({ newCreator: otherCreator })] }, /exactly the saved CreatorUpdated/i],
    [{ logs: [creatorUpdatedLog(), creatorUpdatedLog()] }, /exactly the saved CreatorUpdated/i],
    [{ canonicalBlockHash: hash("7") }, /not the canonical block/i],
  ]) {
    const client = new handoff.CreatorHandoffClient(
      submissionProvider(), manifest(), verify,
      { confirmationProvider: confirmationProvider(overrides) },
    );
    await assert.rejects(
      client.confirmCreatorHandoff(
        txHash,
        { account: creator, poolId, oldCreator: creator, newCreator },
        { pollIntervalMs: 1 },
      ),
      pattern,
    );
  }
});

test("only an exact canonical depth-two status-zero receipt is a typed proven revert", async () => {
  const canonicalClient = new handoff.CreatorHandoffClient(
    submissionProvider(), manifest(), verify,
    { confirmationProvider: confirmationProvider({ status: "0x0", logs: [] }) },
  );
  await assert.rejects(
    canonicalClient.confirmCreatorHandoff(
      txHash,
      { account: creator, poolId, oldCreator: creator, newCreator },
      { timeoutMs: 20, pollIntervalMs: 1 },
    ),
    (error) =>
      handoff.isCanonicalCreatorHandoffReverted(error) &&
      error instanceof handoff.CanonicalCreatorHandoffRevertedError,
  );

  const shallowClient = new handoff.CreatorHandoffClient(
    submissionProvider(), manifest(), verify,
    { confirmationProvider: confirmationProvider({ status: "0x0", logs: [], head: "0x64" }) },
  );
  await assert.rejects(
    shallowClient.confirmCreatorHandoff(
      txHash,
      { account: creator, poolId, oldCreator: creator, newCreator },
      { timeoutMs: 5, pollIntervalMs: 1 },
    ),
    (error) => !handoff.isCanonicalCreatorHandoffReverted(error) && /still pending/i.test(error.message),
  );
});

test("confirmation timeout and cancellation bound a provider that never settles", async () => {
  const never = { request: () => new Promise(() => {}) };
  const timeoutClient = new handoff.CreatorHandoffClient(
    submissionProvider(), manifest(), verify, { confirmationProvider: never },
  );
  await assert.rejects(
    timeoutClient.confirmCreatorHandoff(
      txHash,
      { account: creator, poolId, oldCreator: creator, newCreator },
      { timeoutMs: 10, pollIntervalMs: 1 },
    ),
    /pending-unknown|still pending/i,
  );

  const controller = new AbortController();
  const cancellationClient = new handoff.CreatorHandoffClient(
    submissionProvider(), manifest(), verify, { confirmationProvider: never },
  );
  const confirmation = cancellationClient.confirmCreatorHandoff(
    txHash,
    { account: creator, poolId, oldCreator: creator, newCreator },
    { timeoutMs: 1_000, pollIntervalMs: 1, signal: controller.signal },
  );
  controller.abort();
  await assert.rejects(confirmation, /cancelled/i);
});

test("My Tokens exposes guarded creator handoff and never introduces a server signing key", () => {
  const component = readFileSync(resolve(root, "app/_components/WalletPortfolio.tsx"), "utf8");
  const hook = readFileSync(resolve(root, "app/_components/useCreatorHandoff.ts"), "utf8");
  assert.match(component, /Original creator/);
  assert.match(component, /Current creator/);
  assert.match(component, /Hand off creator/);
  assert.match(component, /exact checksum required/);
  assert.match(component, /I verified that I control this exact destination/);
  assert.match(component, /Verify & hand off permanently/);
  assert.match(hook, /withCreatorHandoffMutationLocks/);
  assert.match(hook, /assertNoPendingWalletMutation/);
  assert.match(hook, /onSubmissionInvoked:[\s\S]*savePendingCreatorUpdate/);
  assert.match(hook, /readBrowserPublicLaunchDeployment/);
  assert.match(hook, /isCanonicalCreatorHandoffReverted/);
  assert.match(hook, /removeExactPendingCreatorUpdate/);
  assert.match(hook, /removeExactUnsubmittedPendingCreatorUpdate/);
  assert.doesNotMatch(hook, /removePendingCreatorUpdate/);
  assert.match(component, /\{!creatorHandoff\.pending\.hash && \(/);
  assert.match(component, /disabled=\{creatorHandoff\.liveOperation \|\| creatorHandoff\.recoveryBusy\}/);
  assert.doesNotMatch(`${component}\n${hook}`, /PRIVATE_KEY|MNEMONIC|eth_sendRawTransaction/);
});
