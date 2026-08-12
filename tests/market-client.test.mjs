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
    if (!specifier.startsWith(".") && !specifier.startsWith("@/")) {
      return require(specifier);
    }
    const unresolved = specifier.startsWith("@/")
      ? resolve(root, specifier.slice(2))
      : resolve(dirname(filename), specifier);
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

const pagination = loadTypeScript("lib/market/pagination.ts");
const adapter = loadTypeScript("app/_data/adapter.ts");
const exactNumbers = loadTypeScript("lib/market/exact-numbers.ts");
const marketFormat = loadTypeScript("app/_components/market-format.ts");
const UINT256_MAX = ((BigInt(1) << BigInt(256)) - BigInt(1)).toString();

function liveToken(tokenAddress = `0x${"a".repeat(40)}`) {
  return {
    source: "live",
    chainId: 4663,
    slug: tokenAddress,
    tokenAddress,
    poolId: `0x${"b".repeat(64)}`,
    creatorAddress: `0x${"c".repeat(40)}`,
    hookAddress: `0x${"d".repeat(40)}`,
    feeRecipientAddress: `0x${"e".repeat(40)}`,
    feeMode: "creator",
    configId: "1",
    firstBuyPipedogIn: "1000000000000000000",
    firstBuyTokenOut: "2000000000000000000",
    name: "Cursor Dog",
    symbol: "CURSOR",
    description: null,
    logoUri: null,
    logoGatewayUrl: null,
    metadataUri: null,
    socials: null,
    blockNumber: "123",
    launchedAt: "2026-08-11T12:00:00.000Z",
    lastTradeAt: null,
    metrics: {
      lastPricePipedog: {
        status: "observed",
        value: {
          pipedogAmount: "1000000000000000000",
          tokenAmount: "2000000000000000000",
        },
        basis: "test",
      },
      baselinePrice24hPipedog: {
        status: "unavailable",
        value: null,
        reason: "test",
      },
      volume24hPipedog: {
        status: "observed",
        value: "3000000000000000000",
        basis: "test",
      },
      trades24h: { status: "observed", value: 1, basis: "test" },
      totalTrades: { status: "observed", value: 2, basis: "test" },
      marketCapUsd: { status: "unavailable", value: null, reason: "test" },
      liquidityUsd: { status: "unavailable", value: null, reason: "test" },
      holders: { status: "unavailable", value: null, reason: "test" },
    },
  };
}

test("market polling uses bounded exponential backoff", () => {
  assert.equal(pagination.marketPollDelay(0), 15_000);
  assert.equal(pagination.marketPollDelay(1), 30_000);
  assert.equal(pagination.marketPollDelay(2), 60_000);
  assert.equal(pagination.marketPollDelay(3), 120_000);
  assert.equal(pagination.marketPollDelay(20), 120_000);
  assert.throws(() => pagination.marketPollDelay(-1), /error count is invalid/);
});

test("loaded market pages are periodically revalidated as one bounded chain", () => {
  assert.equal(
    pagination.shouldRevalidateLoadedMarketPages(1, 120_000),
    false,
  );
  assert.equal(
    pagination.shouldRevalidateLoadedMarketPages(2, 59_999),
    false,
  );
  assert.equal(
    pagination.shouldRevalidateLoadedMarketPages(2, 60_000),
    true,
  );
  assert.throws(
    () => pagination.shouldRevalidateLoadedMarketPages(0, 60_000),
    /revalidation state is invalid/,
  );
});

test("market page URLs carry validated keyset cursors", () => {
  assert.equal(
    pagination.buildTokenListUrl("/api/tokens", {
      cursor: "cursor_1",
      limit: 50,
    }),
    "/api/tokens?limit=50&cursor=cursor_1",
  );
  assert.throws(
    () => pagination.buildTokenListUrl("/api/tokens", { cursor: "not valid" }),
    /cursor is malformed/,
  );
  assert.throws(
    () => pagination.buildTokenListUrl("/api/tokens", { limit: 51 }),
    /between 1 and 50/,
  );
});

