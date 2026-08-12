import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const require = createRequire(import.meta.url);
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

function databaseFor({ tokenRows = [], watermarkRows = [] } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql === readModel.INDEXER_WATERMARK_SQL) return watermarkRows;
      return tokenRows;
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
  assert.deepEqual(tokenCall.params, [4663, "123", 7, address("a"), 11]);
  assert.match(tokenCall.sql, /\$1::bigint/);
  assert.match(tokenCall.sql, /\$5::integer/);
  assert.doesNotMatch(tokenCall.sql, new RegExp(address("a")));
  assert.equal(result.tokens[0].metrics.volume24hPipedog.value, "0");
  assert.equal(result.tokens[0].metrics.volume24hPipedog.status, "observed");
  assert.equal(result.tokens[0].metrics.marketCapUsd.status, "unavailable");
  assert.equal(result.tokens[0].metrics.marketCapUsd.value, null);
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

  const missing = await http.handleTokenDetailRequest(address("f"), {
    marketMode: () => "live",
    database: async () => databaseFor(),
  });
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get("cache-control"), "no-store");
});

test("missing DATABASE_URL fails closed through the production route boundary", async () => {
  const previous = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
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
    if (previous === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previous;
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

  const liveNotReady = await http.handleMarketHealthRequest({
    marketMode: () => "live",
    database: async () => databaseFor(),
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

test("live health reports DB and indexer readiness without claiming freshness", async () => {
  const ready = await http.handleMarketHealthRequest({
    marketMode: () => "live",
    database: async () =>
      databaseFor({
        watermarkRows: [
          {
            stream: "laypipe",
            next_block: "125",
            last_processed_block: "124",
            last_processed_hash: hash("a"),
            updated_at: "2026-08-11T12:10:00.000Z",
          },
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
  assert.equal(body.indexer.freshness, "not_assessed");
  assert.equal(body.indexer.cursor.lastProcessedBlock, "124");

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
