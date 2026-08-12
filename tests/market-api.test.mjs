import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const require = createRequire(import.meta.url);
const multiformatsCid = await import("multiformats/cid");
const ts = require("typescript");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cache = new Map();
process.env.WALLET_CHALLENGE_SECRET = "market-test-secret-that-is-longer-than-thirty-two-bytes";

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
    if (specifier === "multiformats/cid") return multiformatsCid;
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

const readModel = loadTypeScript("lib/server/market/read-model.ts");
const http = loadTypeScript("lib/server/market/http.ts");
const mode = loadTypeScript("lib/server/market/mode.ts");
const pageToken = loadTypeScript("lib/server/market/page-token.ts");

const hash = (byte) => `0x${byte.repeat(64)}`;
const address = (byte) => `0x${byte.repeat(40)}`;

function liveTokenRow(overrides = {}) {
  return {
    chain_id: "4663",
    token_address: address("a"),
    pool_id: hash("b"),
    creator_address: address("c"),
    config_id: "1",
    first_buy_in: "1000000000000000000",
    first_buy_out: "2000000000000000000",
    hook_address: address("d"),
    fee_recipient_address: address("e"),
    fee_mode: "self-burn",
    name: "Pipe Test",
    symbol: "PIPE",
    description: "Indexed fixture used only inside the test double.",
    logo_uri: "ipfs://art",
    metadata_uri: "ipfs://metadata",
    approved_logo_cid: null,
    socials: {},
    block_number: "123",
    log_index: 7,
    launched_at: "2026-08-11T12:00:00.000Z",
    last_pipedog_amount: "500000000000000000",
    last_token_amount: "1000000000000000000",
    last_trade_at: "2026-08-11T12:05:00.000Z",
    baseline_pipedog_amount: null,
    baseline_token_amount: null,
    volume_24h_pipedog: "0",
    trades_24h: "0",
    total_trades: "1",
    ...overrides,
  };
}

function readyWatermarkRow(overrides = {}) {
  return {
    stream: "laypipe",
    next_block: "125",
    last_processed_block: "124",
    last_processed_hash: hash("a"),
    observed_safe_head: "124",
    observed_at: new Date().toISOString(),
    last_run_status: "caught-up",
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

function databaseFor({
  tokenRows = [],
  watermarkRows = [readyWatermarkRow()],
  snapshotWatermarkRows = watermarkRows,
} = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, params = [], options) {
      calls.push({ sql, params, options });
      if (sql === readModel.INDEXER_WATERMARK_SQL) return watermarkRows;
      return tokenRows;
    },
    async transaction(factory, options) {
      const transaction = {
        async query(sql, params = [], queryOptions) {
          calls.push({ sql, params, options: queryOptions, inTransaction: true });
          if (sql === readModel.MARKET_SNAPSHOT_WATERMARK_SQL) {
            return snapshotWatermarkRows;
          }
          return tokenRows;
        },
      };
      const queries = factory(transaction);
      const result = await Promise.all(queries);
      calls.push({ transactionOptions: options });
      return result;
    },
  };
}

test("token list validation is bounded and cursors are canonical", () => {
  assert.deepEqual(readModel.parseTokenListRequest("https://laypipe.fun/api/tokens"), {
    limit: 20,
    cursor: null,
  });
  assert.throws(
    () => readModel.parseTokenListRequest("https://laypipe.fun/api/tokens?limit=51"),
    /between 1 and 50/,
  );
  assert.throws(
    () => readModel.parseTokenListRequest("https://laypipe.fun/api/tokens?limit=2&limit=3"),
    /only be provided once/,
  );
  assert.throws(
    () => readModel.parseTokenListRequest("https://laypipe.fun/api/tokens?sort=hot"),
    /Unsupported query parameter/,
  );
  const cursor = readModel.encodeTokenCursor({
    blockNumber: "123",
    logIndex: 7,
    tokenAddress: address("a"),
  });
  assert.deepEqual(readModel.decodeTokenCursor(cursor), {
    blockNumber: "123",
    logIndex: 7,
    tokenAddress: address("a"),
  });
  const tampered = `${cursor.slice(0, -1)}${cursor.endsWith("a") ? "b" : "a"}`;
  assert.throws(() => readModel.decodeTokenCursor(tampered), /malformed/);
  const unsigned = Buffer.from(JSON.stringify({
    v: 1,
    b: "123",
    l: 7,
    a: address("a"),
  })).toString("base64url");
  assert.throws(() => readModel.decodeTokenCursor(unsigned), /malformed/);
  assert.throws(() => readModel.decodeTokenCursor("not-json"), /malformed/);
});

