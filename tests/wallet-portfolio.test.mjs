import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const require = createRequire(import.meta.url);
const cid = await import("multiformats/cid");
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
    if (specifier === "multiformats/cid") return cid;
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

const readModel = loadTypeScript("lib/server/wallet/read-model.ts");
const http = loadTypeScript("lib/server/wallet/http.ts");
const authHttp = loadTypeScript("lib/server/auth/http.ts");
const claimModule = loadTypeScript("lib/web3/creator-claim-client.ts");
const viem = require("viem");
const address = (byte) => `0x${byte.repeat(40)}`;
const hash = (byte) => `0x${byte.repeat(64)}`;
const wallet = address("a");
const now = new Date().toISOString();

test("wallet portfolio sends its address in a no-store POST body, never the URL", () => {
  const component = readFileSync(resolve(root, "app/_components/WalletPortfolio.tsx"), "utf8");
  const route = readFileSync(resolve(root, "app/api/holdings/route.ts"), "utf8");
  assert.match(component, /fetch\("\/api\/holdings", \{[\s\S]*method: "POST"/);
  assert.match(component, /body: JSON\.stringify\(\{ wallet: requestedWallet, limit: 12, cursor \}\)/);
  assert.doesNotMatch(component, /\/api\/holdings\?/);
  assert.match(route, /export async function POST/);
  assert.doesNotMatch(route, /export async function GET/);
});

function watermarkRow(overrides = {}) {
  return {
    stream: "laypipe",
    next_block: "125",
    last_processed_block: "124",
    last_processed_hash: hash("b"),
    observed_safe_head: "124",
    observed_at: now,
    last_run_status: "caught-up",
    updated_at: now,
    ...overrides,
  };
}

function positionRow(overrides = {}) {
  return {
    token_address: address("c"),
    pool_id: hash("d"),
    name: "Pipe Pup",
    symbol: "PUP",
    logo_uri: null,
    approved_logo_cid: null,
    fee_mode: "creator",
    launched_at: now,
    block_number: "120",
    log_index: 4,
    creator_address: wallet,
    current_creator: wallet,
    wallet_balance: "1000000000000000000",
    launched_by_wallet: true,
    claimed_pipedog: "250000000000000000",
    burned_tokens: "0",
    ...overrides,
  };
}

function database(watermarks = [watermarkRow()], positions = [positionRow()]) {
  const calls = [];
  return {
    calls,
    query(sql, params) {
      calls.push({ sql, params });
      return Promise.resolve(
        sql === readModel.WALLET_WATERMARK_SQL ? watermarks : positions,
      );
    },
    async transaction(factory, options) {
      const tx = {
        query(sql, params) {
          calls.push({ sql, params });
          return Promise.resolve(
            sql === readModel.WALLET_WATERMARK_SQL ? watermarks : positions,
          );
        },
      };
      const queries = factory(tx);
      const result = await Promise.all(queries);
      calls.push({ options });
      return result;
    },
  };
}

test("wallet query is bounded and its signed cursor cannot cross wallets", () => {
  const parsed = readModel.parseWalletPortfolioRequest(
    { wallet, limit: 20 },
    "s".repeat(32),
  );
  assert.equal(parsed.wallet, wallet);
  assert.equal(parsed.limit, 20);
  assert.throws(
    () => readModel.parseWalletPortfolioRequest(
      { wallet, limit: 21 },
      "s".repeat(32),
    ),
    /between 1 and 20/,
  );
  const cursor = readModel.encodeWalletCursor(
    { wallet, blockNumber: "120", logIndex: 4, tokenAddress: address("c") },
    "s".repeat(32),
  );
  assert.throws(
    () => readModel.decodeWalletCursor(cursor, address("e"), "s".repeat(32)),
    /another wallet/,
  );
});

test("portfolio is a repeatable-read Neon snapshot with no server RPC fanout", async () => {
  const db = database();
  const result = await readModel.loadWalletPortfolio(
    db,
    { wallet, limit: 12, cursor: null },
    "s".repeat(32),
    { now: () => Date.parse(now) },
  );
  assert.equal(result.positions.length, 1);
  assert.equal(result.positions[0].balance, "1000000000000000000");
  assert.equal(result.positions[0].claimablePipedog.status, "unavailable");
  assert.match(result.positions[0].claimablePipedog.reason, /Connect a wallet/);
  assert.equal(result.onchainClaims.status, "unavailable");
  assert.equal(db.calls.length, 4);
  assert.equal(db.calls[0].sql, readModel.WALLET_WATERMARK_SQL);
  assert.match(db.calls[2].sql, /FROM token_holder_balance_state/);
  assert.match(db.calls[2].sql, /WITH watermark AS MATERIALIZED/);
  assert.match(db.calls[2].sql, /last_run_status = 'caught-up'/);
  assert.doesNotMatch(db.calls[2].sql, /latest_creator_updates/);
  assert.doesNotMatch(db.calls[2].sql, /eth_|rpc/i);
  assert.deepEqual(db.calls[3].options, {
    isolationLevel: "RepeatableRead",
    readOnly: true,
    deferrable: true,
    fetchOptions: { signal: db.calls[3].options.fetchOptions.signal },
  });
});

test("stale wallet freshness fails before the holder-state query opens", async () => {
  const db = database([watermarkRow({ observed_at: "2020-01-01T00:00:00.000Z" })]);
  await assert.rejects(
    readModel.loadWalletPortfolio(
      db,
      { wallet, limit: 12, cursor: null },
      "s".repeat(32),
      { now: () => Date.parse(now) },
    ),
    /stale/,
  );
  assert.equal(db.calls.length, 1);
  assert.equal(db.calls[0].sql, readModel.WALLET_WATERMARK_SQL);
});

test("HTTP gate rejects fixture mode and invalid wallet without opening Neon", async () => {
  let databaseCalls = 0;
  const request = (body) => new Request("https://laypipe.fun/api/holdings", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://laypipe.fun" },
    body: JSON.stringify(body),
  });
  const rateLimit = async () => undefined;
  const fixture = await http.handleWalletPortfolioRequest(
    request({ wallet }),
    {
      marketMode: () => "fixture",
      database: async () => { databaseCalls += 1; return database(); },
      cursorSecret: () => "s".repeat(32),
      rateLimit,
    },
  );
  assert.equal(fixture.status, 503);
  assert.equal(databaseCalls, 0);
  const invalid = await http.handleWalletPortfolioRequest(
    request({ wallet: "nope" }),
    {
      marketMode: () => "live",
      database: async () => { databaseCalls += 1; return database(); },
      cursorSecret: () => "s".repeat(32),
      rateLimit,
    },
  );
  assert.equal(invalid.status, 400);
  assert.equal(invalid.headers.get("cache-control"), "private, no-store, max-age=0");
  assert.equal(databaseCalls, 0);
});

test("HTTP gate rate-limits by IP before parsing and by IP-wallet before Neon", async () => {
  const rateLimitCalls = [];
  let databaseCalls = 0;
  const response = await http.handleWalletPortfolioRequest(
    new Request("https://laypipe.fun/api/holdings", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://laypipe.fun" },
      body: JSON.stringify({ wallet, limit: 12 }),
    }),
    {
      marketMode: () => "live",
      requestIp: () => "203.0.113.8",
      rateLimit: async (options) => { rateLimitCalls.push(options); },
      database: async () => { databaseCalls += 1; return database(); },
      cursorSecret: () => "s".repeat(32),
      now: () => Date.parse(now),
    },
  );
  assert.equal(response.status, 200);
  assert.equal(databaseCalls, 1);
  assert.deepEqual(
    rateLimitCalls.map(({ namespace, identity }) => ({ namespace, identity })),
    [
      { namespace: "wallet-portfolio-ip", identity: "203.0.113.8" },
      { namespace: "wallet-portfolio-ip-wallet", identity: `203.0.113.8\0${wallet}` },
    ],
  );
});

