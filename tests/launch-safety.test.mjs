import assert from "node:assert/strict";
import crypto from "node:crypto";
import { File } from "node:buffer";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const moduleCache = new Map();

function loadTypeScript(relativePath) {
  const filename = resolve(repositoryRoot, relativePath);
  if (moduleCache.has(filename)) return moduleCache.get(filename).exports;

  const loadedModule = { exports: {} };
  moduleCache.set(filename, loadedModule);
  const source = readFileSync(filename, "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: filename,
  }).outputText;

  function localRequire(specifier) {
    if (!specifier.startsWith(".")) return require(specifier);
    const unresolved = resolve(dirname(filename), specifier);
    const dependency = extname(unresolved) ? unresolved : `${unresolved}.ts`;
    return loadTypeScript(dependency.slice(repositoryRoot.length + 1));
  }

  const evaluate = new Function(
    "require",
    "module",
    "exports",
    "__filename",
    "__dirname",
    output,
  );
  evaluate(
    localRequire,
    loadedModule,
    loadedModule.exports,
    filename,
    dirname(filename),
  );
  return loadedModule.exports;
}

const artwork = loadTypeScript("lib/ipfs/artwork.ts");
const metadata = loadTypeScript("lib/ipfs/metadata.ts");
const pinClient = loadTypeScript("lib/ipfs/pin-client.ts");
const abi = loadTypeScript("lib/web3/abi.ts");
const launchClient = loadTypeScript("lib/web3/launch-client.ts");
const launchMachine = loadTypeScript("lib/web3/launch-machine.ts");
const web3Types = loadTypeScript("lib/web3/types.ts");

function pngBytes(width, height, trailingByte = 0) {
  const bytes = new Uint8Array(25);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width, false);
  view.setUint32(20, height, false);
  bytes[24] = trailingByte;
  return bytes;
}

function pngFile(width = 256, height = 256, trailingByte = 0) {
  return new File([pngBytes(width, height, trailingByte)], "coin.png", {
    type: "image/png",
    lastModified: 1234,
  });
}

test("artwork validation inspects bytes, dimensions, and content identity", async () => {
  const valid = await artwork.validateArtworkFile(pngFile());
  assert.equal(valid.width, 256);
  assert.equal(valid.height, 256);
  assert.equal(valid.mimeType, "image/png");

  await assert.rejects(
    artwork.validateArtworkFile(pngFile(256, 300)),
    /must be square/,
  );
  await assert.rejects(
    artwork.validateArtworkFile(
      new File([pngBytes(256, 256)], "fake.webp", { type: "image/webp" }),
    ),
    /does not match/,
  );
  const first = pngFile(256, 256, 1);
  const second = pngFile(256, 256, 2);
  assert.equal(first.size, second.size);
  assert.equal(first.lastModified, second.lastModified);
  assert.notEqual(
    await artwork.artworkContentHash(first),
    await artwork.artworkContentHash(second),
  );
});

test("metadata uses the dual-CID document shape and HTTPS-only socials", () => {
  const draft = metadata.normalizeMetadataDraft({
    name: "Pipe Coin",
    symbol: "pipe",
    description: "A coin in the pipe.",
    feeMode: "self-burn",
    website: "https://example.com/token#ignored",
    twitter: "https://x.com/pipecoin",
  });
  const imageUri =
    "ipfs://bafybeigdyrzt5sfp7udm7hu76v2m5v3ejq3w6t4x5n5x5x5x5x5x5x5x5x";
  const document = metadata.buildTokenMetadata(draft, imageUri);
  assert.equal(document.image, imageUri);
  assert.equal(document.symbol, "PIPE");
  assert.equal(document.website, "https://example.com/token");
  assert.deepEqual(document.attributes, [
    { trait_type: "launch_provider", value: "laypipe" },
    { trait_type: "chain", value: "robinhood" },
    { trait_type: "fee_mode", value: "self-burn" },
  ]);
  assert.throws(
    () =>
      metadata.normalizeMetadataDraft({
        name: "Bad Link",
        symbol: "BAD",
        description: "No insecure links.",
        feeMode: "creator",
        website: "http://example.com",
      }),
    /must use HTTPS/,
  );
});

