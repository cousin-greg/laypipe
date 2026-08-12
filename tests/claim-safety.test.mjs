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

const claim = loadTypeScript("lib/web3/creator-claim-client.ts");
const pendingClaims = loadTypeScript("lib/wallet/pending-claims.ts");
const walletAddress = (byte) => `0x${byte.repeat(40)}`;
const transactionHash = (byte) => `0x${byte.repeat(64)}`;
const wallet = walletAddress("a");
const hook = walletAddress("f");
const poolId = transactionHash("d");
const txHash = transactionHash("9");
const blockHash = transactionHash("b");
const claimAbi = viem.parseAbi([
  "function pending(bytes32 poolId) view returns (uint256)",
  "function tab(bytes32 poolId) view returns (uint256)",
  "function poolConfigs(bytes32 poolId) view returns (address creator, uint40 launchTime, uint16 creatorFeeBps, uint24 baseFeeRate, uint24 launchFeeRate, uint32 launchFeeDecay, bool exists)",
  "function claim(bytes32 poolId) returns (uint256 amount)",
  "event CreatorFeesClaimed(bytes32 indexed poolId, address indexed creator, uint256 amount)",
]);

function manifest() {
  return { contracts: { hook: { address: hook } } };
}

function stateCall(data) {
  if (data.startsWith(viem.toFunctionSelector("poolConfigs(bytes32)"))) {
    return viem.encodeFunctionResult({
      abi: claimAbi,
      functionName: "poolConfigs",
      result: [wallet, 1, 2500, 1000, 1000, 0, true],
    });
  }
  if (data.startsWith(viem.toFunctionSelector("pending(bytes32)"))) {
    return viem.encodeFunctionResult({
      abi: claimAbi,
      functionName: "pending",
      result: 400n,
    });
  }
  return viem.encodeFunctionResult({
    abi: claimAbi,
    functionName: "tab",
    result: 100n,
  });
}

