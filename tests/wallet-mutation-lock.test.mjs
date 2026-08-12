import assert from "node:assert/strict";
import test from "node:test";
import { tsImport } from "tsx/esm/api";

const mutationLock = await tsImport(
  "../lib/wallet/mutation-lock.ts",
  import.meta.url,
);
const pendingWalletMutations = await tsImport(
  "../lib/wallet/pending-wallet-mutations.ts",
  import.meta.url,
);
const pendingLaunches = await tsImport(
  "../lib/wallet/pending-launches.ts",
  import.meta.url,
);
const pendingTrades = await tsImport(
  "../lib/wallet/pending-trades.ts",
  import.meta.url,
);
const pendingClaims = await tsImport(
  "../lib/wallet/pending-claims.ts",
  import.meta.url,
);
const pendingKeeperActions = await tsImport(
  "../lib/wallet/pending-keeper-actions.ts",
  import.meta.url,
);
const keeperClient = await tsImport(
  "../lib/web3/keeper-client.ts",
  import.meta.url,
);

const wallet = "0x3333333333333333333333333333333333333333";
const otherWallet = "0x4444444444444444444444444444444444444444";
const token = "0x5555555555555555555555555555555555555555";
const target = "0x6666666666666666666666666666666666666666";
const poolId = `0x${"77".repeat(32)}`;
const salt = `0x${"88".repeat(32)}`;