test("pinning is same-origin and fails closed on metadata substitution", async () => {
  const file = pngFile();
  const draft = metadata.normalizeMetadataDraft({
    name: "Pinned Pipe",
    symbol: "PIN",
    description: "Pinned twice.",
    feeMode: "creator",
  });
  const imageCid =
    "bafybeigdyrzt5sfp7udm7hu76v2m5v3ejq3w6t4x5n5x5x5x5x5x5x5x5x";
  const metadataCid =
    "bafybeifaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const imageUri = `ipfs://${imageCid}`;
  const expectedDocument = metadata.buildTokenMetadata(draft, imageUri);

  const fetcher = async (url, init) => {
    assert.equal(url, "https://laypipe.fun/api/ipfs/pin");
    assert.equal(init.method, "POST");
    assert.deepEqual(JSON.parse(init.body.get("metadata")), draft);
    return new Response(
      JSON.stringify({
        image: { cid: imageCid, uri: imageUri },
        metadata: { cid: metadataCid, uri: `ipfs://${metadataCid}` },
        metadataDocument: expectedDocument,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  const pinned = await pinClient.pinLaunchAssets({
    endpoint: "/api/ipfs/pin",
    file,
    metadata: draft,
    browserOrigin: "https://laypipe.fun",
    fetcher,
  });
  assert.deepEqual(pinned.metadataDocument, expectedDocument);

  await assert.rejects(
    pinClient.pinLaunchAssets({
      endpoint: "https://attacker.example/upload",
      file,
      metadata: draft,
      browserOrigin: "https://laypipe.fun",
      fetcher,
    }),
    /same-origin/,
  );
  await assert.rejects(
    pinClient.pinLaunchAssets({
      endpoint: "/api/ipfs/pin",
      file,
      metadata: draft,
      browserOrigin: "https://laypipe.fun",
      fetcher: async () =>
        new Response(
          JSON.stringify({
            image: { cid: imageCid, uri: imageUri },
            metadata: { cid: metadataCid, uri: `ipfs://${metadataCid}` },
            metadataDocument: { ...expectedDocument, symbol: "SWAPPED" },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    }),
    /does not match/,
  );
  await assert.rejects(
    pinClient.pinLaunchAssets({
      endpoint: "/api/ipfs/pin",
      file,
      metadata: draft,
      browserOrigin: "https://laypipe.fun",
      fetcher: async () =>
        new Response(
          JSON.stringify({
            image: {
              cid: imageCid,
              uri: imageUri,
              gatewayUrl: `https://gateway.example/ipfs/${metadataCid}`,
            },
            metadata: { cid: metadataCid, uri: `ipfs://${metadataCid}` },
            metadataDocument: expectedDocument,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    }),
    /match its CID path/,
  );
});

test("approval planning never emits an unlimited approval", () => {
  const required = 125n;
  assert.deepEqual(launchClient.buildExactApprovalPlan(0n, required).steps, [
    {
      kind: "approve-exact",
      amount: required,
      label: "Approve exact PIPEDOG amount",
    },
  ]);
  assert.deepEqual(launchClient.buildExactApprovalPlan(required, required).steps, []);
  assert.deepEqual(
    launchClient.buildExactApprovalPlan(99n, required).steps.map((step) => step.amount),
    [0n, required],
  );
  assert.throws(() => launchClient.assertFirstBuyAmounts(1n, 0n), /non-zero minimum/);
  assert.throws(() => launchClient.assertFirstBuyAmounts(0n, 1n), /must be zero/);
  assert.doesNotThrow(() => launchClient.assertFirstBuyAmounts(0n, 0n));
});

test("RPC quantities accept odd-length canonical hex without weakening byte data", () => {
  assert.equal(web3Types.isHexQuantity("0x1"), true);
  assert.equal(web3Types.isHexQuantity("0x5208"), true);
  assert.equal(web3Types.isHexQuantity("0x01"), false);
  assert.equal(web3Types.isHexData("0x1"), false);
  assert.equal(web3Types.isHexData("0x5208"), true);
});

test("selectors, event topic, and dynamic calldata match Foundry-derived fixtures", () => {
  assert.deepEqual(abi.LAYPIPE_CALL_SELECTORS, {
    allowance: "dd62ed3e",
    approve: "095ea7b3",
    balanceOf: "70a08231",
    getLaunchConfig: "1cad862d",
    launch: "75154d70",
    launchEnabled: "236a4afb",
    launchFee: "cf3cf573",
    mineSalt: "c5ce3f21",
    quoteToken: "217a4b70",
  });
  assert.equal(
    launchClient.TOKEN_LAUNCHED_TOPIC,
    "0x17091df68f499cf4e20dcfc5d42f064dd22359e785b77691c4c4ed0322608897",
  );

  const params = {
    name: "Name",
    symbol: "SYM",
    logo: "logo",
    description: "desc",
    metadataURI: "meta",
    socials: {
      telegram: "tg",
      twitter: "tw",
      discord: "dc",
      website: "web",
      extra: "extra",
    },
    creator: "0x1111111111111111111111111111111111111111",
  };
  const launch = abi.encodeLaunchCall({
    params,
    configId: 2n,
    firstBuyIn: 3n,
    firstBuyMinOut: 4n,
    salt: `0x${"00".repeat(31)}05`,
  });
  const mine = abi.encodeMineSaltCall({
    params,
    configId: 2n,
    sender: params.creator,
    start: 7n,
    rounds: 8n,
  });
  assert.equal(
    crypto.createHash("sha256").update(launch).digest("hex"),
    "485bb4afccacc62bb2b111ae6cfd61eed6cd4d53e66d1d665c9d269dd7697a53",
  );
  assert.equal(
    crypto.createHash("sha256").update(mine).digest("hex"),
    "a5b7db431ff47ecff512e276ce49deecf035ab4d43e71475985aadf8306b4f43",
  );
});

test("launch config decoder handles signed int24 and rejects malformed booleans", () => {
  const word = (value) => value.toString(16).padStart(64, "0");
  const signedWord = (value) =>
    word(value < 0n ? (1n << 256n) + value : value);
  const fields = [
    word(1_000_000_000n * 10n ** 18n),
    signedWord(-60n),
    signedWord(12345n),
    word(7000n),
    word(10_000n),
    word(50_000n),
    word(120n),
    word(1n),
    word(0n),
  ];
  const decoded = abi.decodeLaunchConfig(`0x${fields.join("")}`);
  assert.equal(decoded.tickSpacing, -60);
  assert.equal(decoded.startTick, 12345);
  assert.equal(decoded.enabled, true);
  assert.equal(decoded.selfBurn, false);

  fields[7] = word(2n);
  assert.throws(
    () => abi.decodeLaunchConfig(`0x${fields.join("")}`),
    /invalid bool word/,
  );
});

test("launch receipt is bound to hash, factory, creator, event, and prediction", async () => {
  const factory = "0x2222222222222222222222222222222222222222";
  const creator = "0x3333333333333333333333333333333333333333";
  const token = "0x44444444444444444444444444444444444444cc";
  const hash = `0x${"ab".repeat(32)}`;
  const poolId = `0x${"cd".repeat(32)}`;
  const topicAddress = (address) => `0x${address.slice(2).padStart(64, "0")}`;
  const receipt = {
    transactionHash: hash,
    blockHash: `0x${"ef".repeat(32)}`,
    blockNumber: "0x1",
    status: "0x1",
    to: factory,
    from: creator,
    logs: [
      {
        address: factory,
        data: "0x",
        topics: [
          launchClient.TOKEN_LAUNCHED_TOPIC,
          topicAddress(token),
          topicAddress(creator),
          poolId,
        ],
      },
    ],
  };
  const provider = { request: async () => receipt };
  const client = new launchClient.LaypipeLaunchClient(provider, factory);
  const confirmed = await client.confirmLaunch(hash, {
    creator,
    predictedToken: token,
  });
  assert.equal(confirmed.token.toLowerCase(), token.toLowerCase());
  assert.equal(confirmed.poolId, poolId);

  await assert.rejects(
    client.confirmLaunch(hash, {
      creator,
      predictedToken: "0x55555555555555555555555555555555555555cc",
    }),
    /does not match the mined prediction/,
  );
  await assert.rejects(
    client.waitForReceipt(`0x${"aa".repeat(32)}`),
    /different transaction/,
  );
});

test("receipt polling times out and cancels without leaking abort listeners", async () => {
  const provider = { request: async () => null };
  const client = new launchClient.LaypipeLaunchClient(
    provider,
    "0x2222222222222222222222222222222222222222",
  );
  const hash = `0x${"ab".repeat(32)}`;
  await assert.rejects(
    client.waitForReceipt(hash, { timeoutMs: 4, pollIntervalMs: 1 }),
    /still pending/,
  );

  const controller = new AbortController();
  let activeListeners = 0;
  const signal = controller.signal;
  const add = signal.addEventListener.bind(signal);
  const remove = signal.removeEventListener.bind(signal);
  signal.addEventListener = (...args) => {
    activeListeners += 1;
    return add(...args);
  };
  signal.removeEventListener = (...args) => {
    activeListeners -= 1;
    return remove(...args);
  };
  const cancelled = launchClient.abortableDelay(50, signal);
  setTimeout(() => controller.abort(), 1);
  await assert.rejects(cancelled, /cancelled/);
  assert.equal(activeListeners, 0);
});

test("wallet-context subscription invalidates on both account and chain drift", () => {
  const listeners = new Map();
  const provider = {
    request: async () => null,
    on(event, listener) {
      listeners.set(event, listener);
    },
    removeListener(event, listener) {
      if (listeners.get(event) === listener) listeners.delete(event);
    },
  };
  let invalidations = 0;
  const unsubscribe = launchClient.subscribeToWalletContext(
    provider,
    () => invalidations++,
  );
  listeners.get("accountsChanged")();
  listeners.get("chainChanged")();
  assert.equal(invalidations, 2);
  unsubscribe();
  assert.equal(listeners.size, 0);
});

test("launch state machine exposes approval and receipt phases", () => {
  let state = launchMachine.INITIAL_LAUNCH_STATE;
  state = launchMachine.reduceLaunchMachine(state, { type: "REVIEW" });
  state = launchMachine.reduceLaunchMachine(state, { type: "CONNECT" });
  state = launchMachine.reduceLaunchMachine(state, { type: "CONNECTED" });
  state = launchMachine.reduceLaunchMachine(state, { type: "PREPARE" });
  state = launchMachine.reduceLaunchMachine(state, {
    type: "PREPARED",
    needsApproval: true,
  });
  assert.equal(state.phase, "approval-required");
  state = launchMachine.reduceLaunchMachine(state, { type: "APPROVAL_SUBMITTED" });
  assert.equal(state.phase, "approval-pending");
  state = launchMachine.reduceLaunchMachine(state, {
    type: "APPROVAL_CONFIRMED",
    needsAnotherApproval: false,
  });
  assert.equal(state.phase, "ready-to-launch");
  state = launchMachine.reduceLaunchMachine(state, { type: "LAUNCH_SUBMITTED" });
  assert.equal(state.phase, "launch-pending");
});
