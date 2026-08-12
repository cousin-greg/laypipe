import assert from "node:assert/strict";
import test from "node:test";
import { tsImport } from "tsx/esm/api";

const launchClient = await tsImport(
  "../lib/web3/launch-client.ts",
  import.meta.url,
);
const pendingLaunches = await tsImport(
  "../lib/wallet/pending-launches.ts",
  import.meta.url,
);

const factory = "0x2222222222222222222222222222222222222222";
const owner = "0x3333333333333333333333333333333333333333";
const token = "0x44444444444444444444444444444444444444cc";
const pipedog = "0x5Cb6F181081301b44905F3ae15419112ecaBd8A6";
const hook = "0x6666666666666666666666666666666666666666";
const selfBurner = "0x7777777777777777777777777777777777777777";
const hash = `0x${"ab".repeat(32)}`;
const blockHash = `0x${"ef".repeat(32)}`;
const poolId = `0x${"cd".repeat(32)}`;

const input = {
  params: {
    name: "Pipe Test",
    symbol: "PIPE",
    logo: "ipfs://bafy-image",
    description: "Exact intent",
    metadataURI: "ipfs://bafy-metadata",
    socials: {
      telegram: "",
      twitter: "",
      discord: "",
      website: "",
      extra: "",
    },
    creator: owner,
  },
  configId: 7n,
  firstBuyIn: 0n,
  firstBuyMinOut: 0n,
  salt: `0x${"12".repeat(32)}`,
};

function manifest() {
  return {
    manifestVersion: 1,
    environment: "robinhood-production",
    testOnly: false,
    contracts: {
      factoryProxy: { address: factory },
      pipedog: { address: pipedog },
      hook: { address: hook },
      selfBurner: { address: selfBurner },
    },
    launch: {
      creator: { id: 7n, config: { selfBurn: false } },
      selfBurn: { id: 8n, config: { selfBurn: true } },
    },
  };
}

function walletProvider(sendResult = hash, account = owner) {
  const methods = [];
  return {
    methods,
    provider: {
      async request({ method }) {
        methods.push(method);
        if (method === "eth_chainId") return "0x1237";
        if (method === "eth_accounts") return [account];
        if (method === "eth_estimateGas") return "0x5208";
        if (method === "eth_sendTransaction") {
          if (sendResult instanceof Error ||
              (sendResult && typeof sendResult === "object" && "code" in sendResult)) {
            throw sendResult;
          }
          return sendResult;
        }
        throw new Error(`Unexpected wallet method ${method}`);
      },
    },
  };
}

class MemoryStorage {
  #values = new Map();

  getItem(key) {
    return this.#values.get(key) ?? null;
  }

  setItem(key, value) {
    this.#values.set(key, String(value));
  }
}

function word(value) {
  const bigint = typeof value === "bigint" ? value : BigInt(value);
  return bigint.toString(16).padStart(64, "0");
}

function addressWord(address) {
  return address.slice(2).toLowerCase().padStart(64, "0");
}

function topicAddress(address) {
  return `0x${addressWord(address)}`;
}

function receipt(target, logs = []) {
  return {
    transactionHash: hash,
    blockHash,
    blockNumber: "0x10",
    status: "0x1",
    from: owner,
    to: target,
    logs,
  };
}

function canonicalProvider({
  target,
  calldata,
  logs = [],
  value = "0x0",
  allowance,
  tokenPoolId = poolId,
  firstHead = "0x11",
}) {
  let headReads = 0;
  let receiptReads = 0;
  return {
    observations: () => ({ headReads, receiptReads }),
    provider: {
      async request({ method, params }) {
        if (method === "eth_chainId") return "0x1237";
        if (method === "eth_getTransactionReceipt") {
          receiptReads += 1;
          return receipt(target, logs);
        }
        if (method === "eth_getTransactionByHash") {
          return {
            hash,
            from: owner,
            to: target,
            input: calldata,
            value,
            blockHash,
            blockNumber: "0x10",
          };
        }
        if (method === "eth_getBlockByNumber") {
          return { hash: blockHash, number: "0x10", transactions: [hash] };
        }
        if (method === "eth_blockNumber") {
          headReads += 1;
          return headReads === 1 ? firstHead : "0x11";
        }
        if (method === "eth_call") {
          const call = params[0];
          if (call.to.toLowerCase() === token.toLowerCase()) return tokenPoolId;
          if (allowance !== undefined) return `0x${word(allowance)}`;
        }
        throw new Error(`Unexpected confirmation method ${method}`);
      },
    },
  };
}

