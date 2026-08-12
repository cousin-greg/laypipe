import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import sharp from "sharp";
import { privateKeyToAccount } from "viem/accounts";
import { tsImport } from "tsx/esm/api";

const challengeModule = await tsImport(
  "../lib/server/auth/challenge.ts",
  import.meta.url,
);
const redisModule = await tsImport("../lib/server/auth/redis.ts", import.meta.url);
const httpModule = await tsImport("../lib/server/auth/http.ts", import.meta.url);
const digestModule = await tsImport(
  "../lib/server/auth/request-digest.ts",
  import.meta.url,
);
const pinataModule = await tsImport(
  "../lib/server/ipfs/pinata.ts",
  import.meta.url,
);
const imageModule = await tsImport("../lib/server/ipfs/image.ts", import.meta.url);
const metadataModule = await tsImport(
  "../lib/server/ipfs/metadata.ts",
  import.meta.url,
);
const clientMetadata = await tsImport("../lib/ipfs/metadata.ts", import.meta.url);
const pinClient = await tsImport("../lib/ipfs/pin-client.ts", import.meta.url);
const stageRoute = await tsImport("../app/api/ipfs/stage/route.ts", import.meta.url);
const pinRoute = await tsImport("../app/api/ipfs/pin/route.ts", import.meta.url);
const cleanupRoute = await tsImport(
  "../app/api/ipfs/cleanup/route.ts",
  import.meta.url,
);

const account = privateKeyToAccount(
  "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
);
const stagedCid =
  "bafkreicnu2aqjkoglrlrd65giwo4l64pdajxffk6jtq2vb7yaiopc3yu7m";
const imageCid =
  "bafkreig6cmq5xgc3ed4qknhtupzyqvkt3qquhyxphgxdxd3hkpdvweezly";
const metadataCid =
  "bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku";
const stagedFileId = "e5323ea7-8a02-4486-9b6f-63c788810aeb";

function configureEnvironment() {
  process.env.WALLET_CHALLENGE_SECRET = "test-secret-that-is-at-least-32-bytes-long";
  process.env.PINATA_JWT = "test-pinata-jwt-never-sent-to-browser";
  process.env.IPFS_PINNING_ENABLED = "true";
  process.env.IPFS_GATEWAY_BASE_URL = "https://laypipe-test.mypinata.cloud/ipfs";
  process.env.NEXT_PUBLIC_SITE_URL = "https://laypipe.fun";
  process.env.UPSTASH_REDIS_REST_KV_REST_API_URL = "https://laypipe-test.upstash.io";
  process.env.UPSTASH_REDIS_REST_KV_REST_API_TOKEN = "test-upstash-token";
  process.env.CRON_SECRET = "test-cron-secret-that-is-at-least-32-bytes";
}

test("origin guard accepts the active Vercel Preview and canonical site only", () => {
  configureEnvironment();
  assert.doesNotThrow(() =>
    httpModule.sameOriginRequest(
      new Request("https://laypipe-git-demo.vercel.app/api/ipfs/stage", {
        headers: { Origin: "https://laypipe-git-demo.vercel.app" },
      }),
    ),
  );
  assert.doesNotThrow(() =>
    httpModule.sameOriginRequest(
      new Request("https://laypipe-git-demo.vercel.app/api/ipfs/stage", {
        headers: { Origin: "https://laypipe.fun" },
      }),
    ),
  );
  assert.throws(
    () =>
      httpModule.sameOriginRequest(
        new Request("https://laypipe-git-demo.vercel.app/api/ipfs/stage", {
          headers: { Origin: "https://attacker.example" },
        }),
      ),
    /Cross-origin/,
  );
});