test("HTTP gate returns 429 without opening Neon when request protection rejects", async () => {
  let databaseCalls = 0;
  const response = await http.handleWalletPortfolioRequest(
    new Request("https://laypipe.fun/api/holdings", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://laypipe.fun" },
      body: JSON.stringify({ wallet }),
    }),
    {
      marketMode: () => "live",
      requestIp: () => "203.0.113.8",
      rateLimit: async () => {
        throw new authHttp.HttpError(429, "RATE_LIMITED", "Too many requests.");
      },
      database: async () => { databaseCalls += 1; return database(); },
      cursorSecret: () => "s".repeat(32),
    },
  );
  assert.equal(response.status, 429);
  assert.equal(databaseCalls, 0);
  assert.equal((await response.json()).error.code, "rate_limited");
});

test("HTTP gate rejects originless wallet reads before Upstash or Neon", async () => {
  let rateLimitCalls = 0;
  let databaseCalls = 0;
  const response = await http.handleWalletPortfolioRequest(
    new Request("https://laypipe.fun/api/holdings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ wallet }),
    }),
    {
      marketMode: () => "live",
      rateLimit: async () => { rateLimitCalls += 1; },
      database: async () => { databaseCalls += 1; return database(); },
      cursorSecret: () => "s".repeat(32),
    },
  );
  assert.equal(response.status, 403);
  assert.equal(rateLimitCalls, 0);
  assert.equal(databaseCalls, 0);
});