class MemoryStorage {
  #values = new Map();
  get length() { return this.#values.size; }
  clear() { this.#values.clear(); }
  getItem(key) { return this.#values.get(key) ?? null; }
  key(index) { return [...this.#values.keys()][index] ?? null; }
  removeItem(key) { this.#values.delete(key); }
  setItem(key, value) { this.#values.set(key, String(value)); }
}

function launchIntent(owner = wallet) {
  return {
    chainId: 4663,
    wallet: owner,
    action: "launch",
    predictedToken: token,
    target,
    calldata: "0x1234",
    input: {
      params: {
        name: "Pipe Test",
        symbol: "PIPE",
        logo: "ipfs://image",
        description: "Cross-surface lock",
        metadataURI: "ipfs://metadata",
        socials: { telegram: "", twitter: "", discord: "", website: "", extra: "" },
        creator: owner,
      },
      configId: "7",
      firstBuyIn: "0",
      firstBuyMinOut: "0",
      salt,
    },
    hash: null,
    invokedAt: Date.now(),
  };
}

function tradeIntent(owner = wallet) {
  return {
    chainId: 4663,
    wallet: owner,
    action: "approval",
    tokenAddress: token,
    poolId,
    target: token,
    calldata: `0x095ea7b3${"00".repeat(31)}01${"00".repeat(31)}01`,
    value: "0x0",
    approval: { side: "sell", token, amount: "1", kind: "approve-exact" },
    hash: null,
    invokedAt: Date.now(),
  };
}

function claimIntent(owner = wallet) {
  return {
    chainId: 4663,
    wallet: owner,
    poolId,
    hash: null,
    invokedAt: Date.now(),
  };
}

function keeperIntent(owner = wallet) {
  const action = { kind: "sweep", poolId };
  return {
    chainId: 4663,
    wallet: owner,
    action: "sweep",
    poolId,
    target,
    calldata: keeperClient.keeperActionData(action),
    hash: null,
    invokedAt: Date.now(),
  };
}

function exclusiveLocks() {
  const held = new Set();
  return {
    async request(name, options, callback) {
      assert.deepEqual(options, { mode: "exclusive", ifAvailable: true });
      if (held.has(name)) return callback(null);
      held.add(name);
      try { return await callback({ name, mode: "exclusive" }); }
      finally { held.delete(name); }
    },
  };
}

function queuedLocks() {
  const held = new Set();
  const queues = new Map();

  function drain(name) {
    if (held.has(name)) return;
    const queue = queues.get(name);
    const next = queue?.shift();
    if (!next) return;
    if (queue.length === 0) queues.delete(name);
    held.add(name);
    Promise.resolve()
      .then(() => next.callback({ name, mode: "exclusive" }))
      .then(next.resolve, next.reject)
      .finally(() => {
        held.delete(name);
        drain(name);
      });
  }

  return {
    request(name, options, callback) {
      assert.equal(options.mode, "exclusive");
      if (options.ifAvailable) {
        if (held.has(name)) return Promise.resolve(callback(null));
        held.add(name);
        return Promise.resolve()
          .then(() => callback({ name, mode: "exclusive" }))
          .finally(() => {
            held.delete(name);
            drain(name);
          });
      }
      return new Promise((resolve, reject) => {
        const queue = queues.get(name) ?? [];
        queue.push({ callback, resolve, reject });
        queues.set(name, queue);
        drain(name);
      });
    },
  };
}

test("one shared wallet lock rejects a concurrent cross-surface submission", async () => {
  const locks = exclusiveLocks();
  let release;
  const first = mutationLock.withWalletMutationLock(locks, wallet, async () => {
    await new Promise((resolve) => { release = resolve; });
  });
  await Promise.resolve();
  await assert.rejects(
    mutationLock.withWalletMutationLock(locks, wallet, () => "claim send"),
    /Another tab is already submitting/i,
  );
  assert.equal(
    await mutationLock.withWalletMutationLock(locks, otherWallet, () => "other wallet"),
    "other wallet",
  );
  release();
  await first;
});

test("manual recovery cannot clear while the same wallet send is active", async () => {
  const locks = queuedLocks();
  let releaseSend;
  const activeSend = mutationLock.withWalletMutationLock(
    locks,
    wallet,
    () => new Promise((resolve) => { releaseSend = resolve; }),
  );
  await Promise.resolve();

  let recoveryInvoked = false;
  await assert.rejects(
    mutationLock.withWalletRecoveryLocks(locks, wallet, () => {
      recoveryInvoked = true;
    }),
    /Another tab is already submitting/i,
  );
  assert.equal(recoveryInvoked, false);
  releaseSend();
  await activeSend;
});

test("different wallets serialize short recovery-store writes without lost updates", async () => {
  const locks = queuedLocks();
  const order = [];
  let releaseFirstWrite;
  const first = mutationLock.withWalletMutationLock(locks, wallet, () =>
    mutationLock.withWalletRecoveryStoreLock(locks, async () => {
      order.push("wallet-a-start");
      await new Promise((resolve) => { releaseFirstWrite = resolve; });
      order.push("wallet-a-end");
    }),
  );
  await Promise.resolve();
  await Promise.resolve();

  const second = mutationLock.withWalletMutationLock(locks, otherWallet, () =>
    mutationLock.withWalletRecoveryStoreLock(locks, () => {
      order.push("wallet-b-write");
    }),
  );
  await Promise.resolve();
  assert.deepEqual(order, ["wallet-a-start"]);
  releaseFirstWrite();
  await Promise.all([first, second]);
  assert.deepEqual(order, ["wallet-a-start", "wallet-a-end", "wallet-b-write"]);
});

test("launch, trade, and claim records each block every wallet mutation surface", () => {
  const cases = [
    (storage) => pendingLaunches.savePendingLaunch(storage, launchIntent()),
    (storage) => pendingTrades.savePendingTrade(storage, tradeIntent()),
    (storage) => pendingClaims.savePendingClaim(storage, claimIntent()),
    (storage) => pendingKeeperActions.savePendingKeeperAction(storage, keeperIntent()),
  ];
  for (const persist of cases) {
    const storage = new MemoryStorage();
    persist(storage);
    assert.throws(
      () => pendingWalletMutations.assertNoPendingWalletMutation(storage, wallet),
      /unresolved LayPipe action/i,
    );
    assert.doesNotThrow(() =>
      pendingWalletMutations.assertNoPendingWalletMutation(storage, otherWallet),
    );
  }
});

test("malformed state in any recovery store blocks all mutation surfaces", () => {
  for (const key of pendingWalletMutations.PENDING_WALLET_MUTATION_STORAGE_KEYS) {
    const storage = new MemoryStorage();
    storage.setItem(key, "{not-json");
    assert.throws(
      () => pendingWalletMutations.assertNoPendingWalletMutation(storage, wallet),
      /blocked|cannot be trusted/i,
    );
  }
});

test("mutation lock fails closed when the Web Locks API is unsupported", async () => {
  await assert.rejects(
    mutationLock.withWalletMutationLock(undefined, wallet, () => "send"),
    /cannot provide the required cross-tab wallet lock/i,
  );
});

test("all wallet mutation UIs use the shared lock and cross-surface guard", async () => {
  const { readFile } = await import("node:fs/promises");
  const files = [
    "app/launch/LaunchForm.tsx",
    "app/_components/WalletPortfolio.tsx",
    "app/token/[slug]/TradePanel.tsx",
    "app/_components/KeeperRewardsPanel.tsx",
  ];
  for (const file of files) {
    const source = await readFile(new URL(`../${file}`, import.meta.url), "utf8");
    assert.match(source, /withWalletMutationLock\(/, `${file} must acquire the shared lock`);
    assert.match(
      source,
      /assertNoPendingWalletMutation\(window\.localStorage,/,
      `${file} must check every pending recovery store inside the lock`,
    );
    assert.match(
      source,
      /withWalletRecoveryStoreLock\(/,
      `${file} must serialize durable intent writes across wallets`,
    );
    assert.match(
      source,
      /withWalletRecoveryLocks\(/,
      `${file} must serialize manual recovery against active sends`,
    );
  }
});

test("submitted hashes are canonical-reconcile-only on every mutation surface", async () => {
  const { readFile } = await import("node:fs/promises");
  const sources = await Promise.all([
    "app/launch/LaunchForm.tsx",
    "app/_components/WalletPortfolio.tsx",
    "app/token/[slug]/TradePanel.tsx",
    "app/_components/KeeperRewardsPanel.tsx",
  ].map((file) => readFile(new URL(`../${file}`, import.meta.url), "utf8")));

  for (const source of sources) {
    assert.match(source, /hash (?:!== null|=== null)|!.*\.hash|.*\.hash !== null/);
    assert.match(source, /withWalletRecoveryLocks\(navigator\.locks,/);
  }
  assert.match(sources[0], /\{!pendingIntent\.hash && \(/);
  assert.match(sources[1], /\{!pendingClaim\.hash && \(/);
  assert.match(sources[2], /!restoredIntent\.hash/);
  assert.match(sources[3], /\{!pendingAction\.hash && \(/);
});

test("launch and trade UIs remove only the exact saved recovery intent", async () => {
  const { readFile } = await import("node:fs/promises");
  const launch = await readFile(
    new URL("../app/launch/LaunchForm.tsx", import.meta.url),
    "utf8",
  );
  const trade = await readFile(
    new URL("../app/token/[slug]/TradePanel.tsx", import.meta.url),
    "utf8",
  );
  assert.match(launch, /removeExactPendingLaunch\(window\.localStorage, expected\)/);
  assert.match(launch, /removeExactUnsubmittedPendingLaunch\(window\.localStorage, expected\)/);
  assert.doesNotMatch(launch, /\bremovePendingLaunch\b/);
  assert.match(trade, /removeExactPendingTrade\(window\.localStorage, expected\)/);
  assert.match(trade, /removeExactUnsubmittedPendingTrade\(window\.localStorage, expected\)/);
  assert.doesNotMatch(trade, /\bremovePendingTrade\b/);
});

test("known keeper hashes cannot be manually cleared before canonical reconciliation", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(
    new URL("../app/_components/KeeperRewardsPanel.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /if \(!account \|\| !pendingAction \|\| pendingAction\.hash !== null\) return/);
  assert.match(source, /removeExactUnsubmittedKeeperAction\(window\.localStorage, pendingAction\)/);
  assert.match(source, /\{!pendingAction\.hash && \(/);
  assert.doesNotMatch(source, /removePendingKeeperActionForWallet/);
});
