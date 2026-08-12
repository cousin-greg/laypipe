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
const promotionModule = await tsImport(
  "../lib/server/ipfs/promotion.ts",
  import.meta.url,
);
const registryModule = await tsImport(
  "../lib/server/ipfs/registry.ts",
  import.meta.url,
);
const databaseModule = await tsImport(
  "../lib/server/db/neon.ts",
  import.meta.url,
);
const imageModule = await tsImport("../lib/server/ipfs/image.ts", import.meta.url);
const metadataModule = await tsImport(
  "../lib/server/ipfs/metadata.ts",
  import.meta.url,
);
const clientMetadata = await tsImport("../lib/ipfs/metadata.ts", import.meta.url);
const pinClient = await tsImport("../lib/ipfs/pin-client.ts", import.meta.url);
const challengeRoute = await tsImport(
  "../app/api/auth/challenge/route.ts",
  import.meta.url,
);
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
  process.env.DATABASE_WRITE_URL =
    "postgresql://write-test:test@ep-test.us-east-2.aws.neon.tech/laypipe_test";
  process.env.DATABASE_READ_URL =
    "postgresql://read-test:test@ep-test.us-east-2.aws.neon.tech/laypipe_test";
  process.env.LAYPIPE_DB_READ_ROLE = "laypipe_runtime_read";
  process.env.LAYPIPE_DB_WRITE_ROLE = "laypipe_runtime_write";
}

function promotionRegistryResponse(init) {
  const body = JSON.parse(init.body);
  if (body.query === databaseModule.RUNTIME_DATABASE_ATTESTATION_SQL) {
    const access = body.params[0] === "laypipe_runtime_read" ? "read" : "write";
    const write = access === "write";
    const group = `laypipe_runtime_${access}`;
    const row = {
      database_id: "11111111-1111-4111-8111-111111111111",
      database_name: "laypipe_test",
      session_user: `laypipe_${access}_login`,
      current_user: `laypipe_${access}_login`,
      migration_fingerprint: [
        `0000_production_read_model.sql:${"a".repeat(64)}`,
        `0001_runtime_security.sql:${"b".repeat(64)}`,
        `0002_market_leader_snapshot.sql:${"c".repeat(64)}`,
        `0003_market_baseline_semantics.sql:${"d".repeat(64)}`,
      ].join(","),
      migration_count: "4",
      expected_group: group,
      direct_memberships: group,
      in_expected_group: true,
      membership_admin_option: false,
      membership_inherit_option: true,
      membership_set_option: true,
      role_superuser: false,
      role_inherit: true,
      role_create_role: false,
      role_create_db: false,
      role_can_login: true,
      role_replication: false,
      role_bypass_rls: false,
      owns_relation: false,
      owns_function: false,
      owns_schema: false,
      expected_group_superuser: false,
      expected_group_inherit: true,
      expected_group_create_role: false,
      expected_group_create_db: false,
      expected_group_can_login: false,
      expected_group_replication: false,
      expected_group_bypass_rls: false,
      expected_group_has_parent: false,
      expected_group_owns_relation: false,
      expected_group_owns_function: false,
      expected_group_owns_schema: false,
      can_create_database: false,
      can_create_schema: false,
      can_create_temp: false,
      can_modify_identity: false,
      can_modify_migration_ledger: false,
      can_modify_canonical: write,
      has_exact_canonical_write: write,
      can_modify_cursor_or_derived: false,
      can_delete_or_truncate_any: false,
      can_read_launches: true,
      can_write_blocks: write,
      can_delete_blocks: false,
      can_write_cursor: false,
      can_write_derived: false,
      can_insert_promotion: write,
      can_update_promotion: write,
      can_delete_promotion: false,
      can_execute_initialize_cursor: write,
      can_execute_advance_cursor: write,
      can_execute_record_observation: write,
      can_execute_rollback: write,
    };
    const fields = Object.keys(row).map((name) => ({
      name,
      dataTypeID: typeof row[name] === "boolean" ? 16 : 25,
    }));
    const values = Object.values(row).map((value) =>
      typeof value === "boolean" ? (value ? "t" : "f") : value,
    );
    return Response.json({ fields, rows: [values], rowCount: 1, command: "SELECT" });
  }
  if (body.query === registryModule.PROMOTION_REGISTRY_READY_SQL) {
    assert.deepEqual(body.params, []);
    return Response.json({
      fields: [{ name: "ready", dataTypeID: 23 }],
      rows: [],
      rowCount: 0,
      command: "SELECT",
    });
  }
  assert.equal(body.query, registryModule.RECORD_COMPLETED_PROMOTION_SQL);
  const promotionId = body.params[0];
  return Response.json({
    fields: [{ name: "promotion_id", dataTypeID: 25 }],
    rows: [[promotionId]],
    rowCount: 1,
    command: "INSERT",
  });
}