function apiRequest(path, body) {
  return new Request(`https://laypipe.fun${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "https://laypipe.fun",
      "X-Forwarded-For": "203.0.113.9",
    },
    body: JSON.stringify(body),
  });
}

async function authorize(action, contentDigest) {
  const issued = challengeModule.issueWalletChallenge({
    wallet: account.address,
    action,
    contentDigest,
    now: Math.floor(Date.now() / 1000),
  });
  return {
    ...issued,
    signature: await account.signMessage({ message: issued.message }),
  };
}

test("HMAC challenge is EIP-191 verifiable, bound, expiring, and tamper-evident", async () => {
  configureEnvironment();
  const digest = "11".repeat(32);
  const issued = challengeModule.issueWalletChallenge({
    wallet: account.address,
    action: "stage",
    contentDigest: digest,
    now: 1_800_000_000,
  });
  const signature = await account.signMessage({ message: issued.message });
  const verified = await challengeModule.verifyWalletAuthorization({
    challenge: issued.challenge,
    signature,
    wallet: account.address,
    action: "stage",
    contentDigest: digest,
    now: 1_800_000_001,
  });
  assert.equal(verified.wallet, account.address.toLowerCase());
  assert.equal(verified.action, "stage");
  await assert.rejects(
    challengeModule.verifyWalletAuthorization({
      challenge: `${issued.challenge.slice(0, -1)}x`,
      signature,
      wallet: account.address,
      action: "stage",
      contentDigest: digest,
      now: 1_800_000_001,
    }),
    /Challenge is invalid/,
  );
  await assert.rejects(
    challengeModule.verifyWalletAuthorization({
      challenge: issued.challenge,
      signature,
      wallet: account.address,
      action: "stage",
      contentDigest: "22".repeat(32),
      now: 1_800_000_001,
    }),
    /does not match/,
  );
  assert.throws(
    () => challengeModule.decodeWalletChallenge(issued.challenge, 1_800_000_301),
    /expired/,
  );
});

test("Upstash adapter uses provisioned names and consumes a nonce only once", async () => {
  configureEnvironment();
  const calls = [];
  let used = false;
  const fetcher = async (url, init) => {
    calls.push({ url, init });
    const command = JSON.parse(init.body);
    if (command[0] === "SET") {
      if (used) return Response.json({ result: null });
      used = true;
      return Response.json({ result: "OK" });
    }
    return Response.json({ result: [1, 1] });
  };
  await redisModule.enforceRateLimit({
    namespace: "test",
    identity: account.address,
    limit: 2,
    windowSeconds: 60,
    fetcher,
  });
  await redisModule.consumeNonce({
    nonce: "nonce-one",
    expiresAt: Math.floor(Date.now() / 1000) + 60,
    fetcher,
  });
  await assert.rejects(
    redisModule.consumeNonce({
      nonce: "nonce-one",
      expiresAt: Math.floor(Date.now() / 1000) + 60,
      fetcher,
    }),
    /already used/,
  );
  assert.ok(calls.every((call) => call.url === "https://laypipe-test.upstash.io"));
  assert.ok(
    calls.every(
      (call) => call.init.headers.Authorization === "Bearer test-upstash-token",
    ),
  );
});

test("Upstash protection fails closed in production when configuration is missing", async () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const saved = {
    customUrl: process.env.UPSTASH_REDIS_REST_KV_REST_API_URL,
    customToken: process.env.UPSTASH_REDIS_REST_KV_REST_API_TOKEN,
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
  };
  process.env.NODE_ENV = "production";
  delete process.env.UPSTASH_REDIS_REST_KV_REST_API_URL;
  delete process.env.UPSTASH_REDIS_REST_KV_REST_API_TOKEN;
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  try {
    await assert.rejects(
      redisModule.enforceRateLimit({
        namespace: "production-test",
        identity: account.address,
        limit: 1,
        windowSeconds: 60,
      }),
      /unavailable/,
    );
  } finally {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    for (const [name, value] of [
      ["UPSTASH_REDIS_REST_KV_REST_API_URL", saved.customUrl],
      ["UPSTASH_REDIS_REST_KV_REST_API_TOKEN", saved.customToken],
      ["UPSTASH_REDIS_REST_URL", saved.url],
      ["UPSTASH_REDIS_REST_TOKEN", saved.token],
    ]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("Upstash adapter never sends its token to a non-Upstash or insecure URL", async () => {
  configureEnvironment();
  let networkCalls = 0;
  for (const invalidUrl of [
    "http://laypipe-test.upstash.io",
    "https://attacker.example",
    "https://laypipe-test.upstash.io/evil",
  ]) {
    process.env.UPSTASH_REDIS_REST_KV_REST_API_URL = invalidUrl;
    await assert.rejects(
      redisModule.enforceRateLimit({
        namespace: "invalid-url",
        identity: account.address,
        limit: 1,
        windowSeconds: 60,
        fetcher: async () => {
          networkCalls += 1;
          return Response.json({ result: [1, 1] });
        },
      }),
      /unavailable/,
    );
  }
  assert.equal(networkCalls, 0);
});

test("browser and server authorization digests are byte-for-byte identical", async () => {
  configureEnvironment();
  const draft = clientMetadata.normalizeMetadataDraft({
    name: "Digest Pipe",
    symbol: "DIG",
    description: "One canonical digest on both sides.",
    feeMode: "creator",
  });
  const stage = {
    wallet: account.address,
    fileName: "coin-name.png",
    mimeType: "image/png",
    size: 12345,
    fileSha256: "a1".repeat(32),
  };
  const pin = {
    wallet: account.address,
    stagedCid,
    stagedFileId,
    fileSha256: stage.fileSha256,
    metadata: draft,
  };
  assert.equal(
    await pinClient.stageAuthorizationDigest(stage),
    digestModule.stageAuthorizationDigest(stage),
  );
  assert.equal(
    await pinClient.pinAuthorizationDigest(pin),
    digestModule.pinAuthorizationDigest(pin),
  );
});

test("Pinata staging request enforces exact 5 MB/MIME restrictions without exposing JWT", async () => {
  configureEnvironment();
  let observed;
  const result = await pinataModule.createPresignedStageUrl({
    fileName: "coin.png",
    mimeType: "image/png",
    wallet: account.address,
    digest: "33".repeat(32),
    fileSha256: "44".repeat(32),
    fetcher: async (url, init) => {
      observed = { url, init, body: JSON.parse(init.body) };
      return Response.json({
        data: "https://uploads.pinata.cloud/v3/files?X-Signature=safe",
      });
    },
  });
  assert.equal(observed.url, "https://uploads.pinata.cloud/v3/files/sign");
  assert.equal(observed.body.max_file_size, 5 * 1024 * 1024);
  assert.deepEqual(observed.body.allow_mime_types, ["image/png"]);
  assert.equal(observed.body.network, "public");
  assert.equal("cid_version" in observed.body, false);
  assert.equal(observed.body.keyvalues.file_sha256, "44".repeat(32));
  assert.equal(observed.init.headers.Authorization, "Bearer test-pinata-jwt-never-sent-to-browser");
  assert.equal(JSON.stringify(result).includes("test-pinata-jwt"), false);
});

test("IPFS kill switch blocks staging even when a Pinata JWT exists", async () => {
  configureEnvironment();
  for (const value of ["false", undefined]) {
    if (value === undefined) delete process.env.IPFS_PINNING_ENABLED;
    else process.env.IPFS_PINNING_ENABLED = value;
    const response = await stageRoute.POST(apiRequest("/api/ipfs/stage", {}));
    assert.equal(response.status, 503);
    assert.equal((await response.json()).code, "IPFS_DISABLED");
  }
});

test("gateway configuration is HTTPS, Pinata-hosted, and production fail-closed", () => {
  configureEnvironment();
  assert.equal(
    pinataModule.gatewayUrl(stagedCid),
    `https://laypipe-test.mypinata.cloud/ipfs/${stagedCid}`,
  );
  for (const invalid of [
    "http://laypipe-test.mypinata.cloud",
    "https://attacker.example/ipfs",
    "https://laypipe-test.mypinata.cloud/not-ipfs",
    "https://user:pass@laypipe-test.mypinata.cloud/ipfs",
  ]) {
    process.env.IPFS_GATEWAY_BASE_URL = invalid;
    assert.throws(() => pinataModule.gatewayUrl(stagedCid), /unavailable/);
  }
  const originalNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  delete process.env.IPFS_GATEWAY_BASE_URL;
  assert.throws(() => pinataModule.gatewayUrl(stagedCid), /unavailable/);
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;
});

