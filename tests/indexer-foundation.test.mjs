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

const model = loadTypeScript("lib/server/indexer/model.ts");
const reorg = loadTypeScript("lib/server/indexer/reorg.ts");
const migrationPlan = loadTypeScript("scripts/indexer/migration-plan.ts");

const hash = (byte) => `0x${byte.repeat(64)}`;
const address = (byte) => `0x${byte.repeat(40)}`;

test("canonical batches require contiguous hashes and unique log identities", () => {
  const batch = model.normalizeCanonicalBatch({
    chainId: 4663,
    stream: "laypipe",
    expectedNextBlock: 100n,
    blocks: [
      { number: 100n, hash: hash("a"), parentHash: hash("9"), timestamp: "2026-08-11T00:00:00Z" },
      { number: 101n, hash: hash("b"), parentHash: hash("a"), timestamp: "2026-08-11T00:00:01Z" },
    ],
    logs: [
      {
        blockNumber: 101n,
        transactionHash: hash("c"),
        transactionIndex: 0,
        logIndex: 1,
        contractAddress: address("d"),
        topics: [hash("e")],
        data: "0x",
        decodedArgs: { amount: 12n },
      },
    ],
  });
  assert.equal(batch.blocks[1].parentHash, batch.blocks[0].hash);
  assert.equal(batch.logs[0].decodedArgs.amount, "12");

  assert.throws(
    () =>
      model.normalizeCanonicalBatch({
        chainId: 4663,
        stream: "laypipe",
        expectedNextBlock: 100n,
        blocks: [
          { number: 100n, hash: hash("a"), parentHash: hash("9"), timestamp: "2026-08-11T00:00:00Z" },
          { number: 101n, hash: hash("b"), parentHash: hash("8"), timestamp: "2026-08-11T00:00:01Z" },
        ],
        logs: [],
      }),
    /parent hash/,
  );
});

test("uint256 normalization preserves exact base units and rejects overflow", () => {
  const max = (1n << 256n) - 1n;
  assert.equal(model.normalizeUint256(max), max.toString());
  assert.throws(() => model.normalizeUint256(max + 1n), /outside uint256/);
  assert.throws(() => model.normalizeUint256("01"), /canonical base-10/);
  assert.throws(() => model.normalizeUint256("1.1"), /canonical base-10/);
});

test("reorg search returns only an RPC-confirmed common ancestor", async () => {
  const stored = [
    { number: 12n, hash: hash("c") },
    { number: 11n, hash: hash("b") },
    { number: 10n, hash: hash("a") },
  ];
  const canonical = new Map([
    ["12", hash("f")],
    ["11", hash("e")],
    ["10", hash("a")],
  ]);
  assert.deepEqual(
    await reorg.findCommonAncestor(stored, async (number) => canonical.get(number) ?? null),
    { number: "10", hash: hash("a") },
  );
  await assert.rejects(
    reorg.findCommonAncestor([...stored].reverse(), async () => hash("f")),
    /newest-first/,
  );
});

test("migration encodes idempotency, reorg cascades, numeric safety, and cursor CAS", () => {
  const sql = readFileSync(resolve(root, "db/migrations/0000_production_read_model.sql"), "utf8");
  assert.match(sql, /PRIMARY KEY \(chain_id, transaction_hash, log_index\)/);
  assert.match(sql, /numeric\(78, 0\)/);
  assert.match(sql, /ON DELETE CASCADE/);
  assert.match(sql, /laypipe_reject_changed_immutable_row/);
  assert.match(sql, /laypipe_advance_cursor/);
  assert.match(sql, /laypipe_rollback_chain/);
  assert.match(sql, /CREATE VIEW token_balances/);
  assert.match(sql, /CREATE TABLE token_holder_balance_state/);
  assert.match(sql, /PRIMARY KEY \(chain_id, holder_address, token_address\)/);
  assert.match(sql, /REFERENCING NEW TABLE AS new_token_transfers/);
  assert.match(sql, /REFERENCING OLD TABLE AS old_token_transfers/);
  assert.match(sql, /CREATE INDEX admin_events_creator_pool_idx/);
  assert.match(sql, /CREATE INDEX admin_events_creator_subject_idx/);
  assert.match(
    sql,
    /CREATE INDEX launches_market_page_idx[\s\S]*token_address DESC/,
  );
  assert.match(
    sql,
    /CREATE INDEX swaps_pool_market_metrics_idx[\s\S]*block_timestamp DESC[\s\S]*WHERE token_amount > 0/,
  );
  assert.match(sql, /observed_safe_head bigint/);
  assert.match(sql, /last_run_status text/);
  assert.match(sql, /CREATE TRIGGER indexer_cursor_observation_guard/);
  assert.match(sql, /observed safe head is behind the indexer cursor/);
  assert.match(
    sql,
    /laypipe_rollback_chain[\s\S]*observed_safe_head = NULL[\s\S]*last_run_status = NULL/,
  );
  assert.match(sql, /CREATE TABLE pool_market_totals/);
  assert.match(sql, /CREATE TRIGGER swaps_market_totals_delete/);
  assert.match(
    sql,
    /fee_kind = 'creator-claimed'[\s\S]*recipient_address = creator_address/,
  );
});