test("live market APIs fail closed before Neon when cursor signing is unavailable", async () => {
  let databaseCalls = 0;
  const response = await http.handleTokenListRequest(
    new Request("https://laypipe.fun/api/tokens"),
    {
      marketMode: () => "live",
      marketCursorSecret: () => {
        throw new Error("missing signing secret");
      },
      database: async () => {
        databaseCalls += 1;
        return databaseFor();
      },
    },
  );
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(databaseCalls, 0);
});

test("list queries use fixed SQL placeholders and keyset parameters", async () => {
  const cursor = {
    blockNumber: "123",
    logIndex: 7,
    tokenAddress: address("a"),
  };
  const database = databaseFor({ tokenRows: [liveTokenRow()] });
  const result = await readModel.listLiveTokens(database, { limit: 10, cursor });
  const tokenCall = database.calls.find((call) => call.sql === readModel.TOKEN_LIST_SQL);
  assert.ok(tokenCall);
  assert.equal(tokenCall.inTransaction, true);
  assert.deepEqual(tokenCall.params, [4663, "123", 7, address("a"), 11]);
  assert.ok(tokenCall.options?.fetchOptions?.signal instanceof AbortSignal);
  assert.equal(tokenCall.options.fetchOptions.signal.aborted, false);
  assert.match(tokenCall.sql, /\$1::bigint/);
  assert.match(tokenCall.sql, /\$5::integer/);
  assert.doesNotMatch(tokenCall.sql, new RegExp(address("a")));
  assert.equal(result.tokens[0].metrics.volume24hPipedog.value, "0");
  assert.equal(result.tokens[0].metrics.volume24hPipedog.status, "observed");
  assert.equal(result.tokens[0].metrics.marketCapUsd.status, "unavailable");
  assert.equal(result.tokens[0].metrics.marketCapUsd.value, null);
  assert.match(tokenCall.sql, /WITH watermark AS MATERIALIZED/);
  assert.match(tokenCall.sql, /promotion\.wallet_address = p\.creator_address/);
  assert.match(tokenCall.sql, /s\.block_number <= w\.last_processed_block/);
  assert.match(tokenCall.sql, /w\.last_processed_at - interval '24 hours'/);
  assert.doesNotMatch(tokenCall.sql, /now\(\) - interval '24 hours'/);
  assert.match(tokenCall.sql, /pool_market_totals/);
  assert.doesNotMatch(tokenCall.sql, /total_swap_stats/);
  const transactionCall = database.calls.find((call) => call.transactionOptions);
  assert.equal(transactionCall.transactionOptions.isolationLevel, "RepeatableRead");
  assert.equal(transactionCall.transactionOptions.readOnly, true);
  assert.equal(transactionCall.transactionOptions.deferrable, true);
});

test("approved artwork is bound to the original launch creator", () => {
  assert.match(
    readModel.TOKEN_LIST_SQL,
    /promotion\.wallet_address = p\.creator_address/,
  );
  assert.match(
    readModel.TOKEN_DETAIL_SQL,
    /promotion\.wallet_address = p\.creator_address/,
  );
});

test("stale market precheck never opens a token snapshot", async () => {
  const database = databaseFor({
    watermarkRows: [readyWatermarkRow({ observed_at: "2020-01-01T00:00:00.000Z" })],
    tokenRows: [liveTokenRow()],
  });
  await assert.rejects(
    readModel.listLiveTokens(database, { limit: 10, cursor: null }),
    /not ready/,
  );
  assert.equal(database.calls.length, 1);
  assert.equal(database.calls[0].sql, readModel.INDEXER_WATERMARK_SQL);
});