test("submission re-verifies deployment and wallet context immediately before send", async () => {
  const wallet = walletProvider();
  const order = [];
  const originalRequest = wallet.provider.request;
  wallet.provider.request = async (args) => {
    order.push(args.method);
    return originalRequest(args);
  };
  const client = new launchClient.LaypipeLaunchClient(
    wallet.provider,
    manifest(),
    {
      verifyDeployment: async () => {
        order.push("verifyDeployment");
        return { blockNumber: 1n, blockTag: "0x1" };
      },
      confirmationProvider: { request: async () => null },
    },
  );
  const callbacks = [];
  assert.equal(
    await client.sendApproval(owner, 125n, {
      onSubmissionInvoked: () => callbacks.push("invoked"),
      onSubmitted: (submittedHash) => callbacks.push(submittedHash),
    }),
    hash,
  );
  assert.deepEqual(callbacks, ["invoked", hash]);
  assert.deepEqual(order.slice(-4), [
    "verifyDeployment",
    "eth_accounts",
    "eth_chainId",
    "eth_sendTransaction",
  ]);
  assert.equal(order.filter((item) => item === "verifyDeployment").length, 2);
});

test("only explicit 4001 is retry-safe after send invocation", async () => {
  async function submit(sendError) {
    const wallet = walletProvider(sendError);
    const client = new launchClient.LaypipeLaunchClient(
      wallet.provider,
      manifest(),
      {
        verifyDeployment: async () => ({ blockNumber: 1n, blockTag: "0x1" }),
        confirmationProvider: { request: async () => null },
      },
    );
    let invoked = 0;
    try {
      await client.sendApproval(owner, 1n, {
        onSubmissionInvoked: () => {
          invoked += 1;
        },
      });
      assert.fail("submission should reject");
    } catch (error) {
      return { error, invoked };
    }
  }

  const rejected = await submit({ code: 4001, message: "Rejected" });
  assert.equal(rejected.invoked, 1);
  assert.equal(launchClient.isLaunchSubmissionIndeterminate(rejected.error), false);
  assert.match(rejected.error.message, /rejected/i);

  const rpcFailure = await submit({ code: -32603, message: "Transport lost" });
  assert.equal(rpcFailure.invoked, 1);
  assert.equal(launchClient.isLaunchSubmissionIndeterminate(rpcFailure.error), true);
  assert.match(rpcFailure.error.message, /may have broadcast/i);

  const malformed = await submit("not-a-hash");
  assert.equal(launchClient.isLaunchSubmissionIndeterminate(malformed.error), true);
});

test("account drift blocks submission before the wallet send method", async () => {
  const wallet = walletProvider(
    hash,
    "0x9999999999999999999999999999999999999999",
  );
  const client = new launchClient.LaypipeLaunchClient(
    wallet.provider,
    manifest(),
    {
      verifyDeployment: async () => ({ blockNumber: 1n, blockTag: "0x1" }),
      confirmationProvider: { request: async () => null },
    },
  );
  await assert.rejects(client.sendLaunch(owner, input), /account changed/i);
  assert.equal(wallet.methods.includes("eth_sendTransaction"), false);
});

test("approval confirmation requires canonical inclusion, two blocks, exact calldata, zero value, and allowance", async () => {
  const amount = 125n;
  const calldata = launchClient.approvalCalldata(factory, amount);
  const independent = canonicalProvider({
    target: pipedog,
    calldata,
    allowance: amount,
    firstHead: "0x10",
  });
  const client = new launchClient.LaypipeLaunchClient(
    { request: async () => null },
    factory,
    { confirmationProvider: independent.provider },
  );
  const confirmed = await client.confirmApproval(hash, owner, amount, {
    pollIntervalMs: 0,
  });
  assert.equal(confirmed.allowance, amount);
  assert.deepEqual(independent.observations(), { headReads: 2, receiptReads: 2 });

  const nonzeroValue = canonicalProvider({
    target: pipedog,
    calldata,
    allowance: amount,
    value: "0x1",
  });
  const tampered = new launchClient.LaypipeLaunchClient(
    { request: async () => null },
    factory,
    { confirmationProvider: nonzeroValue.provider },
  );
  await assert.rejects(
    tampered.confirmApproval(hash, owner, amount),
    /input, value, sender, target, or block/i,
  );

  const wrongAllowance = canonicalProvider({
    target: pipedog,
    calldata,
    allowance: amount - 1n,
  });
  const stale = new launchClient.LaypipeLaunchClient(
    { request: async () => null },
    factory,
    { confirmationProvider: wrongAllowance.provider },
  );
  await assert.rejects(
    stale.confirmApproval(hash, owner, amount),
    /allowance does not match/i,
  );
});