test("market leaders are bounded, caught-up snapshots tied to canonical blocks", () => {
  const sql = readFileSync(
    resolve(root, "db/migrations/0002_market_leader_snapshot.sql"),
    "utf8",
  );
  assert.match(sql, /CREATE TABLE market_leader_snapshots/);
  assert.match(sql, /CREATE TABLE market_leader_entries/);
  assert.match(sql, /PRIMARY KEY \(chain_id, leader_kind\)/);
  assert.match(sql, /'most-traded', 'newest', 'biggest-mover'/);
  assert.match(
    sql,
    /FOREIGN KEY \(chain_id, snapshot_block, snapshot_hash\)[\s\S]*chain_blocks[\s\S]*ON DELETE CASCADE/,
  );
  assert.match(sql, /CREATE INDEX swaps_market_window_idx/);
  assert.match(sql, /NEW\.stream <> 'laypipe'/);
  assert.match(sql, /NEW\.last_run_status <> 'caught-up'/);
  assert.match(sql, /prior_refresh > refresh_time - interval '1 minute'/);
  assert.match(sql, /counts\.trades_24h >= 2/);
  assert.match(sql, /score\.change_numerator > 0/);
  assert.match(sql, /t\.trades_24h DESC, t\.volume_24h_pipedog DESC/);
  assert.match(sql, /AFTER UPDATE OF observed_safe_head, observed_at, last_run_status/);

  const statements = migrationPlan.migrationStatements(sql);
  assert.ok(statements.length > 1);
  for (const statement of statements) {
    const topLevelCommands = statement
      .split(/\r?\n/)
      .filter((line) => /^(?:CREATE\b|REVOKE\b|DO\b)/.test(line));
    assert.equal(
      topLevelCommands.length,
      1,
      `leader migration chunk contains multiple top-level commands: ${topLevelCommands.join(", ")}`,
    );
  }
});

test("migration chunks are single statements and discovery is rechecked behind the lock", () => {
  const sql = readFileSync(resolve(root, "db/migrations/0000_production_read_model.sql"), "utf8");
  const statements = migrationPlan.migrationStatements(sql);
  assert.ok(statements.length > 1);
  for (const statement of statements) {
    const topLevelCommands = statement
      .split(/\r?\n/)
      .filter((line) => /^(?:CREATE\b|DO\b)/.test(line));
    assert.equal(
      topLevelCommands.length,
      1,
      `migration chunk contains multiple top-level commands: ${topLevelCommands.join(", ")}`,
    );
  }

  const command = migrationPlan.buildMigrationCommand({
    name: "0000_test.sql",
    sha256: "f".repeat(64),
    statements: ["CREATE TABLE migration_test (id bigint PRIMARY KEY)"],
  });
  const lock = command.indexOf("pg_advisory_xact_lock");
  const ledgerCreation = command.indexOf("CREATE TABLE IF NOT EXISTS laypipe_schema_migrations");
  const ledgerCheck = command.indexOf("SELECT ledger.sha256 INTO prior_hash");
  const schemaChange = command.indexOf("CREATE TABLE migration_test");
  const ledgerWrite = command.indexOf("INSERT INTO laypipe_schema_migrations");
  assert.ok(lock >= 0 && lock < ledgerCreation);
  assert.ok(ledgerCreation < ledgerCheck);
  assert.ok(ledgerCheck < schemaChange);
  assert.ok(schemaChange < ledgerWrite);
  assert.match(command, /IF prior_hash IS NOT NULL THEN[\s\S]*RETURN;/);
});