test("market response uses the watermark and token rows from one concurrent snapshot", async () => {
  const precheck = readyWatermarkRow({
    next_block: "125",
    last_processed_block: "124",
    observed_safe_head: "124",
  });
  const snapshot = readyWatermarkRow({
    next_block: "127",
    last_processed_block: "126",
    observed_safe_head: "126",
  });
  const database = databaseFor({
    watermarkRows: [precheck],
    snapshotWatermarkRows: [snapshot],
    tokenRows: [liveTokenRow({ block_number: "125" })],
  });
  const result = await readModel.listLiveTokens(database, { limit: 10, cursor: null });
  assert.equal(result.indexer.lastProcessedBlock, "126");
  assert.equal(result.tokens[0].blockNumber, "125");
  assert.deepEqual(
    database.calls.slice(1, 3).map((call) => ({ sql: call.sql, inTransaction: call.inTransaction })),
    [
      { sql: readModel.MARKET_SNAPSHOT_WATERMARK_SQL, inTransaction: true },
      { sql: readModel.TOKEN_LIST_SQL, inTransaction: true },
    ],
  );
});

test("market routes set explicit cache policy and never expose backend errors", async () => {
  const database = databaseFor({ tokenRows: [liveTokenRow()] });
  const ok = await http.handleTokenListRequest(
    new Request("https://laypipe.fun/api/tokens?limit=1"),
    { marketMode: () => "live", database: async () => database },
  );
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("cache-control"), http.MARKET_CACHE_CONTROL);

  const bad = await http.handleTokenListRequest(
    new Request("https://laypipe.fun/api/tokens?limit=999"),
    { marketMode: () => "live", database: async () => database },
  );
  assert.equal(bad.status, 400);
  assert.equal(bad.headers.get("cache-control"), "no-store");

  const unavailable = await http.handleTokenListRequest(
    new Request("https://laypipe.fun/api/tokens"),
    {
      marketMode: () => "live",
      database: async () => { throw new Error("postgres://secret@host/db"); },
    },
  );
  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.headers.get("cache-control"), "no-store");
  assert.doesNotMatch(await unavailable.text(), /postgres|secret|host/);
});

test("token detail is address-parameterized and distinguishes not found", async () => {
  const database = databaseFor({ tokenRows: [liveTokenRow()] });
  const ok = await http.handleTokenDetailRequest(address("a"), {
    marketMode: () => "live",
    database: async () => database,
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("cache-control"), http.MARKET_CACHE_CONTROL);
  const tokenCall = database.calls.find((call) => call.sql === readModel.TOKEN_DETAIL_SQL);
  assert.ok(tokenCall);
  assert.deepEqual(tokenCall.params, [4663, address("a")]);
  assert.doesNotMatch(tokenCall.sql, new RegExp(address("a")));
  assert.equal((await ok.json()).token.logoGatewayUrl, null);

  const previousGateway = process.env.IPFS_GATEWAY_BASE_URL;
  const artworkCid = "bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku";
  process.env.IPFS_GATEWAY_BASE_URL = "https://laypipe-test.mypinata.cloud";
  try {
    const artwork = await http.handleTokenDetailRequest(address("a"), {
      marketMode: () => "live",
      database: async () =>
        databaseFor({
          tokenRows: [liveTokenRow({
            logo_uri: `ipfs://${artworkCid}`,
            approved_logo_cid: artworkCid,
          })],
        }),
    });
    assert.equal(artwork.status, 200);
    assert.equal(
      (await artwork.json()).token.logoGatewayUrl,
      `https://laypipe-test.mypinata.cloud/ipfs/${artworkCid}`,
    );
  } finally {
    if (previousGateway === undefined) delete process.env.IPFS_GATEWAY_BASE_URL;
    else process.env.IPFS_GATEWAY_BASE_URL = previousGateway;
  }

  const unapproved = await http.handleTokenDetailRequest(address("a"), {
    marketMode: () => "live",
    database: async () => databaseFor({
      tokenRows: [liveTokenRow({
        logo_uri: `ipfs://${artworkCid}`,
        metadata_uri: `ipfs://${artworkCid}`,
        approved_logo_cid: null,
      })],
    }),
  });
  assert.equal(unapproved.status, 200);
  assert.equal((await unapproved.json()).token.logoGatewayUrl, null);

  const missing = await http.handleTokenDetailRequest(address("f"), {
    marketMode: () => "live",
    database: async () => databaseFor(),
  });
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get("cache-control"), "no-store");
});