test("creator claim re-verifies eligibility and the audited deployment before sending", async () => {
  const hook = address("f");
  const poolId = hash("d");
  const calls = [];
  let verifyCount = 0;
  const abi = viem.parseAbi([
    "function pending(bytes32 poolId) view returns (uint256)",
    "function tab(bytes32 poolId) view returns (uint256)",
    "function poolConfigs(bytes32 poolId) view returns (address creator, uint40 launchTime, uint16 creatorFeeBps, uint24 baseFeeRate, uint24 launchFeeRate, uint32 launchFeeDecay, bool exists)",
  ]);
  const provider = {
    async request(args) {
      calls.push(args);
      if (args.method === "eth_accounts") return [wallet];
      if (args.method === "eth_chainId") return "0x1237";
      if (args.method === "eth_estimateGas") return "0x5208";
      if (args.method === "eth_sendTransaction") return hash("9");
      if (args.method === "eth_call") {
        const data = args.params[0].data;
        if (data.startsWith(viem.toFunctionSelector("poolConfigs(bytes32)"))) {
          return viem.encodeFunctionResult({
            abi,
            functionName: "poolConfigs",
            result: [wallet, 1, 2500, 1000, 1000, 0, true],
          });
        }
        if (data.startsWith(viem.toFunctionSelector("pending(bytes32)"))) {
          return viem.encodeFunctionResult({ abi, functionName: "pending", result: 400n });
        }
        return viem.encodeFunctionResult({ abi, functionName: "tab", result: 100n });
      }
      throw new Error(`Unexpected ${args.method}`);
    },
  };
  const verify = async () => {
    verifyCount += 1;
    return { blockNumber: 124n, blockTag: "0x7c" };
  };
  const client = new claimModule.CreatorClaimClient(
    provider,
    { contracts: { hook: { address: hook } } },
    verify,
  );
  const submitted = await client.claim(wallet, poolId);
  assert.equal(submitted.observedClaimable, 200n);
  assert.equal(verifyCount, 2);
  const estimateIndex = calls.findIndex((call) => call.method === "eth_estimateGas");
  const sendIndex = calls.findIndex((call) => call.method === "eth_sendTransaction");
  assert.ok(estimateIndex > -1 && sendIndex > estimateIndex);
  const transaction = calls[sendIndex].params[0];
  assert.equal(transaction.from, wallet);
  assert.equal(transaction.to, hook);
  assert.equal(transaction.value, undefined);
  assert.equal(
    transaction.data,
    viem.encodeFunctionData({
      abi: viem.parseAbi(["function claim(bytes32 poolId) returns (uint256 amount)"]),
      functionName: "claim",
      args: [poolId],
    }),
  );
});
