import assert from "node:assert/strict";
import crypto from "node:crypto";
import { File } from "node:buffer";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { tsImport } from "tsx/esm/api";

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
const pinClient = await tsImport("../lib/ipfs/pin-client.ts", import.meta.url);
const challengeMessage = await tsImport(
  "../lib/ipfs/challenge-message.ts",
  import.meta.url,
);
const abi = loadTypeScript("lib/web3/abi.ts");
const launchClient = loadTypeScript("lib/web3/launch-client.ts");
const launchMachine = loadTypeScript("lib/web3/launch-machine.ts");
const web3Types = loadTypeScript("lib/web3/types.ts");
const pinnedCache = loadTypeScript("app/launch/pinned-cache.ts");
const walletOperation = loadTypeScript("app/launch/wallet-operation.ts");

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

test("pinned launch assets are reusable only by the authorizing wallet", () => {
  const walletA = `0x${"a".repeat(40)}`;
  const walletAChecksummed = `0x${"A".repeat(40)}`;
  const walletB = `0x${"b".repeat(40)}`;
  const assets = Object.freeze({ marker: "wallet-a-pins" });
  const cache = pinnedCache.createWalletBoundPinnedCache({
    wallet: walletAChecksummed,
    fingerprint: "same-draft",
    assets,
  });

  assert.equal(cache.wallet, walletA);
  assert.equal(
    pinnedCache.readWalletBoundPinnedAssets(cache, walletA, "same-draft"),
    assets,
  );
  assert.equal(
    pinnedCache.readWalletBoundPinnedAssets(
      cache,
      walletAChecksummed,
      "same-draft",
    ),
    assets,
  );
  assert.equal(
    pinnedCache.readWalletBoundPinnedAssets(cache, walletB, "same-draft"),
    null,
  );
  assert.equal(
    pinnedCache.readWalletBoundPinnedAssets(cache, walletA, "changed-draft"),
    null,
  );
  assert.equal(pinnedCache.retainPinnedCacheForWallet(cache, walletA), cache);
  assert.equal(pinnedCache.retainPinnedCacheForWallet(cache, walletB), null);
  assert.equal(pinnedCache.retainPinnedCacheForWallet(cache, null), null);
});

test("A-to-B wallet drift cancels a delayed prepare and cannot authorize B; the same wallet can commit", async () => {
  const walletA = `0x${"a".repeat(40)}`;
  const walletB = `0x${"b".repeat(40)}`;
  const selected = {
    account: walletA,
    chainId: "0x1237",
  };
  const provider = {
    async request({ method }) {
      if (method === "eth_chainId") return selected.chainId;
      if (method === "eth_accounts") return [selected.account];
      throw new Error(`Unexpected wallet method ${method}`);
    },
  };
  const guard = new walletOperation.LaunchPrepareOperationGuard();
  let current = { provider, account: walletA, revision: 1 };
  let releasePreparation;
  const preparationGate = new Promise((resolveGate) => {
    releasePreparation = resolveGate;
  });
  let prepared = null;
  const approvalCalls = [];

  async function delayedPrepare() {
    const operation = guard.begin({
      provider,
      account: walletA,
      walletRevision: current.revision,
    });
    try {
      await preparationGate;
      guard.assertCurrent(operation, current);
      await walletOperation.assertExactLaunchWalletContext(provider, walletA);
      guard.assertCurrent(operation, current);
      prepared = { creator: walletA };
    } finally {
      guard.finish(operation);
    }
  }

  const stalePreparation = delayedPrepare();
  selected.account = walletB;
  current = { provider, account: walletB, revision: 2 };
  guard.invalidate();
  releasePreparation();
  await assert.rejects(
    stalePreparation,
    (error) => walletOperation.isStaleLaunchWalletOperation(error),
  );
  assert.equal(prepared, null);

  function approve(candidate, account) {
    walletOperation.assertPreparedLaunchCreator(candidate.creator, account);
    approvalCalls.push(account);
  }
  assert.throws(
    () => approve({ creator: walletA }, walletB),
    (error) => walletOperation.isStaleLaunchWalletOperation(error),
  );
  assert.deepEqual(approvalCalls, []);

  selected.account = walletA;
  current = { provider, account: walletA, revision: 3 };
  const sameWalletOperation = guard.begin({
    provider,
    account: walletA,
    walletRevision: current.revision,
  });
  await walletOperation.assertExactLaunchWalletContext(provider, walletA);
  guard.assertCurrent(sameWalletOperation, current);
  prepared = { creator: walletA };
  guard.finish(sameWalletOperation);
  approve(prepared, walletA);
  assert.deepEqual(approvalCalls, [walletA]);
});