test("missing DATABASE_READ_URL fails closed through the production route boundary", async () => {
  const previous = process.env.DATABASE_READ_URL;
  delete process.env.DATABASE_READ_URL;
  try {
    const response = await http.handleTokenListRequest(
      new Request("https://laypipe.fun/api/tokens"),
      { marketMode: () => "live" },
    );
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      error: {
        code: "market_data_unavailable",
        message: "Live market data is not available right now.",
      },
    });
  } finally {
    if (previous === undefined) delete process.env.DATABASE_READ_URL;
    else process.env.DATABASE_READ_URL = previous;
  }
});

test("detail and health routes validate identifiers and readiness", async () => {
  let databaseCalled = false;
  const invalid = await http.handleTokenDetailRequest("pipe-dream", {
    marketMode: () => "live",
    database: async () => {
      databaseCalled = true;
      return databaseFor();
    },
  });
  assert.equal(invalid.status, 400);
  assert.equal(databaseCalled, false);

  const fixture = await http.handleMarketHealthRequest({
    marketMode: () => "fixture",
    database: async () => { throw new Error("must not connect"); },
  });
  assert.equal(fixture.status, 200);
  assert.deepEqual(await fixture.json(), {
    status: "alive",
    check: "liveness",
    marketMode: "fixture",
    readyForLiveMarkets: false,
    database: { status: "not_checked", reason: "Fixture mode does not use Neon." },
    indexer: {
      status: "not_checked",
      reason: "Fixture mode does not require an indexer.",
    },
  });

  const fixtureReadiness = await http.handleMarketHealthRequest(
    {
      marketMode: () => "fixture",
      database: async () => { throw new Error("must not connect"); },
    },
    { requireLive: true },
  );
  assert.equal(fixtureReadiness.status, 503);
  assert.equal((await fixtureReadiness.json()).readyForLiveMarkets, false);

  const liveNotReady = await http.handleMarketHealthRequest({
    marketMode: () => "live",
    database: async () => databaseFor({ watermarkRows: [] }),
  });
  assert.equal(liveNotReady.status, 503);
  assert.deepEqual(await liveNotReady.json(), {
    status: "not_ready",
    check: "readiness",
    marketMode: "live",
    readyForLiveMarkets: false,
    database: { status: "reachable" },
    indexer: { status: "missing", cursor: null },
  });
});

test("fixture mode gates public live-token APIs before any database access", async () => {
  let databaseCalls = 0;
  const dependencies = {
    marketMode: () => "fixture",
    database: async () => {
      databaseCalls += 1;
      throw new Error("database must not be reached");
    },
  };
  const list = await http.handleTokenListRequest(
    new Request("https://laypipe.fun/api/tokens"),
    dependencies,
  );
  const detail = await http.handleTokenDetailRequest(address("a"), dependencies);
  for (const response of [list, detail]) {
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), {
      error: {
        code: "market_data_unavailable",
        message: "Live market data is disabled for this deployment.",
      },
    });
  }
  assert.equal(databaseCalls, 0);
});