function createRedisMock() {
  const values = new Map();
  const commands = [];
  const fetcher = async (_url, init) => {
    const command = JSON.parse(init.body);
    commands.push(command);
    if (command[0] === "GET") {
      return Response.json({ result: values.get(command[1]) ?? null });
    }
    if (command[0] === "DEL") {
      const deleted = values.delete(command[1]);
      return Response.json({ result: deleted ? 1 : 0 });
    }
    if (command[0] === "SET") {
      const [, key, value, ...options] = command;
      if (options.includes("NX") && values.has(key)) {
        return Response.json({ result: null });
      }
      values.set(key, value);
      return Response.json({ result: "OK" });
    }
    if (command[0] === "EVAL") {
      const script = command[1];
      if (script.includes("INCR")) return Response.json({ result: [1, 1] });
      const keyCount = Number(command[2]);
      const keys = command.slice(3, 3 + keyCount);
      const args = command.slice(3 + keyCount);
      if (script.includes("laypipe:ipfs-promotion:release")) {
        if (values.get(keys[0]) !== args[0]) return Response.json({ result: 0 });
        values.delete(keys[0]);
        return Response.json({ result: 1 });
      }
      if (
        script.includes("laypipe:ipfs-promotion:save") ||
        script.includes("laypipe:ipfs-promotion:complete")
      ) {
        if (values.get(keys[0]) !== args[0]) return Response.json({ result: 0 });
        if (values.get(keys[2]) !== args[1]) return Response.json({ result: -1 });
        values.set(keys[1], args[2]);
        if (script.includes("laypipe:ipfs-promotion:complete")) values.delete(keys[0]);
        return Response.json({ result: 1 });
      }
      throw new Error(`Unexpected Redis script: ${script}`);
    }
    throw new Error(`Unexpected Redis command: ${command[0]}`);
  };
  return { values, commands, fetcher };
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
  assert.equal(
    httpModule.getRequestIp(
      new Request("https://laypipe.fun/api/auth/challenge", {
        headers: {
          "X-Vercel-Forwarded-For": "203.0.113.20",
          "X-Forwarded-For": "203.0.113.21",
        },
      }),
    ),
    "203.0.113.20",
  );
});

test("completed promotion registry writes are exact, bounded, and fail closed on identity drift", async () => {
  const record = {
    promotionId: "1".repeat(64),
    stageFileId: "11111111-1111-4111-8111-111111111111",
    pinDigest: "2".repeat(64),
    wallet: account.address,
    fileSha256: "3".repeat(64),
    image: {
      id: "22222222-2222-4222-8222-222222222222",
      cid: imageCid,
      size: 2048,
      mimeType: "image/webp",
    },
    metadata: {
      id: "33333333-3333-4333-8333-333333333333",
      cid: metadataCid,
      size: 512,
      mimeType: "application/json",
    },
    completedAt: Date.now(),
  };
  const calls = [];
  const database = {
    async query(sql, params, options) {
      calls.push({ sql, params, options });
      return [{ promotion_id: record.promotionId }];
    },
  };
  await registryModule.recordCompletedPromotion(database, record);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].sql, registryModule.RECORD_COMPLETED_PROMOTION_SQL);
  assert.equal(calls[0].params[3], account.address.toLowerCase());
  assert.ok(calls[0].options.fetchOptions.signal instanceof AbortSignal);
  assert.equal(calls[0].options.fetchOptions.signal.aborted, false);

  await registryModule.assertPromotionRegistryReady({
    query: async (sql, params, options) => {
      assert.equal(sql, registryModule.PROMOTION_REGISTRY_READY_SQL);
      assert.deepEqual(params, []);
      assert.ok(options.fetchOptions.signal instanceof AbortSignal);
      return [];
    },
  });

  await assert.rejects(
    registryModule.recordCompletedPromotion(
      { query: async () => [] },
      record,
    ),
    (error) => error?.code === "PROMOTION_REGISTRY_UNAVAILABLE",
  );
});