function submissionProvider(send) {
  return {
    async request(args) {
      if (args.method === "eth_accounts") return [wallet];
      if (args.method === "eth_chainId") return "0x1237";
      if (args.method === "eth_estimateGas") return "0x5208";
      if (args.method === "eth_sendTransaction") return send();
      if (args.method === "eth_call") return stateCall(args.params[0].data);
      throw new Error(`Unexpected ${args.method}`);
    },
  };
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

test("pending claim intent survives reload and stays wallet-bound until cleared", () => {
  const storage = memoryStorage();
  const intent = {
    chainId: 4663,
    wallet,
    poolId,
    hash: null,
    invokedAt: Date.now(),
  };
  pendingClaims.savePendingClaim(storage, intent);
  assert.deepEqual(
    pendingClaims.readPendingClaimStateForWallet(storage, wallet),
    { status: "pending", intent },
  );
  assert.deepEqual(
    pendingClaims.readPendingClaimStateForWallet(storage, walletAddress("b")),
    { status: "clear" },
  );
  pendingClaims.savePendingClaimHash(storage, wallet, poolId, txHash);
  const hashedIntent = { ...intent, hash: txHash };
  assert.deepEqual(
    pendingClaims.readPendingClaimStateForWallet(storage, wallet).intent,
    hashedIntent,
  );
  assert.throws(
    () =>
      pendingClaims.removeExactPendingClaim(storage, {
        ...hashedIntent,
        invokedAt: hashedIntent.invokedAt + 1,
      }),
    /does not match the saved exact intent/i,
  );
  assert.throws(
    () => pendingClaims.removeExactPendingClaim(storage, intent),
    /must include its exact transaction hash/i,
  );
  assert.deepEqual(
    pendingClaims.readPendingClaimStateForWallet(storage, wallet).intent,
    hashedIntent,
  );
  const otherIntent = {
    chainId: 4663,
    wallet: walletAddress("b"),
    poolId: transactionHash("e"),
    hash: transactionHash("8"),
    invokedAt: intent.invokedAt,
  };
  pendingClaims.savePendingClaim(storage, otherIntent);
  pendingClaims.removeExactPendingClaim(storage, hashedIntent);
  assert.deepEqual(
    pendingClaims.readPendingClaimStateForWallet(storage, wallet),
    { status: "clear" },
  );
  assert.deepEqual(
    pendingClaims.readPendingClaimStateForWallet(storage, otherIntent.wallet),
    { status: "pending", intent: otherIntent },
  );
});

test("pending claim reads fail closed on malformed, over-cap, expired, and corrupt state", () => {
  const now = Date.now();
  const validIntent = (index, overrides = {}) => ({
    chainId: 4663,
    wallet: `0x${BigInt(index + 1).toString(16).padStart(40, "0")}`,
    poolId: `0x${BigInt(index + 1).toString(16).padStart(64, "0")}`,
    hash: null,
    invokedAt: now,
    ...overrides,
  });
  const cases = [
    { raw: "{", reason: "malformed" },
    { raw: JSON.stringify({ pending: [] }), reason: "malformed" },
    {
      raw: JSON.stringify(Array.from({ length: 21 }, (_, index) => validIntent(index))),
      reason: "over-cap",
    },
    {
      raw: JSON.stringify([validIntent(0, { invokedAt: now - 31 * 24 * 60 * 60 * 1_000 })]),
      reason: "expired",
    },
    {
      raw: JSON.stringify([validIntent(0, { hash: "0x1234" })]),
      reason: "corrupt",
    },
    {
      raw: JSON.stringify([validIntent(0), validIntent(1, { wallet: validIntent(0).wallet })]),
      reason: "corrupt",
    },
  ];

  for (const scenario of cases) {
    const storage = memoryStorage();
    storage.setItem(pendingClaims.PENDING_CLAIMS_STORAGE_KEY, scenario.raw);
    assert.deepEqual(
      pendingClaims.readPendingClaimStateForWallet(storage, wallet, now),
      { status: "recovery-required", reason: scenario.reason },
    );
  }
});

test("unreadable pending claim storage locks reads and rejects unsafe mutation", () => {
  const readFailure = memoryStorage();
  readFailure.getItem = () => {
    throw new Error("storage denied");
  };
  assert.deepEqual(
    pendingClaims.readPendingClaimStateForWallet(readFailure, wallet),
    { status: "recovery-required", reason: "unreadable" },
  );

  const malformed = memoryStorage();
  malformed.setItem(pendingClaims.PENDING_CLAIMS_STORAGE_KEY, "{");
  assert.throws(
    () => pendingClaims.savePendingClaim(malformed, {
      chainId: 4663,
      wallet,
      poolId,
      hash: null,
      invokedAt: Date.now(),
    }),
    (error) =>
      error instanceof pendingClaims.PendingClaimPersistenceError &&
      error.reason === "malformed",
  );
  assert.equal(malformed.getItem(pendingClaims.PENDING_CLAIMS_STORAGE_KEY), "{");

  pendingClaims.resetPendingClaimStore(malformed);
  assert.deepEqual(
    pendingClaims.readPendingClaimStateForWallet(malformed, wallet),
    { status: "clear" },
  );

  const atCap = memoryStorage();
  const atCapIntents = Array.from({ length: 20 }, (_, index) => ({
    chainId: 4663,
    wallet: `0x${BigInt(index + 1).toString(16).padStart(40, "0")}`,
    poolId: `0x${BigInt(index + 1).toString(16).padStart(64, "0")}`,
    hash: null,
    invokedAt: Date.now(),
  }));
  atCap.setItem(
    pendingClaims.PENDING_CLAIMS_STORAGE_KEY,
    JSON.stringify(atCapIntents),
  );
  const atCapRaw = atCap.getItem(pendingClaims.PENDING_CLAIMS_STORAGE_KEY);
  assert.throws(
    () => pendingClaims.savePendingClaim(atCap, {
      chainId: 4663,
      wallet,
      poolId,
      hash: null,
      invokedAt: Date.now(),
    }),
    (error) =>
      error instanceof pendingClaims.PendingClaimPersistenceError &&
      error.reason === "over-cap",
  );
  assert.equal(atCap.getItem(pendingClaims.PENDING_CLAIMS_STORAGE_KEY), atCapRaw);

  const occupied = memoryStorage();
  const existing = {
    chainId: 4663,
    wallet,
    poolId,
    hash: null,
    invokedAt: Date.now(),
  };
  pendingClaims.savePendingClaim(occupied, existing);
  assert.throws(
    () => pendingClaims.savePendingClaim(occupied, existing),
    (error) =>
      error instanceof pendingClaims.PendingClaimPersistenceError &&
      error.reason === "corrupt",
  );

  const writeFailure = memoryStorage();
  writeFailure.setItem = () => {
    throw new Error("quota denied");
  };
  assert.throws(
    () => pendingClaims.savePendingClaim(writeFailure, {
      chainId: 4663,
      wallet,
      poolId,
      hash: null,
      invokedAt: Date.now(),
    }),
    (error) =>
      error instanceof pendingClaims.PendingClaimPersistenceError &&
      error.reason === "unreadable",
  );

  const droppedWrite = memoryStorage();
  droppedWrite.setItem = () => undefined;
  assert.throws(
    () => pendingClaims.savePendingClaim(droppedWrite, {
      chainId: 4663,
      wallet,
      poolId,
      hash: null,
      invokedAt: Date.now(),
    }),
    (error) =>
      error instanceof pendingClaims.PendingClaimPersistenceError &&
      error.reason === "unreadable",
  );
});

test("wallet claim UI keeps corrupt persistence locked behind explicit recovery", () => {
  const component = readFileSync(resolve(root, "app/_components/WalletPortfolio.tsx"), "utf8");
  assert.match(component, /readPendingClaimStateForWallet/);
  assert.match(component, /pendingClaim \|\| claimRecovery/);
  assert.match(component, /!claimStorageReady/);
  assert.match(component, /Claims are locked\./);
  assert.match(component, /resetPendingClaimStore/);
  assert.match(component, /I checked wallet activity; reset all local claim locks/);
  assert.match(component, /removeExactPendingClaim/);
  const immediateFlow = component.slice(
    component.indexOf("async function claim("),
    component.indexOf("async function reconcilePendingClaim("),
  );
  assert.match(
    immediateFlow,
    /isCanonicalClaimReverted\(cause\)[\s\S]*unlockCanonicallyRevertedClaim\(revertedIntent\)/,
  );
  assert.match(
    immediateFlow,
    /isClaimSubmissionIndeterminate\(cause\) \|\| submittedHash !== null/,
  );
  const reloadFlow = component.slice(
    component.indexOf("async function reconcilePendingClaim("),
    component.indexOf("function clearReconciledClaimLock("),
  );
  assert.match(
    reloadFlow,
    /isCanonicalClaimReverted\(cause\)[\s\S]*unlockCanonicallyRevertedClaim\(pendingClaim\)/,
  );
  assert.match(component, /No payout occurred; refresh the claimable balance and retry/);
});

test("creator claim uses two manifest snapshots and makes account/chain checks last", async () => {
  const calls = [];
  let verifyCount = 0;
  const provider = submissionProvider(() => txHash);
  const wrapped = {
    async request(args) {
      calls.push(args.method);
      return provider.request(args);
    },
  };
  const client = new claim.CreatorClaimClient(
    wrapped,
    manifest(),
    async (...args) => {
      verifyCount += 1;
      return verify(...args);
    },
    { confirmationProvider: wrapped },
  );
  const events = [];
  const submitted = await client.claim(wallet, poolId, {
    onSubmissionInvoked: () => events.push("invoked"),
    onSubmitted: (hash) => events.push(hash),
  });
  assert.equal(submitted.hash, txHash);
  assert.equal(verifyCount, 2);
  assert.deepEqual(events, ["invoked", txHash]);
  assert.deepEqual(calls.slice(-3), ["eth_accounts", "eth_chainId", "eth_sendTransaction"]);
});

test("post-invocation errors are indeterminate but explicit rejection is retry-safe", async () => {
  const timeoutClient = new claim.CreatorClaimClient(
    submissionProvider(() => { throw Object.assign(new Error("timeout"), { code: -32000 }); }),
    manifest(),
    verify,
    { confirmationProvider: submissionProvider(() => txHash) },
  );
  await assert.rejects(
    timeoutClient.claim(wallet, poolId),
    (error) => claim.isClaimSubmissionIndeterminate(error),
  );

  const rejectedClient = new claim.CreatorClaimClient(
    submissionProvider(() => { throw Object.assign(new Error("rejected"), { code: 4001 }); }),
    manifest(),
    verify,
    { confirmationProvider: submissionProvider(() => txHash) },
  );
  await assert.rejects(
    rejectedClient.claim(wallet, poolId),
    (error) => !claim.isClaimSubmissionIndeterminate(error) && error.code === 4001,
  );
});

function claimLog(amount) {
  return {
    address: hook,
    topics: viem.encodeEventTopics({
      abi: claimAbi,
      eventName: "CreatorFeesClaimed",
      args: { poolId, creator: wallet },
    }),
    data: viem.encodeAbiParameters([{ type: "uint256" }], [amount]),
  };
}

function confirmationProvider(amount, overrides = {}) {
  const {
    receiptStatus = "0x1",
    confirmationHead = "0x65",
    canonicalBlockHash = blockHash,
    canonicalTransactions = [txHash],
    receiptLogs = [claimLog(amount)],
    ...transactionOverrides
  } = overrides;
  const data = viem.encodeFunctionData({
    abi: claimAbi,
    functionName: "claim",
    args: [poolId],
  });
  const receipt = {
    transactionHash: txHash,
    blockHash,
    blockNumber: "0x64",
    status: receiptStatus,
    from: wallet,
    to: hook,
    logs: receiptLogs,
  };
  const transaction = {
    hash: txHash,
    from: wallet,
    to: hook,
    input: data,
    value: "0x0",
    blockHash,
    blockNumber: "0x64",
    ...transactionOverrides,
  };
  return {
    async request(args) {
      if (args.method === "eth_chainId") return "0x1237";
      if (args.method === "eth_getTransactionReceipt") return receipt;
      if (args.method === "eth_getTransactionByHash") return transaction;
      if (args.method === "eth_getBlockByNumber") {
        return {
          hash: canonicalBlockHash,
          number: "0x64",
          transactions: canonicalTransactions,
        };
      }
      if (args.method === "eth_blockNumber") return confirmationHead;
      throw new Error(`Unexpected ${args.method}`);
    },
  };
}

test("claim confirmation binds canonical calldata/value and rejects zero payout", async () => {
  const zeroClient = new claim.CreatorClaimClient(
    submissionProvider(() => txHash),
    manifest(),
    verify,
    { confirmationProvider: confirmationProvider(0n) },
  );
  await assert.rejects(
    zeroClient.confirmClaim(txHash, { account: wallet, poolId }, { pollIntervalMs: 1 }),
    (error) =>
      !claim.isCanonicalClaimReverted(error) &&
      /paid zero PIPEDOG/i.test(error.message),
  );

  const wrongValueClient = new claim.CreatorClaimClient(
    submissionProvider(() => txHash),
    manifest(),
    verify,
    { confirmationProvider: confirmationProvider(1n, { value: "0x1" }) },
  );
  await assert.rejects(
    wrongValueClient.confirmClaim(txHash, { account: wallet, poolId }, { pollIntervalMs: 1 }),
    /Canonical claim input, value/,
  );

  const validClient = new claim.CreatorClaimClient(
    submissionProvider(() => txHash),
    manifest(),
    verify,
    { confirmationProvider: confirmationProvider(7n) },
  );
  const confirmed = await validClient.confirmClaim(
    txHash,
    { account: wallet, poolId },
    { pollIntervalMs: 1 },
  );
  assert.equal(confirmed.claimedAmount, 7n);
});

test("only an exact canonical depth-two status-zero receipt is a proven claim revert", async () => {
  const canonicalClient = new claim.CreatorClaimClient(
    submissionProvider(() => txHash),
    manifest(),
    verify,
    {
      confirmationProvider: confirmationProvider(0n, {
        receiptStatus: "0x0",
        receiptLogs: [],
      }),
    },
  );
  await assert.rejects(
    canonicalClient.confirmClaim(
      txHash,
      { account: wallet, poolId },
      { timeoutMs: 20, pollIntervalMs: 1 },
    ),
    (error) =>
      claim.isCanonicalClaimReverted(error) &&
      error instanceof claim.CanonicalClaimRevertedError,
  );

  const unconfirmedClient = new claim.CreatorClaimClient(
    submissionProvider(() => txHash),
    manifest(),
    verify,
    {
      confirmationProvider: confirmationProvider(0n, {
        receiptStatus: "0x0",
        confirmationHead: "0x64",
      }),
    },
  );
  await assert.rejects(
    unconfirmedClient.confirmClaim(
      txHash,
      { account: wallet, poolId },
      { timeoutMs: 5, pollIntervalMs: 1 },
    ),
    (error) =>
      !claim.isCanonicalClaimReverted(error) &&
      /still pending/i.test(error.message),
  );

  const noncanonicalClient = new claim.CreatorClaimClient(
    submissionProvider(() => txHash),
    manifest(),
    verify,
    {
      confirmationProvider: confirmationProvider(0n, {
        receiptStatus: "0x0",
        canonicalBlockHash: transactionHash("c"),
      }),
    },
  );
  await assert.rejects(
    noncanonicalClient.confirmClaim(
      txHash,
      { account: wallet, poolId },
      { timeoutMs: 20, pollIntervalMs: 1 },
    ),
    (error) =>
      !claim.isCanonicalClaimReverted(error) &&
      /not the canonical block/i.test(error.message),
  );

  const mismatchedTransactionClient = new claim.CreatorClaimClient(
    submissionProvider(() => txHash),
    manifest(),
    verify,
    {
      confirmationProvider: confirmationProvider(0n, {
        receiptStatus: "0x0",
        value: "0x1",
      }),
    },
  );
  await assert.rejects(
    mismatchedTransactionClient.confirmClaim(
      txHash,
      { account: wallet, poolId },
      { timeoutMs: 20, pollIntervalMs: 1 },
    ),
    (error) =>
      !claim.isCanonicalClaimReverted(error) &&
      /input, value, sender, target, or block/i.test(error.message),
  );
});