test("live health requires a recent indexer cursor and rejects stale or future watermarks", async () => {
  const now = new Date("2026-08-11T12:11:00.000Z").getTime();
  const ready = await http.handleMarketHealthRequest({
    marketMode: () => "live",
    now: () => now,
    database: async () =>
      databaseFor({
        watermarkRows: [
          readyWatermarkRow({
            observed_at: "2026-08-11T12:10:00.000Z",
            updated_at: "2026-08-11T12:10:00.000Z",
          }),
        ],
      }),
  });
  assert.equal(ready.status, 200);
  assert.equal(ready.headers.get("cache-control"), "no-store");
  const body = await ready.json();
  assert.equal(body.status, "ready");
  assert.equal(body.check, "readiness");
  assert.equal(body.readyForLiveMarkets, true);
  assert.equal(body.database.status, "reachable");
  assert.equal(body.indexer.status, "ready");
  assert.deepEqual(body.indexer.freshness, {
    status: "fresh",
    ageSeconds: 60,
    staleAfterSeconds: 300,
    blockLag: 0,
    maxBlockLag: 2,
  });
  assert.equal(body.indexer.cursor.lastProcessedBlock, "124");

  const regressedHead = await http.handleMarketHealthRequest({
    marketMode: () => "live",
    now: () => now,
    database: async () =>
      databaseFor({
        watermarkRows: [
          readyWatermarkRow({
            last_processed_block: "125",
            next_block: "126",
            observed_safe_head: "124",
            observed_at: "2026-08-11T12:10:59.000Z",
          }),
        ],
      }),
  });
  assert.equal(regressedHead.status, 503);
  const regressedBody = await regressedHead.json();
  assert.equal(regressedBody.indexer.freshness.reason, "observation_behind_cursor");
  assert.equal(regressedBody.indexer.freshness.blockLag, null);

  const stale = await http.handleMarketHealthRequest({
    marketMode: () => "live",
    now: () => now,
    database: async () =>
      databaseFor({
        watermarkRows: [
          readyWatermarkRow({
            observed_at: "2026-08-11T12:05:59.000Z",
            updated_at: "2026-08-11T12:05:59.000Z",
          }),
        ],
      }),
  });
  assert.equal(stale.status, 503);
  const staleBody = await stale.json();
  assert.equal(staleBody.readyForLiveMarkets, false);
  assert.equal(staleBody.indexer.status, "stale");
  assert.equal(staleBody.indexer.freshness.reason, "observation_too_old");

  const uninitialized = await http.handleMarketHealthRequest({
    marketMode: () => "live",
    now: () => now,
    database: async () =>
      databaseFor({
        watermarkRows: [
          {
            stream: "laypipe",
            next_block: "100",
            last_processed_block: null,
            last_processed_hash: null,
            observed_safe_head: "124",
            observed_at: "2026-08-11T12:10:59.000Z",
            last_run_status: "caught-up",
            updated_at: "2026-08-11T12:10:59.000Z",
          },
        ],
      }),
  });
  assert.equal(uninitialized.status, 503);
  const uninitializedBody = await uninitialized.json();
  assert.equal(uninitializedBody.readyForLiveMarkets, false);
  assert.equal(uninitializedBody.indexer.status, "stale");
  assert.equal(
    uninitializedBody.indexer.freshness.reason,
    "cursor_uninitialized",
  );

  const inconsistent = await http.handleMarketHealthRequest({
    marketMode: () => "live",
    now: () => now,
    database: async () =>
      databaseFor({
        watermarkRows: [
          {
            stream: "laypipe",
            next_block: "125",
            last_processed_block: "124",
            last_processed_hash: null,
            observed_safe_head: "124",
            observed_at: "2026-08-11T12:10:59.000Z",
            last_run_status: "caught-up",
            updated_at: "2026-08-11T12:10:59.000Z",
          },
        ],
      }),
  });
  assert.equal(inconsistent.status, 503);
  assert.equal((await inconsistent.json()).status, "unavailable");

  const future = readModel.assessIndexerFreshness(
    {
      stream: "laypipe",
      nextBlock: "125",
      lastProcessedBlock: "124",
      lastProcessedHash: hash("a"),
      updatedAt: "2026-08-11T12:12:00.000Z",
      observedSafeHead: "124",
      observedAt: "2026-08-11T12:12:00.000Z",
      lastRunStatus: "caught-up",
    },
    now,
  );
  assert.equal(future.status, "stale");
  assert.equal(future.reason, "observation_from_future");

  const behindDatabase = databaseFor({
    tokenRows: [liveTokenRow()],
    watermarkRows: [readyWatermarkRow({
      observed_safe_head: "1000",
      observed_at: "2026-08-11T12:10:59.000Z",
      updated_at: "2026-08-11T12:10:59.000Z",
    })],
  });
  const behindHealth = await http.handleMarketHealthRequest({
    marketMode: () => "live",
    now: () => now,
    database: async () => behindDatabase,
  });
  assert.equal(behindHealth.status, 503);
  assert.equal(
    (await behindHealth.json()).indexer.freshness.reason,
    "block_lag_too_high",
  );
  const behindList = await http.handleTokenListRequest(
    new Request("https://laypipe.fun/api/tokens"),
    {
      marketMode: () => "live",
      now: () => now,
      database: async () => behindDatabase,
    },
  );
  assert.equal(behindList.status, 503);
  assert.equal(behindList.headers.get("cache-control"), "no-store");

  const bounded = readModel.assessIndexerFreshness(
    {
      stream: "laypipe",
      nextBlock: "125",
      lastProcessedBlock: "124",
      lastProcessedHash: hash("a"),
      updatedAt: "2026-08-11T12:10:59.000Z",
      observedSafeHead: "124",
      observedAt: "2026-08-11T12:10:59.000Z",
      lastRunStatus: "bounded",
    },
    now,
  );
  assert.equal(bounded.status, "stale");
  assert.equal(bounded.reason, "indexer_not_caught_up");

  const unavailable = await http.handleMarketHealthRequest({
    marketMode: () => "live",
    database: async () => { throw new Error("offline"); },
  });
  assert.equal(unavailable.status, 503);
  assert.equal((await unavailable.json()).database.status, "unavailable");
});