test("JSON request parsing enforces its byte cap while streaming and rejects invalid UTF-8", async () => {
  await assert.rejects(
    httpModule.readJsonObject(
      new Request("https://laypipe.fun/api/ipfs/stage", {
        method: "POST",
        headers: { "Content-Type": "application/jsonp" },
        body: "{}",
      }),
    ),
    (error) => error?.code === "CONTENT_TYPE",
  );
  let cancelled = false;
  const oversized = new Request("https://laypipe.fun/api/ipfs/pin", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"a":"'));
        controller.enqueue(new TextEncoder().encode("1234567890"));
      },
      cancel() {
        cancelled = true;
      },
    }),
    duplex: "half",
  });
  await assert.rejects(
    httpModule.readJsonObject(oversized, 8),
    (error) => error?.code === "BODY_TOO_LARGE",
  );
  assert.equal(cancelled, true);

  const invalidUtf8 = new Request("https://laypipe.fun/api/ipfs/stage", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: new Uint8Array([0x7b, 0xff, 0x7d]),
  });
  await assert.rejects(
    httpModule.readJsonObject(invalidUtf8),
    (error) => error?.code === "INVALID_JSON",
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
  await assert.rejects(
    challengeModule.verifyWalletAuthorization({
      challenge: issued.challenge,
      signature: `0x${"00".repeat(65)}`,
      wallet: account.address,
      action: "stage",
      contentDigest: digest,
      now: 1_800_000_001,
    }),
    (error) => error?.code === "INVALID_SIGNATURE",
  );
  assert.throws(
    () => challengeModule.decodeWalletChallenge(issued.challenge, 1_800_000_300),
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
  assert.ok(calls.every((call) => call.init.redirect === "error"));
  assert.ok(calls.every((call) => call.init.signal instanceof AbortSignal));
});

test("Upstash rejects malformed success bodies and promotion leases are owner-safe", async () => {
  configureEnvironment();
  for (const response of [Response.json({}), new Response("not-json")]) {
    await assert.rejects(
      redisModule.enforceRateLimit({
        namespace: "malformed",
        identity: account.address,
        limit: 1,
        windowSeconds: 60,
        fetcher: async () => response,
      }),
      (error) => error?.code === "RATE_LIMIT_UNAVAILABLE",
    );
  }

  const redis = createRedisMock();
  const nonce = {
    nonce: "nonce-idempotent",
    expiresAt: Math.floor(Date.now() / 1000) + 60,
    fetcher: redis.fetcher,
  };
  await redisModule.consumeNonce({ ...nonce, idempotencyKey: "promotion-a" });
  await redisModule.consumeNonce({ ...nonce, idempotencyKey: "promotion-a" });
  await assert.rejects(
    redisModule.consumeNonce({ ...nonce, idempotencyKey: "promotion-b" }),
    (error) => error?.code === "REPLAY",
  );

  const identity = promotionModule.createPromotionIdentity({
    stageFileId: stagedFileId,
    pinDigest: "12".repeat(32),
  });
  const acquired = await promotionModule.acquirePromotionLease(identity, {
    fetcher: redis.fetcher,
  });
  assert.equal(acquired.kind, "acquired");
  const wrongLease = { ...acquired.lease, token: "wrong-owner" };
  assert.equal(
    await promotionModule.releasePromotionLease(wrongLease, { fetcher: redis.fetcher }),
    false,
  );
  await assert.rejects(
    promotionModule.acquirePromotionLease(identity, { fetcher: redis.fetcher }),
    (error) => error?.code === "PROMOTION_IN_PROGRESS",
  );
  assert.equal(
    await promotionModule.releasePromotionLease(acquired.lease, {
      fetcher: redis.fetcher,
    }),
    true,
  );
  const reacquired = await promotionModule.acquirePromotionLease(identity, {
    fetcher: redis.fetcher,
  });
  assert.equal(reacquired.kind, "acquired");
  assert.equal(
    redis.commands.some(
      (command) =>
        command[0] === "EVAL" &&
        String(command[1]).includes("laypipe:ipfs-promotion:release"),
    ),
    true,
  );
});

test("challenge wallet throttling is scoped by requester IP to prevent targeted wallet denial", async () => {
  configureEnvironment();
  const originalFetch = globalThis.fetch;
  const commands = [];
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), "https://laypipe-test.upstash.io");
    commands.push(JSON.parse(init.body));
    return Response.json({ result: [1, 1] });
  };
  try {
    for (const ip of ["203.0.113.10", "203.0.113.11"]) {
      const response = await challengeRoute.POST(
        new Request("https://laypipe.fun/api/auth/challenge", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: "https://laypipe.fun",
            "X-Forwarded-For": ip,
          },
          body: JSON.stringify({
            wallet: account.address,
            action: "stage",
            contentDigest: "12".repeat(32),
          }),
        }),
      );
      assert.equal(response.status, 201);
    }
    const pairKeys = commands
      .map((command) => command[3])
      .filter((key) => key.startsWith("laypipe:challenge-ip-wallet:"));
    assert.equal(pairKeys.length, 2);
    assert.notEqual(pairKeys[0], pairKeys[1]);
  } finally {
    globalThis.fetch = originalFetch;
  }
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