test("launch confirmation binds canonical calldata, prediction, unique event, and token pool ID", async () => {
  const calldata = launchClient.launchCalldata(input);
  const eventData = `0x${[
    word(input.configId),
    word(input.firstBuyIn),
    word(0n),
    addressWord(hook),
    addressWord(owner),
  ].join("")}`;
  const launchLog = {
    address: factory,
    data: eventData,
    topics: [
      launchClient.TOKEN_LAUNCHED_TOPIC,
      topicAddress(token),
      topicAddress(owner),
      poolId,
    ],
  };
  const independent = canonicalProvider({
    target: factory,
    calldata,
    logs: [launchLog],
  });
  const client = new launchClient.LaypipeLaunchClient(
    { request: async () => null },
    manifest(),
    {
      verifyDeployment: async () => ({ blockNumber: 1n, blockTag: "0x1" }),
      confirmationProvider: independent.provider,
    },
  );
  const confirmed = await client.confirmLaunch(hash, {
    creator: owner,
    predictedToken: token,
    input,
  });
  assert.equal(confirmed.poolId, poolId);
  assert.equal(confirmed.token.toLowerCase(), token.toLowerCase());

  const duplicate = canonicalProvider({
    target: factory,
    calldata,
    logs: [launchLog, launchLog],
  });
  const duplicatedClient = new launchClient.LaypipeLaunchClient(
    { request: async () => null },
    manifest(),
    { confirmationProvider: duplicate.provider },
  );
  await assert.rejects(
    duplicatedClient.confirmLaunch(hash, {
      creator: owner,
      predictedToken: token,
      input,
    }),
    /exactly one TokenLaunched/i,
  );

  const wrongPool = canonicalProvider({
    target: factory,
    calldata,
    logs: [launchLog],
    tokenPoolId: `0x${"99".repeat(32)}`,
  });
  const wrongPoolClient = new launchClient.LaypipeLaunchClient(
    { request: async () => null },
    manifest(),
    { confirmationProvider: wrongPool.provider },
  );
  await assert.rejects(
    wrongPoolClient.confirmLaunch(hash, {
      creator: owner,
      predictedToken: token,
      input,
    }),
    /pool ID does not match/i,
  );
});

test("pending launch intent is keyed, durable, and malformed storage fails closed", () => {
  const storage = new MemoryStorage();
  const intent = {
    chainId: 4663,
    wallet: owner,
    action: "launch",
    predictedToken: token,
    target: factory,
    calldata: launchClient.launchCalldata(input),
    input: pendingLaunches.serializeLaunchInput(input),
    hash: null,
    invokedAt: Date.now(),
  };
  pendingLaunches.savePendingLaunch(storage, intent);
  let restored = pendingLaunches.readPendingLaunchForWallet(storage, owner);
  assert.equal(restored.hash, null);
  assert.deepEqual(pendingLaunches.deserializeLaunchInput(restored.input), input);

  pendingLaunches.savePendingLaunchHash(
    storage,
    owner,
    "launch",
    token,
    hash,
  );
  restored = pendingLaunches.readPendingLaunchForWallet(storage, owner);
  assert.equal(restored.hash, hash);
  assert.equal(
    pendingLaunches.readPendingLaunchForWallet(
      storage,
      "0x8888888888888888888888888888888888888888",
    ),
    null,
  );

  assert.throws(
    () =>
      pendingLaunches.savePendingLaunch(storage, {
        ...intent,
        action: "approval",
        amount: "1",
      }),
    /different pending launch action/i,
  );
  pendingLaunches.removePendingLaunch(storage, owner, "launch", token);
  assert.equal(pendingLaunches.readPendingLaunchForWallet(storage, owner), null);

  storage.setItem("laypipe.pending-launches.v1", "{not-json");
  assert.throws(
    () => pendingLaunches.readPendingLaunchForWallet(storage, owner),
    /wallet mutations are blocked/i,
  );
});