test("launch form invalidates wallet drift before deciding whether to repin", () => {
  const source = readFileSync(
    resolve(repositoryRoot, "app/launch/LaunchForm.tsx"),
    "utf8",
  );

  assert.match(
    source,
    /setPinnedCache\(\(cache\) => retainPinnedCacheForWallet\(cache, account\)\)/,
  );
  assert.match(
    source,
    /readWalletBoundPinnedAssets\(\s*pinnedCache,\s*account,\s*fingerprint,\s*\)/,
  );
  assert.match(
    source,
    /createWalletBoundPinnedCache\(\{\s*wallet: account,\s*fingerprint,\s*assets,\s*\}\)/,
  );
  assert.match(source, /signal: operation\.signal/);
  assert.match(source, /assertExactCurrentOperation/);
  assert.match(source, /assertPreparedLaunchCreator\(prepared\.params\.creator, account\)/);
});

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

test("pinning uses signed same-origin staging and fails closed on drift", async () => {
  const file = pngFile();
  const wallet = "0x1111111111111111111111111111111111111111";
  const changedWallet = "0x2222222222222222222222222222222222222222";
  const draft = metadata.normalizeMetadataDraft({
    name: "Pinned Pipe",
    symbol: "PIN",
    description: "Pinned twice.",
    feeMode: "creator",
  });
  const stagedCid =
    "bafkreicnu2aqjkoglrlrd65giwo4l64pdajxffk6jtq2vb7yaiopc3yu7m";
  const imageCid =
    "bafkreig6cmq5xgc3ed4qknhtupzyqvkt3qquhyxphgxdxd3hkpdvweezly";
  const metadataCid =
    "bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku";
  const stagedFileId = "e5323ea7-8a02-4486-9b6f-63c788810aeb";
  const imageUri = `ipfs://${imageCid}`;
  const expectedDocument = metadata.buildTokenMetadata(draft, imageUri);
  const fileSha256 = await artwork.artworkContentHash(file);
  const stageDigest = await pinClient.stageAuthorizationDigest({
    wallet,
    fileName: "coin.png",
    mimeType: "image/png",
    size: file.size,
    fileSha256,
  });
  const pinDigest = await pinClient.pinAuthorizationDigest({
    wallet,
    stagedCid,
    stagedFileId,
    fileSha256,
    metadata: draft,
  });

  function flow(options = {}) {
    let expectedMessage = "";
    let accountChecks = 0;
    let signatures = 0;
    let finalCalls = 0;
    const internalUrls = [];
    const issuedChallenges = {};
    const provider = {
      async request({ method, params }) {
        if (method === "eth_accounts") {
          accountChecks += 1;
          return accountChecks === options.driftAtCheck ? [changedWallet] : [wallet];
        }
        if (method === "personal_sign") {
          signatures += 1;
          assert.equal(Buffer.from(params[0].slice(2), "hex").toString("utf8"), expectedMessage);
          assert.equal(params[1], wallet);
          return `0x${"ab".repeat(65)}`;
        }
        throw new Error(`Unexpected wallet call: ${method}`);
      },
    };
    const fetcher = async (url, init) => {
      const urlString = String(url);
      if (urlString.startsWith("https://laypipe.fun/")) internalUrls.push(urlString);
      if (urlString === "https://laypipe.fun/api/auth/challenge") {
        const body = JSON.parse(init.body);
        assert.equal(
          body.contentDigest,
          body.action === "stage" ? stageDigest : pinDigest,
        );
        const issuedAt = Math.floor(Date.now() / 1000);
        const challengePayload = {
          v: challengeMessage.WALLET_CHALLENGE_VERSION,
          wallet: wallet.toLowerCase(),
          action: body.action,
          digest: body.contentDigest,
          nonce: `${body.action}_nonce_for_exact_artwork`,
          issuedAt,
          expiresAt: issuedAt + challengeMessage.WALLET_CHALLENGE_TTL_SECONDS,
        };
        const encoded = Buffer.from(JSON.stringify(challengePayload)).toString("base64url");
        issuedChallenges[body.action] = `${encoded}.${Buffer.alloc(32, 7).toString("base64url")}`;
        expectedMessage = challengeMessage.buildChallengeMessage(challengePayload);
        return Response.json(
          {
            challenge: issuedChallenges[body.action],
            message: options.challengeMessageDrift
              ? `${expectedMessage}\nAuthorize an unrelated login.`
              : expectedMessage,
            expiresAt: new Date(challengePayload.expiresAt * 1000).toISOString(),
          },
          { status: 201 },
        );
      }
      if (urlString === "https://laypipe.fun/api/ipfs/stage") {
        const body = JSON.parse(init.body);
        assert.equal(body.wallet, wallet);
        assert.equal(body.fileSha256, fileSha256);
        assert.equal(body.challenge, issuedChallenges.stage);
        assert.match(body.signature, /^0x[0-9a-f]{130}$/);
        return Response.json(
          {
            uploadUrl: "https://uploads.pinata.cloud/v3/files?signature=safe",
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          },
          { status: 201 },
        );
      }
      if (urlString.startsWith("https://uploads.pinata.cloud/v3/files?")) {
        assert.equal(init.body.get("network"), "public");
        assert.equal(init.body.get("file").name, "coin.png");
        return Response.json({
          data: {
            id: stagedFileId,
            cid: options.stagedCid ?? stagedCid,
          },
        });
      }
      if (urlString === "https://laypipe.fun/api/ipfs/pin") {
        finalCalls += 1;
        const body = JSON.parse(init.body);
        assert.equal(body.stagedCid, stagedCid);
        assert.equal(body.stagedFileId, stagedFileId);
        assert.equal(body.challenge, issuedChallenges.pin);
        assert.deepEqual(body.metadata, draft);
        return Response.json(
          {
            image: {
              cid: imageCid,
              uri: imageUri,
              gatewayUrl:
                options.gatewayUrl ??
                `https://laypipe.mypinata.cloud/ipfs/${imageCid}`,
            },
            metadata: {
              cid: metadataCid,
              uri: `ipfs://${metadataCid}`,
              gatewayUrl: `https://laypipe.mypinata.cloud/ipfs/${metadataCid}`,
            },
            metadataDocument: options.metadataDocument ?? expectedDocument,
          },
          { status: 201 },
        );
      }
      throw new Error(`Unexpected network call: ${urlString}`);
    };
    return {
      provider,
      fetcher,
      observations: () => ({ accountChecks, signatures, finalCalls, internalUrls }),
    };
  }

  const success = flow();
  const pinned = await pinClient.pinLaunchAssets({
    file,
    metadata: draft,
    wallet,
    provider: success.provider,
    browserOrigin: "https://laypipe.fun",
    fetcher: success.fetcher,
  });
  assert.deepEqual(pinned.metadataDocument, expectedDocument);
  assert.deepEqual(success.observations(), {
    accountChecks: 3,
    signatures: 2,
    finalCalls: 1,
    internalUrls: [
      "https://laypipe.fun/api/auth/challenge",
      "https://laypipe.fun/api/ipfs/stage",
      "https://laypipe.fun/api/auth/challenge",
      "https://laypipe.fun/api/ipfs/pin",
    ],
  });

  const substituted = flow({
    metadataDocument: { ...expectedDocument, symbol: "SWAPPED" },
  });
  await assert.rejects(
    pinClient.pinLaunchAssets({
      file,
      metadata: draft,
      wallet,
      provider: substituted.provider,
      browserOrigin: "https://laypipe.fun",
      fetcher: substituted.fetcher,
    }),
    /does not match/,
  );

  const badCid = flow({ stagedCid: "not-a-real-cid" });
  await assert.rejects(
    pinClient.pinLaunchAssets({
      file,
      metadata: draft,
      wallet,
      provider: badCid.provider,
      browserOrigin: "https://laypipe.fun",
      fetcher: badCid.fetcher,
    }),
    /invalid CID/,
  );

  const drifted = flow({ driftAtCheck: 3 });
  await assert.rejects(
    pinClient.pinLaunchAssets({
      file,
      metadata: draft,
      wallet,
      provider: drifted.provider,
      browserOrigin: "https://laypipe.fun",
      fetcher: drifted.fetcher,
    }),
    /wallet changed/,
  );
  assert.equal(drifted.observations().finalCalls, 0);

  const messageDrift = flow({ challengeMessageDrift: true });
  await assert.rejects(
    pinClient.pinLaunchAssets({
      file,
      metadata: draft,
      wallet,
      provider: messageDrift.provider,
      browserOrigin: "https://laypipe.fun",
      fetcher: messageDrift.fetcher,
    }),
    /invalid challenge/,
  );
  assert.equal(messageDrift.observations().signatures, 0);
  assert.equal(messageDrift.observations().finalCalls, 0);

  const wrongGateway = flow({
    gatewayUrl: `https://attacker.example/ipfs/${imageCid}`,
  });
  await assert.rejects(
    pinClient.pinLaunchAssets({
      file,
      metadata: draft,
      wallet,
      provider: wrongGateway.provider,
      browserOrigin: "https://laypipe.fun",
      fetcher: wrongGateway.fetcher,
    }),
    /configured Pinata HTTPS CID path/,
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
    launchConfigCount: "ae72d871",
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

test("wallet receipt polling remains bound to hash, factory, and creator", async () => {
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
  const confirmed = await client.waitForReceipt(hash, {
    expectedFrom: creator,
    expectedTo: factory,
  });
  assert.equal(confirmed.transactionHash, hash);
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