test("gateway retrieval enforces its byte cap even without Content-Length", async () => {
  configureEnvironment();
  await assert.rejects(
    pinataModule.fetchPublicCid(stagedCid, {
      maxBytes: 4,
      fetcher: async (url) => {
        assert.equal(
          url,
          `https://laypipe-test.mypinata.cloud/ipfs/${stagedCid}`,
        );
        return new Response(new Uint8Array([1, 2, 3, 4, 5]));
      },
    }),
    /5 MB or smaller/,
  );
});

test("image sanitizer rejects SVG/mismatches and deterministically strips to one WebP", async () => {
  const png = await sharp({
    create: { width: 256, height: 256, channels: 4, background: "#22c55e" },
  })
    .png()
    .withMetadata({ comment: "must be removed" })
    .toBuffer();
  const hash = createHash("sha256").update(png).digest("hex");
  const first = await imageModule.sanitizeArtwork({
    bytes: png,
    declaredMimeType: "image/png",
    expectedSha256: hash,
  });
  const second = await imageModule.sanitizeArtwork({
    bytes: png,
    declaredMimeType: "image/png",
    expectedSha256: hash,
  });
  assert.equal(first.mimeType, "image/webp");
  assert.deepEqual(first.bytes, second.bytes);
  const info = await sharp(first.bytes).metadata();
  assert.equal(info.format, "webp");
  assert.equal(info.width, 256);
  assert.equal(info.height, 256);
  assert.equal(info.exif, undefined);
  await assert.rejects(
    imageModule.sanitizeArtwork({
      bytes: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'),
      declaredMimeType: "image/png",
      expectedSha256: "00".repeat(32),
    }),
    /does not match/,
  );
  await assert.rejects(
    imageModule.sanitizeArtwork({
      bytes: png,
      declaredMimeType: "image/webp",
      expectedSha256: hash,
    }),
    /does not match/,
  );
});