test("live token SSR reads are cached briefly, deadline-bounded, and fail closed", async () => {
  const payload = await readModel.getLiveToken(
    databaseFor({ tokenRows: [liveTokenRow()] }),
    address("a"),
  );
  assert.ok(payload);
  let requestedAddress = null;
  const ready = await pageToken.loadLiveTokenPage(
    `0x${address("a").slice(2).toUpperCase()}`,
    {
      readToken: async (value) => {
        requestedAddress = value;
        return payload;
      },
      timeoutMs: 100,
    },
  );
  assert.equal(ready.status, "ready");
  assert.equal(requestedAddress, address("a"));
  assert.equal(pageToken.LIVE_TOKEN_PAGE_CACHE_SECONDS, 10);
  assert.ok(pageToken.LIVE_TOKEN_PAGE_TIMEOUT_MS <= 3_500);

  let invalidRead = false;
  assert.deepEqual(
    await pageToken.loadLiveTokenPage("pipe-dream", {
      readToken: async () => {
        invalidRead = true;
        return payload;
      },
    }),
    { status: "not_found" },
  );
  assert.equal(invalidRead, false);
  assert.deepEqual(
    await pageToken.loadLiveTokenPage(address("b"), {
      readToken: async () => { throw new Error("database offline"); },
      timeoutMs: 100,
    }),
    { status: "unavailable" },
  );
  assert.deepEqual(
    await pageToken.loadLiveTokenPage(address("c"), {
      readToken: async () => new Promise(() => {}),
      timeoutMs: 5,
    }),
    { status: "unavailable" },
  );
  await assert.rejects(
    pageToken.loadLiveTokenPage(address("d"), {
      readToken: async () => payload,
      timeoutMs: 10_001,
    }),
    /outside the supported range/,
  );
});

test("market mode is explicit, fixture-default, and invalid values fail closed", () => {
  assert.equal(mode.readMarketDataMode(undefined), "fixture");
  assert.equal(mode.readMarketDataMode("fixture"), "fixture");
  assert.equal(mode.readMarketDataMode("live"), "live");
  assert.throws(() => mode.readMarketDataMode("demo"), /fixture or live/);
});

test("MarketBoard has a guarded live-empty state and no demo fallback", () => {
  const board = readFileSync(resolve(root, "app/_components/MarketBoard.tsx"), "utf8");
  const page = readFileSync(resolve(root, "app/page.tsx"), "utf8");
  const layout = readFileSync(resolve(root, "app/layout.tsx"), "utf8");
  const shell = readFileSync(resolve(root, "app/_components/SiteShell.tsx"), "utf8");
  const provider = readFileSync(resolve(root, "app/_components/MarketDataProvider.tsx"), "utf8");
  const adapter = readFileSync(resolve(root, "app/_data/adapter.ts"), "utf8");
  const tokenPage = readFileSync(resolve(root, "app/token/[slug]/page.tsx"), "utf8");
  assert.match(board, /featured \? \(/);
  assert.match(board, /Fixture data was not substituted/);
  assert.match(board, /No fixture coins are shown in live mode/);
  assert.match(page, /<MarketBoard \/>/);
  assert.match(layout, /const marketMode = readMarketDataMode\(\)/);
  assert.match(layout, /<MarketDataProvider marketMode=\{marketMode\}>/);
  assert.match(provider, /marketMode === "fixture" \? fixtureBoardSource : null/);
  assert.match(shell, /tokens\.slice\(0, 16\)/);
  assert.match(shell, /Live feed unavailable/);
  assert.match(adapter, /mode === "live" \? createApiMarketAdapter\(\) : fixtureMarketAdapter/);
  assert.doesNotMatch(adapter, /catch[\s\S]{0,200}fixtureMarketAdapter/);
  assert.match(tokenPage, /export const dynamic = "force-dynamic"/);
  assert.match(tokenPage, /LiveTokenUnavailable/);
  assert.match(tokenPage, /No fixture token or estimated metric has been substituted/);
});