test("market pages merge in order without duplicate launches", () => {
  const merged = pagination.mergeMarketPages(
    [{ slug: "new" }, { slug: "shared" }],
    [{ slug: "shared" }, { slug: "old" }],
    (token) => token.slug,
  );
  assert.deepEqual(merged.map((token) => token.slug), ["new", "shared", "old"]);
});

test("first-page refresh discovers a cursor until older pages are loaded", () => {
  assert.equal(
    pagination.cursorAfterFirstPageRefresh(null, "new_cursor", false),
    "new_cursor",
  );
  assert.equal(
    pagination.cursorAfterFirstPageRefresh("deep_cursor", "new_cursor", true),
    "deep_cursor",
  );
  assert.equal(
    pagination.cursorAfterFirstPageRefresh(null, "late_cursor", false),
    "late_cursor",
    "an initially empty feed can expose pagination after it grows",
  );
});

test("live adapter requests and returns the server keyset cursor", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (input, init) => {
    requests.push({ input: String(input), init });
    return new Response(JSON.stringify({
      source: "live",
      chainId: 4663,
      tokens: [liveToken()],
      leaders: {
        mostTraded: liveToken(),
        newest: null,
        biggestMover: liveToken(),
      },
      page: { limit: 50, nextCursor: "cursor_2" },
      indexer: null,
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const result = await adapter
      .createApiMarketAdapter("https://laypipe.fun")
      .listTokens({ cursor: "cursor_1", limit: 50 });
    assert.equal(
      requests[0].input,
      "https://laypipe.fun/api/tokens?limit=50&cursor=cursor_1",
    );
    assert.equal(result.nextCursor, "cursor_2");
    assert.equal(result.tokens[0].source, "live");
    assert.equal(result.leaders.mostTraded.source, "live");
    assert.equal(result.leaders.newest, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("live adapter accepts only canonical Pinata artwork URLs", () => {
  const cid = "bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku";
  const trusted = adapter.mapLiveTokenToBoardToken({
    ...liveToken(),
    logoGatewayUrl: `https://laypipe.mypinata.cloud/ipfs/${cid}`,
  });
  assert.equal(trusted.artworkUrl, `https://laypipe.mypinata.cloud/ipfs/${cid}`);
  const rejected = adapter.mapLiveTokenToBoardToken({
    ...liveToken(),
    logoGatewayUrl: `https://attacker.example/ipfs/${cid}`,
  });
  assert.equal(rejected.artworkUrl, null);
});

test("live market metrics preserve extreme uint256 values without overflow or underflow", () => {
  const maximum = adapter.mapLiveTokenToBoardToken({
    ...liveToken(),
    metrics: {
      ...liveToken().metrics,
      lastPricePipedog: {
        status: "observed",
        value: { pipedogAmount: UINT256_MAX, tokenAmount: "1" },
        basis: "test",
      },
      volume24hPipedog: {
        status: "observed",
        value: UINT256_MAX,
        basis: "test",
      },
    },
  });
  assert.deepEqual(maximum.price, {
    pipedogAmount: UINT256_MAX,
    tokenAmount: "1",
  });
  assert.equal(maximum.volume24h, UINT256_MAX);
  assert.equal(
    marketFormat.formatTokenPrice(maximum),
    "1.15792e+77 PIPEDOG",
  );
  assert.equal(
    marketFormat.formatTokenVolume(maximum),
    "1.158e+59 PIPEDOG",
  );

  const tiny = adapter.mapLiveTokenToBoardToken({
    ...liveToken(),
    metrics: {
      ...liveToken().metrics,
      lastPricePipedog: {
        status: "observed",
        value: { pipedogAmount: "1", tokenAmount: UINT256_MAX },
        basis: "test",
      },
      volume24hPipedog: {
        status: "observed",
        value: "1",
        basis: "test",
      },
    },
  });
  assert.equal(
    marketFormat.formatTokenPrice(tiny),
    "8.63617e-78 PIPEDOG",
  );
  assert.equal(marketFormat.formatTokenVolume(tiny), "1e-18 PIPEDOG");
});

test("live volume and percentage comparisons retain exact ordering", () => {
  const lowerVolume = adapter.mapLiveTokenToBoardToken({
    ...liveToken(`0x${"1".repeat(40)}`),
    metrics: {
      ...liveToken().metrics,
      lastPricePipedog: {
        status: "observed",
        value: {
          pipedogAmount: UINT256_MAX,
          tokenAmount: (BigInt(UINT256_MAX) - BigInt(1)).toString(),
        },
        basis: "test",
      },
      baselinePrice24hPipedog: {
        status: "observed",
        value: { pipedogAmount: "1", tokenAmount: "1" },
        basis: "test",
      },
      volume24hPipedog: {
        status: "observed",
        value: (BigInt(UINT256_MAX) - BigInt(1)).toString(),
        basis: "test",
      },
      trades24h: { status: "observed", value: 2, basis: "test" },
    },
  });
  const higherVolumeAndChange = adapter.mapLiveTokenToBoardToken({
    ...liveToken(`0x${"2".repeat(40)}`),
    metrics: {
      ...liveToken().metrics,
      lastPricePipedog: {
        status: "observed",
        value: {
          pipedogAmount: UINT256_MAX,
          tokenAmount: (BigInt(UINT256_MAX) - BigInt(2)).toString(),
        },
        basis: "test",
      },
      baselinePrice24hPipedog: {
        status: "observed",
        value: { pipedogAmount: "1", tokenAmount: "1" },
        basis: "test",
      },
      volume24hPipedog: {
        status: "observed",
        value: UINT256_MAX,
        basis: "test",
      },
      trades24h: { status: "observed", value: 2, basis: "test" },
    },
  });

  assert.equal(
    marketFormat.compareTokenVolumes(higherVolumeAndChange, lowerVolume),
    1,
  );
  assert.equal(
    marketFormat.compareTokenChanges(higherVolumeAndChange, lowerVolume),
    1,
  );
  assert.equal(marketFormat.formatTokenChange(lowerVolume), "+<0.1%");
});

test("exact percentage formatting stays bounded at uint256 ratio extremes", () => {
  const change = exactNumbers.exactPercentChange(
    { pipedogAmount: UINT256_MAX, tokenAmount: "1" },
    { pipedogAmount: "1", tokenAmount: UINT256_MAX },
  );
  assert.ok(change);
  assert.equal(exactNumbers.exactPercentChangeDirection(change), 1);
  assert.equal(exactNumbers.formatExactPercentChange(change), "+1.341e+156%");
});

test("zero price baseline makes live percentage change unavailable", () => {
  const board = adapter.mapLiveTokenToBoardToken({
    ...liveToken(),
    metrics: {
      ...liveToken().metrics,
      baselinePrice24hPipedog: {
        status: "observed",
        value: { pipedogAmount: "0", tokenAmount: "1" },
        basis: "test",
      },
      trades24h: { status: "observed", value: 2, basis: "test" },
    },
  });
  assert.equal(board.change24h, null);
  assert.equal(marketFormat.formatTokenChange(board), "Unavailable");
  assert.equal(marketFormat.tokenChangeDirection(board), null);
});

test("fixture market formatting and numeric fields remain unchanged", () => {
  const fixture = adapter.fixtureBoardSource.tokens[0];
  assert.equal(typeof fixture.price, "number");
  assert.equal(typeof fixture.volume24h, "number");
  assert.equal(typeof fixture.change24h, "number");
  assert.equal(marketFormat.formatTokenPrice(fixture), "$0.000184");
  assert.equal(marketFormat.formatTokenVolume(fixture), "$42.6K");
  assert.equal(marketFormat.formatTokenChange(fixture), "+38.4%");
  assert.equal(adapter.fixtureBoardSource.leaders.mostTraded.slug, "pipe-dream");
  assert.equal(adapter.fixtureBoardSource.leaders.newest.slug, "leaky-alpha");
  assert.equal(adapter.fixtureBoardSource.leaders.biggestMover.slug, "pipe-dream");
});

test("live metric payloads allow bounded aggregates above uint256 and reject malformed exact values", () => {
  const aboveUint256 = (BigInt(UINT256_MAX) + BigInt(1)).toString();
  const aggregate = adapter.mapLiveTokenToBoardToken({
    ...liveToken(),
    metrics: {
      ...liveToken().metrics,
      volume24hPipedog: {
        status: "observed",
        value: aboveUint256,
        basis: "test",
      },
    },
  });
  assert.equal(aggregate.volume24h, aboveUint256);
  assert.throws(
    () => adapter.mapLiveTokenToBoardToken({
      ...liveToken(),
      metrics: {
        ...liveToken().metrics,
        volume24hPipedog: {
          status: "observed",
          value: `1${"0".repeat(156)}`,
          basis: "test",
        },
      },
    }),
    /volume is invalid/i,
  );
  assert.throws(
    () => adapter.mapLiveTokenToBoardToken({
      ...liveToken(),
      metrics: {
        ...liveToken().metrics,
        lastPricePipedog: {
          status: "observed",
          value: { pipedogAmount: "1", tokenAmount: "0" },
          basis: "test",
        },
      },
    }),
    /token amount is invalid/i,
  );
  assert.throws(
    () => adapter.mapLiveTokenToBoardToken({
      ...liveToken(),
      metrics: {
        ...liveToken().metrics,
        lastPricePipedog: {
          status: "observed",
          value: { pipedogAmount: "01", tokenAmount: "1" },
          basis: "test",
        },
      },
    }),
    /PIPEDOG amount is invalid/i,
  );
  assert.throws(
    () => adapter.mapLiveTokenToBoardToken({
      ...liveToken(),
      metrics: {
        ...liveToken().metrics,
        trades24h: {
          status: "observed",
          value: Number.MAX_SAFE_INTEGER + 1,
          basis: "test",
        },
      },
    }),
    /trade count is invalid/i,
  );
});

test("Board, marquee, and token detail render through exact live helpers", () => {
  const board = readFileSync(resolve(root, "app/_components/MarketBoard.tsx"), "utf8");
  const shell = readFileSync(resolve(root, "app/_components/SiteShell.tsx"), "utf8");
  const detail = readFileSync(resolve(root, "app/token/[slug]/page.tsx"), "utf8");
  const adapterSource = readFileSync(resolve(root, "app/_data/adapter.ts"), "utf8");

  assert.match(board, /compareTokenVolumes\(b, a\)/);
  assert.match(board, /compareTokenChanges\(b, a\)/);
  assert.match(board, /formatTokenPrice\(token\)/);
  assert.match(shell, /formatTokenChange\(token\)/);
  assert.match(detail, /formatTokenVolume\(token\)/);
  assert.doesNotMatch(adapterSource, /Number\(value\.pipedogAmount\)/);
  assert.doesNotMatch(adapterSource, /Number\(value\.tokenAmount\)/);
  assert.doesNotMatch(adapterSource, /Number\(token\.metrics\.volume24hPipedog/);
});

test("shared provider owns polling, visibility pause, and pagination", () => {
  const provider = readFileSync(
    resolve(root, "app/_components/MarketDataProvider.tsx"),
    "utf8",
  );
  const shell = readFileSync(resolve(root, "app/_components/SiteShell.tsx"), "utf8");
  const board = readFileSync(resolve(root, "app/_components/MarketBoard.tsx"), "utf8");
  const layout = readFileSync(resolve(root, "app/layout.tsx"), "utf8");

  assert.match(layout, /<MarketDataProvider marketMode=\{marketMode\}>/);
  assert.match(shell, /useMarketData\(\)/);
  assert.match(board, /useMarketData\(\)/);
  assert.doesNotMatch(shell, /listTokens\(|setInterval\(/);
  assert.doesNotMatch(board, /listTokens\(/);
  assert.match(provider, /document\.hidden/);
  assert.match(provider, /visibilitychange/);
  assert.match(provider, /marketPollDelay\(consecutiveErrors\)/);
  assert.match(provider, /cursor,/);
  assert.match(provider, /result\.nextCursor/);
  assert.match(provider, /hasLoadedOlderPages/);
  assert.match(provider, /loadedPageCount/);
  assert.match(provider, /shouldRevalidateLoadedMarketPages/);
  assert.match(provider, /while \([\s\S]{0,160}refreshedPageCount < targetPageCount/);
  assert.doesNotMatch(provider, /setInterval\(/);
  assert.doesNotMatch(provider, /fixtureMarketAdapter/);
});