test("stage route verifies signature, consumes nonce, and returns only a presigned URL", async () => {
  configureEnvironment();
  const originalFetch = globalThis.fetch;
  const details = {
    wallet: account.address,
    fileName: "coin.png",
    mimeType: "image/png",
    size: 1234,
    fileSha256: "55".repeat(32),
  };
  const digest = digestModule.stageAuthorizationDigest(details);
  const auth = await authorize("stage", digest);
  globalThis.fetch = async (url, init) => {
    if (url === "https://laypipe-test.upstash.io") {
      const command = JSON.parse(init.body);
      return Response.json({ result: command[0] === "SET" ? "OK" : [1, 1] });
    }
    if (url === "https://uploads.pinata.cloud/v3/files/sign") {
      return Response.json({
        data: "https://uploads.pinata.cloud/v3/files?X-Signature=safe",
      });
    }
    throw new Error(`Unexpected network call: ${url}`);
  };
  try {
    const response = await stageRoute.POST(
      apiRequest("/api/ipfs/stage", {
        ...details,
        challenge: auth.challenge,
        signature: auth.signature,
      }),
    );
    assert.equal(response.status, 201);
    const payload = await response.json();
    assert.deepEqual(Object.keys(payload).sort(), ["expiresAt", "uploadUrl"]);
    assert.equal(payload.uploadUrl.startsWith("https://uploads.pinata.cloud/"), true);
    assert.equal(JSON.stringify(payload).includes(process.env.PINATA_JWT), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("pin route validates staged bytes and returns exactly the dual-CID response", async () => {
  configureEnvironment();
  const originalFetch = globalThis.fetch;
  const png = await sharp({
    create: { width: 256, height: 256, channels: 4, background: "#f5c542" },
  })
    .png()
    .toBuffer();
  const fileSha256 = createHash("sha256").update(png).digest("hex");
  const draft = clientMetadata.normalizeMetadataDraft({
    name: "Backend Pipe",
    symbol: "BACK",
    description: "Server verified artwork.",
    feeMode: "self-burn",
    website: "https://laypipe.fun/",
  });
  const pinDigest = digestModule.pinAuthorizationDigest({
    wallet: account.address,
    stagedCid,
    stagedFileId,
    fileSha256,
    metadata: draft,
  });
  const stageDigest = digestModule.stageAuthorizationDigest({
    wallet: account.address,
    fileName: "coin.png",
    mimeType: "image/png",
    size: png.length,
    fileSha256,
  });
  const auth = await authorize("pin", pinDigest);
  const uploads = [];
  const deletes = [];
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...values) => warnings.push(values);
  globalThis.fetch = async (url, init = {}) => {
    const urlString = String(url);
    if (urlString === "https://laypipe-test.upstash.io") {
      const command = JSON.parse(init.body);
      return Response.json({ result: command[0] === "SET" ? "OK" : [1, 1] });
    }
    if (urlString.endsWith(`/v3/files/public/${stagedFileId}`) && init.method !== "DELETE") {
      return Response.json({
        data: {
          id: stagedFileId,
          name: "coin.png",
          cid: stagedCid,
          size: png.length,
          mime_type: "image/png",
          keyvalues: {
            laypipe_stage: "true",
            wallet: account.address.toLowerCase(),
            digest: stageDigest,
            file_sha256: fileSha256,
          },
        },
      });
    }
    if (urlString === `https://laypipe-test.mypinata.cloud/ipfs/${stagedCid}`) {
      return new Response(png, {
        headers: { "Content-Type": "image/png", "Content-Length": String(png.length) },
      });
    }
    if (urlString === "https://uploads.pinata.cloud/v3/files") {
      const file = init.body.get("file");
      uploads.push({ name: file.name, type: file.type, bytes: Buffer.from(await file.arrayBuffer()) });
      const isMetadata = file.type === "application/json";
      return Response.json({
        data: {
          id: isMetadata
            ? "99999999-9999-4999-8999-999999999999"
            : "88888888-8888-4888-8888-888888888888",
          cid: isMetadata ? metadataCid : imageCid,
          size: file.size,
          mime_type: file.type,
        },
      });
    }
    if (init.method === "DELETE") {
      deletes.push(urlString);
      return Response.json({ error: "forced cleanup failure" }, { status: 500 });
    }
    throw new Error(`Unexpected network call: ${urlString}`);
  };
  try {
    const response = await pinRoute.POST(
      apiRequest("/api/ipfs/pin", {
        wallet: account.address,
        stagedCid,
        stagedFileId,
        fileSha256,
        metadata: draft,
        challenge: auth.challenge,
        signature: auth.signature,
      }),
    );
    assert.equal(response.status, 201);
    const payload = await response.json();
    assert.deepEqual(Object.keys(payload).sort(), ["image", "metadata", "metadataDocument"]);
    assert.equal(payload.image.cid, imageCid);
    assert.equal(payload.metadata.cid, metadataCid);
    assert.equal(payload.metadataDocument.image, `ipfs://${imageCid}`);
    assert.deepEqual(
      payload.metadataDocument,
      clientMetadata.buildTokenMetadata(draft, `ipfs://${imageCid}`),
    );
    assert.equal(uploads.length, 2);
    assert.equal(uploads[0].type, "image/webp");
    assert.equal(uploads[1].type, "application/json");
    assert.equal(deletes.some((url) => url.endsWith(stagedFileId)), true);
    assert.equal(warnings.length, 1);
    assert.equal(JSON.stringify(payload).includes(process.env.PINATA_JWT), false);
  } finally {
    console.warn = originalWarn;
    globalThis.fetch = originalFetch;
  }
});

test("metadata upload failure deletes sanitized image and staged file", async () => {
  configureEnvironment();
  const originalFetch = globalThis.fetch;
  const png = await sharp({
    create: { width: 256, height: 256, channels: 3, background: "#000" },
  })
    .png()
    .toBuffer();
  const fileSha256 = createHash("sha256").update(png).digest("hex");
  const draft = clientMetadata.normalizeMetadataDraft({
    name: "Cleanup Pipe",
    symbol: "CLEAN",
    description: "Cleanup regression.",
    feeMode: "creator",
  });
  const digest = digestModule.pinAuthorizationDigest({
    wallet: account.address,
    stagedCid,
    stagedFileId,
    fileSha256,
    metadata: draft,
  });
  const auth = await authorize("pin", digest);
  let uploadCount = 0;
  const deletes = [];
  globalThis.fetch = async (url, init = {}) => {
    const urlString = String(url);
    if (urlString === "https://laypipe-test.upstash.io") {
      const command = JSON.parse(init.body);
      return Response.json({ result: command[0] === "SET" ? "OK" : [1, 1] });
    }
    if (urlString.endsWith(`/v3/files/public/${stagedFileId}`) && init.method !== "DELETE") {
      return Response.json({
        data: {
          id: stagedFileId,
          name: "coin.png",
          cid: stagedCid,
          size: png.length,
          mime_type: "image/png",
          keyvalues: {
            laypipe_stage: "true",
            wallet: account.address.toLowerCase(),
            digest: "66".repeat(32),
            file_sha256: fileSha256,
          },
        },
      });
    }
    if (urlString === `https://laypipe-test.mypinata.cloud/ipfs/${stagedCid}`) {
      return new Response(png, { headers: { "Content-Type": "image/png" } });
    }
    if (urlString === "https://uploads.pinata.cloud/v3/files") {
      uploadCount += 1;
      if (uploadCount === 2) return Response.json({ error: "forced" }, { status: 500 });
      return Response.json({
        data: {
          id: "88888888-8888-4888-8888-888888888888",
          cid: imageCid,
          size: 100,
          mime_type: "image/webp",
        },
      });
    }
    if (init.method === "DELETE") {
      deletes.push(urlString);
      return Response.json({ data: null });
    }
    throw new Error(`Unexpected network call: ${urlString}`);
  };
  try {
    const response = await pinRoute.POST(
      apiRequest("/api/ipfs/pin", {
        wallet: account.address,
        stagedCid,
        stagedFileId,
        fileSha256,
        metadata: draft,
        challenge: auth.challenge,
        signature: auth.signature,
      }),
    );
    assert.equal(response.status, 502);
    assert.equal(
      deletes.some((url) => url.endsWith("88888888-8888-4888-8888-888888888888")),
      true,
    );
    assert.equal(deletes.some((url) => url.endsWith(stagedFileId)), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("server metadata parser requires the exact deterministic client draft", () => {
  const draft = clientMetadata.normalizeMetadataDraft({
    name: "Exact Pipe",
    symbol: "EXACT",
    description: "No metadata drift.",
    feeMode: "creator",
  });
  assert.deepEqual(metadataModule.parseMetadataDraft(draft), draft);
  assert.throws(
    () => metadataModule.parseMetadataDraft({ ...draft, injected: "bad" }),
    /canonical document/,
  );
});

test("cleanup route deletes only stale tagged stages with bounded Pinata queries", async () => {
  configureEnvironment();
  const originalFetch = globalThis.fetch;
  const deleted = [];
  const now = Date.parse("2026-08-11T12:00:00.000Z");
  const originalNow = Date.now;
  Date.now = () => now;
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === "/v3/files/public" && init.method !== "DELETE") {
      assert.equal(parsed.searchParams.get("keyvalues[laypipe_stage]"), "true");
      assert.equal(parsed.searchParams.get("limit"), "100");
      assert.equal(parsed.searchParams.get("order"), "ASC");
      return Response.json({
        data: {
          files: [
            {
              id: "11111111-1111-4111-8111-111111111111",
              created_at: "2026-08-11T10:00:00.000Z",
              keyvalues: {
                laypipe_stage: "true",
                wallet: account.address.toLowerCase(),
                digest: "11".repeat(32),
                file_sha256: "22".repeat(32),
              },
            },
            {
              id: "22222222-2222-4222-8222-222222222222",
              created_at: "2026-08-11T11:30:00.000Z",
              keyvalues: {
                laypipe_stage: "true",
                wallet: account.address.toLowerCase(),
                digest: "33".repeat(32),
                file_sha256: "44".repeat(32),
              },
            },
            {
              id: "33333333-3333-4333-8333-333333333333",
              created_at: "2026-08-11T09:00:00.000Z",
              keyvalues: {
                laypipe: "token-artwork",
                wallet: account.address.toLowerCase(),
                digest: "55".repeat(32),
                file_sha256: "66".repeat(32),
              },
            },
          ],
          next_page_token: "",
        },
      });
    }
    if (init.method === "DELETE") {
      deleted.push(parsed.pathname);
      return Response.json({ data: null });
    }
    throw new Error(`Unexpected network call: ${url}`);
  };
  try {
    const response = await cleanupRoute.GET(
      new Request("https://laypipe.fun/api/ipfs/cleanup", {
        headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` },
      }),
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      scanned: 3,
      stale: 1,
      deleted: 1,
      failed: 0,
      truncated: false,
    });
    assert.deepEqual(deleted, [
      "/v3/files/public/11111111-1111-4111-8111-111111111111",
    ]);
  } finally {
    Date.now = originalNow;
    globalThis.fetch = originalFetch;
  }
});

test("cleanup route rejects bad auth and malformed Pinata pages without deleting", async () => {
  configureEnvironment();
  let calls = 0;
  const unauthorized = await cleanupRoute.POST(
    new Request("https://laypipe.fun/api/ipfs/cleanup", {
      method: "POST",
      headers: { Authorization: "Bearer wrong" },
    }),
  );
  assert.equal(unauthorized.status, 401);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    calls += 1;
    return Response.json({
      data: {
        files: [{ id: "not-a-valid-file", created_at: "bad", keyvalues: null }],
      },
    });
  };
  try {
    const response = await cleanupRoute.GET(
      new Request("https://laypipe.fun/api/ipfs/cleanup", {
        headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` },
      }),
    );
    assert.equal(response.status, 502);
    assert.equal((await response.json()).code, "IPFS_LIST_RESPONSE");
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("stale-stage cleanup paginates with an opaque token and caps deletion at 100", async () => {
  configureEnvironment();
  const old = "2026-08-11T08:00:00.000Z";
  const files = Array.from({ length: 101 }, (_, index) => ({
    id: `${String(index + 1).padStart(8, "0")}-1111-4111-8111-${String(index + 1).padStart(12, "0")}`,
    created_at: old,
    keyvalues: {
      laypipe_stage: "true",
      wallet: account.address.toLowerCase(),
      digest: "77".repeat(32),
      file_sha256: "88".repeat(32),
    },
  }));
  const listUrls = [];
  let deletes = 0;
  const result = await pinataModule.sweepStaleStageFiles({
    now: Date.parse("2026-08-11T12:00:00.000Z"),
    fetcher: async (url, init = {}) => {
      const parsed = new URL(String(url));
      if (init.method === "DELETE") {
        deletes += 1;
        return Response.json({ data: null });
      }
      listUrls.push(parsed);
      if (!parsed.searchParams.has("pageToken")) {
        return Response.json({
          data: { files: files.slice(0, 100), next_page_token: "opaque_page_2" },
        });
      }
      assert.equal(parsed.searchParams.get("pageToken"), "opaque_page_2");
      return Response.json({ data: { files: files.slice(100) } });
    },
  });
  assert.equal(listUrls.length, 2);
  for (const url of listUrls) {
    assert.equal(url.pathname, "/v3/files/public");
    assert.equal(url.searchParams.get("keyvalues[laypipe_stage]"), "true");
  }
  assert.equal(deletes, 100);
  assert.deepEqual(result, {
    scanned: 101,
    stale: 100,
    deleted: 100,
    failed: 0,
    truncated: true,
  });
});