test("browser bounds requests and retries the exact final pin without another signature", async () => {
  configureEnvironment();
  const png = await sharp({
    create: { width: 256, height: 256, channels: 4, background: "#72d34d" },
  })
    .png()
    .toBuffer();
  const file = new File([png], "client.png", { type: "image/png" });
  const draft = clientMetadata.normalizeMetadataDraft({
    name: "Retry Pipe",
    symbol: "RETRY",
    description: "Exact request retry.",
    feeMode: "creator",
  });
  let signatures = 0;
  let pinAttempts = 0;
  const pinBodies = [];
  const provider = {
    async request({ method, params }) {
      if (method === "eth_accounts") return [account.address];
      if (method === "personal_sign") {
        signatures += 1;
        const message = Buffer.from(String(params[0]).slice(2), "hex").toString("utf8");
        return account.signMessage({ message });
      }
      throw new Error(`Unexpected wallet method: ${method}`);
    },
  };
  const fetcher = async (url, init = {}) => {
    assert.ok(init.signal instanceof AbortSignal);
    const parsed = new URL(String(url));
    if (parsed.pathname === "/api/auth/challenge") {
      const body = JSON.parse(init.body);
      const issued = challengeModule.issueWalletChallenge({
        wallet: body.wallet,
        action: body.action,
        contentDigest: body.contentDigest,
      });
      return Response.json(issued, { status: 201 });
    }
    if (parsed.pathname === "/api/ipfs/stage") {
      return Response.json({
        uploadUrl: "https://uploads.pinata.cloud/v3/files/signed-client-test",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
    }
    if (parsed.hostname === "uploads.pinata.cloud") {
      return Response.json({ data: { id: stagedFileId, cid: stagedCid } });
    }
    if (parsed.pathname === "/api/ipfs/pin") {
      pinAttempts += 1;
      pinBodies.push(String(init.body));
      if (pinAttempts === 1) {
        return Response.json(
          { error: "Temporary provider failure.", code: "IPFS_UPLOAD" },
          { status: 502 },
        );
      }
      return Response.json(
        {
          image: {
            cid: imageCid,
            uri: `ipfs://${imageCid}`,
            gatewayUrl: `https://laypipe-test.mypinata.cloud/ipfs/${imageCid}`,
          },
          metadata: {
            cid: metadataCid,
            uri: `ipfs://${metadataCid}`,
            gatewayUrl: `https://laypipe-test.mypinata.cloud/ipfs/${metadataCid}`,
          },
          metadataDocument: clientMetadata.buildTokenMetadata(
            draft,
            `ipfs://${imageCid}`,
          ),
        },
        { status: 201 },
      );
    }
    throw new Error(`Unexpected client request: ${url}`);
  };

  const result = await pinClient.pinLaunchAssets({
    file,
    metadata: draft,
    wallet: account.address,
    provider,
    browserOrigin: "https://laypipe.fun",
    fetcher,
  });
  assert.equal(result.metadata.cid, metadataCid);
  assert.equal(pinAttempts, 2);
  assert.equal(signatures, 2, "one stage signature and one pin signature");
  assert.equal(pinBodies[0], pinBodies[1]);
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
  assert.equal(observed.body.cid_version, "v1");
  assert.equal(observed.body.keyvalues.file_sha256, "44".repeat(32));
  assert.equal(observed.init.headers.Authorization, "Bearer test-pinata-jwt-never-sent-to-browser");
  assert.equal(JSON.stringify(result).includes("test-pinata-jwt"), false);
});

test("public CID prediction matches fixed Kubo v1 vectors at every relevant chunk boundary", async () => {
  // Independently generated with Kubo v0.42.0 and `ipfs add --cid-version=1`.
  const vectors = [
    [0, "bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku"],
    [1, "bafkreidogqfzz75tpkmjzjke425xqcrmpcib2p5tg44hnbirumdbpl5adu"],
    [262_143, "bafkreic6iqyxuiad5dem4bzgyy336yoi6tegdqa4e5vt24gq3btool5cra"],
    [262_144, "bafkreiekhhjkxu4ztk3tyng3er3ijhg56mb44oe3gwbgquhzu4afrg2ksa"],
    [262_145, "bafybeigllfqgfpqydppr6cmv56g7ax4wyhruzswvcefv6j5kj77nzttfki"],
    [5 * 1024 * 1024, "bafybeid7mu43g4fehkxhdkl4x3lu4pybxuxpg57it6r6z7e36soj7h2yd4"],
  ];

  for (const [size, expectedCid] of vectors) {
    assert.equal(
      await pinataModule.predictPublicFileCid(new Uint8Array(size)),
      expectedCid,
      `unexpected Kubo v1 CID for ${size} zero bytes`,
    );
  }
});

test("permanent Pinata uploads pin v1 explicitly and file names do not affect the CID", async () => {
  configureEnvironment();
  const bytes = new Uint8Array([0]);
  const expectedCid = "bafkreidogqfzz75tpkmjzjke425xqcrmpcib2p5tg44hnbirumdbpl5adu";
  const observed = [];
  const names = ["first-name.bin", "second-name.bin"];

  for (const [index, fileName] of names.entries()) {
    const uploaded = await pinataModule.uploadPublicFile({
      bytes,
      fileName,
      mimeType: "application/octet-stream",
      keyvalues: { laypipe_promotion_part: "profile-test" },
      fetcher: async (url, init = {}) => {
        assert.equal(String(url), "https://uploads.pinata.cloud/v3/files");
        const file = init.body.get("file");
        observed.push({
          cidVersion: init.body.get("cid_version"),
          fileName: file.name,
          name: init.body.get("name"),
          bytes: new Uint8Array(await file.arrayBuffer()),
        });
        return Response.json({
          data: {
            id: `${index + 1}1111111-1111-4111-8111-111111111111`,
            cid: expectedCid,
            size: bytes.length,
            mime_type: "application/octet-stream",
          },
        });
      },
    });
    assert.equal(uploaded.cid, expectedCid);
  }

  assert.deepEqual(
    observed.map(({ cidVersion, fileName, name }) => ({ cidVersion, fileName, name })),
    names.map((name) => ({ cidVersion: "v1", fileName: name, name })),
  );
  assert.deepEqual(observed.map(({ bytes: uploadedBytes }) => [...uploadedBytes]), [[0], [0]]);
});

test("permanent Pinata uploads reject a CID that does not identify the reviewed bytes", async () => {
  configureEnvironment();
  const bytes = new Uint8Array([0]);
  const wrongCid = "bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku";
  const deleted = [];

  await assert.rejects(
    pinataModule.uploadPublicFile({
      bytes,
      fileName: "metadata.json",
      mimeType: "application/json",
      keyvalues: { laypipe_promotion_part: "metadata" },
      fetcher: async (url, init = {}) => {
        if (String(url) === "https://uploads.pinata.cloud/v3/files") {
          assert.equal(init.body.get("cid_version"), "v1");
          return Response.json({
            data: {
              id: "99999999-9999-4999-8999-999999999999",
              cid: wrongCid,
              size: bytes.length,
              mime_type: "application/json",
            },
          });
        }
        if (init.method === "DELETE") {
          deleted.push(String(url));
          return Response.json({ data: null });
        }
        throw new Error(`Unexpected network call: ${url}`);
      },
    }),
    (error) => error?.code === "IPFS_CID_MISMATCH" && error?.status === 502,
  );
  assert.deepEqual(deleted, [
    "https://api.pinata.cloud/v3/files/public/99999999-9999-4999-8999-999999999999",
  ]);
});

test("CID mismatch cleanup gets an independent deadline when the upload deadline expires", async () => {
  configureEnvironment();
  const bytes = new Uint8Array([0]);
  const wrongCid = "bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku";
  const uploadDeadline = new AbortController();
  const deleted = [];

  await assert.rejects(
    pinataModule.uploadPublicFile({
      bytes,
      fileName: "deadline.bin",
      mimeType: "application/octet-stream",
      keyvalues: { laypipe_promotion_part: "deadline-test" },
      signal: uploadDeadline.signal,
      fetcher: async (url, init = {}) => {
        if (String(url) === "https://uploads.pinata.cloud/v3/files") {
          uploadDeadline.abort();
          return Response.json({
            data: {
              id: "77777777-7777-4777-8777-777777777777",
              cid: wrongCid,
              size: bytes.length,
              mime_type: "application/octet-stream",
            },
          });
        }
        if (init.method === "DELETE") {
          assert.equal(init.signal.aborted, false);
          deleted.push(String(url));
          return Response.json({ data: null });
        }
        throw new Error(`Unexpected network call: ${url}`);
      },
    }),
    (error) => error?.code === "IPFS_CID_MISMATCH" && error?.status === 502,
  );
  assert.deepEqual(deleted, [
    "https://api.pinata.cloud/v3/files/public/77777777-7777-4777-8777-777777777777",
  ]);
});

test("CID mismatch remains fail-closed and warns when provider cleanup fails", async () => {
  configureEnvironment();
  const bytes = new Uint8Array([0]);
  const wrongCid = "bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku";
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...values) => warnings.push(values);
  try {
    await assert.rejects(
      pinataModule.uploadPublicFile({
        bytes,
        fileName: "cleanup.bin",
        mimeType: "application/octet-stream",
        keyvalues: { laypipe_promotion_part: "cleanup-test" },
        fetcher: async (url, init = {}) => {
          if (String(url) === "https://uploads.pinata.cloud/v3/files") {
            return Response.json({
              data: {
                id: "66666666-6666-4666-8666-666666666666",
                cid: wrongCid,
                size: bytes.length,
                mime_type: "application/octet-stream",
              },
            });
          }
          if (init.method === "DELETE") {
            return Response.json({ error: "forced cleanup failure" }, { status: 500 });
          }
          throw new Error(`Unexpected network call: ${url}`);
        },
      }),
      (error) => error?.code === "IPFS_CID_MISMATCH" && error?.status === 502,
    );
  } finally {
    console.warn = originalWarn;
  }
  assert.deepEqual(warnings, [[
    "LayPipe mismatched permanent pin cleanup failed",
    {
      error: "PinMismatchCleanupError",
      fileId: "66666666-6666-4666-8666-666666666666",
    },
  ]]);
});

test("malformed permanent Pinata responses are normalized to an upstream 502", async () => {
  configureEnvironment();
  const bytes = new Uint8Array([0]);
  const malformed = [
    () => new Response("{", { status: 200, headers: { "Content-Type": "application/json" } }),
    () => Response.json({
      data: {
        id: "55555555-5555-4555-8555-555555555555",
        cid: "not-a-cid",
        size: bytes.length,
        mime_type: "application/octet-stream",
      },
    }),
  ];

  for (const response of malformed) {
    await assert.rejects(
      pinataModule.uploadPublicFile({
        bytes,
        fileName: "malformed.bin",
        mimeType: "application/octet-stream",
        keyvalues: { laypipe_promotion_part: "malformed-test" },
        fetcher: async () => response(),
      }),
      (error) => error?.code === "IPFS_RESPONSE" && error?.status === 502,
    );
  }
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

test("stage route rejects non-canonical filenames before issuing Pinata upload authority", async () => {
  configureEnvironment();
  const originalFetch = globalThis.fetch;
  let pinataCalls = 0;
  globalThis.fetch = async (url) => {
    if (String(url) === "https://laypipe-test.upstash.io") {
      return Response.json({ result: [1, 1] });
    }
    pinataCalls += 1;
    return Response.json({ data: "unexpected" });
  };
  try {
    const response = await stageRoute.POST(
      apiRequest("/api/ipfs/stage", {
        wallet: account.address,
        fileName: "../coin.png",
        mimeType: "image/png",
        size: 1234,
        fileSha256: "13".repeat(32),
      }),
    );
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, "INVALID_UPLOAD");
    assert.equal(pinataCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("pin route rejects a tagged stage whose provenance digest is not bound to its file", async () => {
  configureEnvironment();
  const originalFetch = globalThis.fetch;
  const fileSha256 = "14".repeat(32);
  const draft = clientMetadata.normalizeMetadataDraft({
    name: "Unbound Stage",
    symbol: "BOUND",
    description: "A tag alone is not authorization.",
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
  const redis = createRedisMock();
  let downstreamCalls = 0;
  globalThis.fetch = async (url, init = {}) => {
    const urlString = String(url);
    if (urlString === "https://laypipe-test.upstash.io") {
      return redis.fetcher(url, init);
    }
    if (urlString === "https://api.us-east-2.aws.neon.tech/sql") {
      return promotionRegistryResponse(init);
    }
    if (urlString.endsWith(`/v3/files/public/${stagedFileId}`) && init.method !== "DELETE") {
      return Response.json({
        data: {
          id: stagedFileId,
          name: "coin.png",
          cid: stagedCid,
          size: 1234,
          mime_type: "image/png",
          keyvalues: {
            laypipe_stage: "true",
            wallet: account.address.toLowerCase(),
            digest: "15".repeat(32),
            file_sha256: fileSha256,
          },
        },
      });
    }
    downstreamCalls += 1;
    return Response.json({ data: null });
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
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, "STAGE_MISMATCH");
    assert.equal(downstreamCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("pin route rejects self-burn metadata before granting provider authority", async () => {
  configureEnvironment();
  const originalFetch = globalThis.fetch;
  const draft = clientMetadata.normalizeMetadataDraft({
    name: "Disabled Burn",
    symbol: "NOBURN",
    description: "Self-burn is release-blocked.",
    feeMode: "self-burn",
  });
  let upstreamCalls = 0;
  globalThis.fetch = async () => {
    upstreamCalls += 1;
    return Response.json({ result: [1, 1] });
  };
  try {
    const response = await pinRoute.POST(
      apiRequest("/api/ipfs/pin", {
        wallet: account.address,
        stagedCid,
        stagedFileId,
        fileSha256: "16".repeat(32),
        metadata: draft,
        challenge: "not-used",
        signature: `0x${"00".repeat(65)}`,
      }),
    );
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, "SELF_BURN_DISABLED");
    assert.equal(upstreamCalls, 1, "only the IP rate-limit check runs before parsing");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("pin route validates staged bytes and returns exactly the dual-CID response", async () => {
  configureEnvironment();
  assert.ok(pinRoute.IPFS_PIN_UPSTREAM_DEADLINE_MS <= 50_000);
  const originalFetch = globalThis.fetch;
  const png = await sharp({
    create: { width: 256, height: 256, channels: 4, background: "#f5c542" },
  })
    .png()
    .toBuffer();
  const fileSha256 = createHash("sha256").update(png).digest("hex");
  const stageDigest = digestModule.stageAuthorizationDigest({
    wallet: account.address,
    fileName: "coin.png",
    mimeType: "image/png",
    size: png.length,
    fileSha256,
  });
  const draft = clientMetadata.normalizeMetadataDraft({
    name: "Backend Pipe",
    symbol: "BACK",
    description: "Server verified artwork.",
    feeMode: "creator",
    website: "https://laypipe.fun/",
  });
  const pinDigest = digestModule.pinAuthorizationDigest({
    wallet: account.address,
    stagedCid,
    stagedFileId,
    fileSha256,
    metadata: draft,
  });
  const auth = await authorize("pin", pinDigest);
  const uploads = [];
  const deletes = [];
  const warnings = [];
  let registryWrites = 0;
  const redis = createRedisMock();
  const originalWarn = console.warn;
  console.warn = (...values) => warnings.push(values);
  globalThis.fetch = async (url, init = {}) => {
    const urlString = String(url);
    if (urlString === "https://laypipe-test.upstash.io") {
      return redis.fetcher(url, init);
    }
    if (urlString === "https://api.us-east-2.aws.neon.tech/sql") {
      if (JSON.parse(init.body).query === registryModule.RECORD_COMPLETED_PROMOTION_SQL) {
        registryWrites += 1;
      }
      return promotionRegistryResponse(init);
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
      const bytes = Buffer.from(await file.arrayBuffer());
      const cid = await pinataModule.predictPublicFileCid(bytes);
      uploads.push({
        name: file.name,
        type: file.type,
        bytes,
        cid,
        keyvalues: JSON.parse(init.body.get("keyvalues")),
      });
      const isMetadata = file.type === "application/json";
      return Response.json({
        data: {
          id: isMetadata
            ? "99999999-9999-4999-8999-999999999999"
            : "88888888-8888-4888-8888-888888888888",
          cid,
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
    assert.equal(payload.image.cid, uploads[0].cid);
    assert.equal(payload.metadata.cid, uploads[1].cid);
    assert.equal(payload.metadataDocument.image, `ipfs://${uploads[0].cid}`);
    assert.deepEqual(
      payload.metadataDocument,
      clientMetadata.buildTokenMetadata(draft, `ipfs://${uploads[0].cid}`),
    );
    assert.equal(uploads.length, 2);
    assert.equal(uploads[0].type, "image/webp");
    assert.equal(uploads[1].type, "application/json");
    assert.equal(uploads[0].keyvalues.laypipe_promotion_part, "image");
    assert.equal(uploads[1].keyvalues.laypipe_promotion_part, "metadata");
    assert.equal(
      uploads[0].keyvalues.laypipe_promotion,
      uploads[1].keyvalues.laypipe_promotion,
    );
    assert.equal(uploads[0].keyvalues.laypipe_pin_digest, pinDigest);
    assert.equal(uploads[1].keyvalues.laypipe_stage_file, stagedFileId);
    assert.equal(deletes.some((url) => url.endsWith(stagedFileId)), true);
    assert.equal(warnings.length, 1);
    assert.equal(JSON.stringify(payload).includes(process.env.PINATA_JWT), false);
    assert.equal(registryWrites, 1);

    const providerCallsAfterFirstPromotion = uploads.length + deletes.length;
    const replay = await pinRoute.POST(
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
    assert.equal(replay.status, 201);
    assert.equal(await replay.text(), JSON.stringify(payload));
    assert.equal(uploads.length, 2);
    assert.equal(uploads.length + deletes.length, providerCallsAfterFirstPromotion);
    assert.equal(registryWrites, 2, "exact replay must repair or confirm the durable registry");
  } finally {
    console.warn = originalWarn;
    globalThis.fetch = originalFetch;
  }
});

test("metadata provider failure keeps the raw stage and resumes without deleting permanent pins", async () => {
  configureEnvironment();
  const originalFetch = globalThis.fetch;
  const png = await sharp({
    create: { width: 256, height: 256, channels: 3, background: "#000" },
  })
    .png()
    .toBuffer();
  const fileSha256 = createHash("sha256").update(png).digest("hex");
  const stageDigest = digestModule.stageAuthorizationDigest({
    wallet: account.address,
    fileName: "coin.png",
    mimeType: "image/png",
    size: png.length,
    fileSha256,
  });
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
  const redis = createRedisMock();
  let uploadCount = 0;
  let stageGetCount = 0;
  const deletes = [];
  let failMetadataOnce = true;
  let failCompletionOnce = true;
  let pinnedMetadataCid;
  globalThis.fetch = async (url, init = {}) => {
    const urlString = String(url);
    if (urlString === "https://laypipe-test.upstash.io") {
      const command = JSON.parse(init.body);
      if (
        command[0] === "EVAL" &&
        String(command[1]).includes("laypipe:ipfs-promotion:complete") &&
        failCompletionOnce
      ) {
        failCompletionOnce = false;
        return Response.json({ error: "forced completion timeout" }, { status: 500 });
      }
      return redis.fetcher(url, init);
    }
    if (urlString === "https://api.us-east-2.aws.neon.tech/sql") {
      return promotionRegistryResponse(init);
    }
    if (urlString.endsWith(`/v3/files/public/${stagedFileId}`) && init.method !== "DELETE") {
      stageGetCount += 1;
      if (stageGetCount > 1) {
        return Response.json({ error: "stage expired" }, { status: 404 });
      }
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
      return new Response(png, { headers: { "Content-Type": "image/png" } });
    }
    if (urlString === "https://uploads.pinata.cloud/v3/files") {
      uploadCount += 1;
      const file = init.body.get("file");
      if (file.type === "application/json" && failMetadataOnce) {
        failMetadataOnce = false;
        return Response.json({ error: "forced" }, { status: 500 });
      }
      const cid = await pinataModule.predictPublicFileCid(
        new Uint8Array(await file.arrayBuffer()),
      );
      if (file.type === "application/json") pinnedMetadataCid = cid;
      return Response.json({
        data: {
          id:
            file.type === "application/json"
              ? "99999999-9999-4999-8999-999999999999"
              : "88888888-8888-4888-8888-888888888888",
          cid,
          size: file.size,
          mime_type: file.type,
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
    assert.deepEqual(deletes, []);

    const metadataPinnedRetry = await pinRoute.POST(
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
    assert.equal(metadataPinnedRetry.status, 503);
    assert.equal(uploadCount, 3);
    assert.equal(stageGetCount, 1, "saved image progress must resume after raw-stage cleanup");

    const completionRetry = await pinRoute.POST(
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
    assert.equal(completionRetry.status, 201);
    assert.equal((await completionRetry.json()).metadata.cid, pinnedMetadataCid);
    assert.equal(uploadCount, 3, "saved metadata progress must not repin either file");
    assert.equal(stageGetCount, 1);
    assert.deepEqual(deletes, []);
    assert.equal(
      deletes.some((url) => url.endsWith("88888888-8888-4888-8888-888888888888")),
      false,
    );
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
