import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const enabled = process.env.LAYPIPE_RUN_POSTGRES_INTEGRATION === "1";
const postgresImage = process.env.LAYPIPE_POSTGRES_IMAGE ?? "postgres:16-alpine";
const moduleCache = new Map();

function loadTypeScript(relativePath) {
  const filename = resolve(root, relativePath);
  if (moduleCache.has(filename)) return moduleCache.get(filename).exports;
  const loaded = { exports: {} };
  moduleCache.set(filename, loaded);
  const output = ts.transpileModule(readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: filename,
  }).outputText;
  const localRequire = (specifier) => {
    if (!specifier.startsWith(".") && !specifier.startsWith("@/")) return require(specifier);
    const unresolved = specifier.startsWith("@/")
      ? resolve(root, specifier.slice(2))
      : resolve(dirname(filename), specifier);
    const dependency = extname(unresolved) ? unresolved : `${unresolved}.ts`;
    return loadTypeScript(dependency.slice(root.length + 1));
  };
  new Function("require", "module", "exports", "__filename", "__dirname", output)(
    localRequire, loaded, loaded.exports, filename, dirname(filename),
  );
  return loaded.exports;
}

function run(command, args, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: root,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", rejectPromise);
    child.once("close", (code) => {
      const result = { code, stdout: stdout.trim(), stderr: stderr.trim() };
      if (code === 0 || options.allowFailure) return resolvePromise(result);
      rejectPromise(new Error(`${command} exited with code ${code}:\n${stderr || stdout}`));
    });
    child.stdin.end(options.input ?? "");
  });
}

const docker = (args, options) => run("docker", args, options);

async function psql(container, sql, { role, allowFailure = false } = {}) {
  const args = [
    "exec", "-i", container, "psql", "-X", "-qAt", "-v", "ON_ERROR_STOP=1",
    "-U", role ?? "postgres", "-d", "laypipe_test",
  ];
  try {
    return await docker(args, { input: sql, allowFailure });
  } catch (error) {
    error.message += `\nSQL probe: ${sql.trim().slice(0, 180)}`;
    throw error;
  }
}

async function runtimeIdentity(container, role, group) {
  const attestation = databaseSecurity.RUNTIME_DATABASE_ATTESTATION_SQL
    .replaceAll("$1", `'${group}'`);
  const result = await psql(
    container,
    `SELECT row_to_json(identity)::text FROM (${attestation}) identity;`,
    { role },
  );
  return JSON.parse(result.stdout);
}

const plan = loadTypeScript("scripts/indexer/runtime-grants-plan.ts");
const databaseSecurity = loadTypeScript("lib/server/db/neon.ts");
const runtimeWrapperCapabilities = [
  {
    field: "can_execute_initialize_cursor",
    signature: "public.laypipe_runtime_initialize_cursor(bigint,text,bigint)",
  },
  {
    field: "can_execute_advance_cursor",
    signature: "public.laypipe_runtime_advance_cursor(bigint,text,bigint,bigint,evm_bytes32)",
  },
  {
    field: "can_execute_record_observation",
    signature: "public.laypipe_runtime_record_observation(bigint,text,bigint,timestamp with time zone,text)",
  },
  {
    field: "can_execute_rollback",
    signature: "public.laypipe_runtime_rollback_chain(bigint,bigint,evm_bytes32)",
  },
];

test("runtime grant identifiers reject injection and reserved PostgreSQL roles", () => {
  for (const value of ["LayPipe", "laypipe-read", "pg_read_all_data", "reader;drop role x", ""]) {
    assert.throws(() => plan.validateRoleIdentifier(value, "TEST_ROLE"));
  }
  assert.equal(plan.validateRoleIdentifier("laypipe_runtime_read", "TEST_ROLE"), "laypipe_runtime_read");
  assert.throws(() => plan.buildRuntimeGrantsSql({
    readRole: "laypipe_runtime",
    writeRole: "laypipe_runtime",
    serviceRole: "laypipe_runtime_service",
  }));
  const sql = plan.buildRuntimeGrantsSql({
    readRole: "laypipe_runtime_read",
    writeRole: "laypipe_runtime_write",
    serviceRole: "laypipe_runtime_service",
  });
  assert.match(
    sql,
    /GRANT EXECUTE ON FUNCTION laypipe_refresh_market_leaders\(\) TO "laypipe_runtime_service"/,
  );
  assert.match(
    sql,
    /REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC, "laypipe_runtime_read", "laypipe_runtime_write"/,
  );
});

test("separate runtime roles enforce exact LayPipe database privileges", {
  skip: !enabled && "Set LAYPIPE_RUN_POSTGRES_INTEGRATION=1 to run PostgreSQL privilege proof.",
  timeout: 120_000,
}, async () => {
  const container = `laypipe-privileges-${randomBytes(6).toString("hex")}`;
  try {
    await docker([
      "run", "--detach", "--name", container, "--network", "none",
      "--label", "laypipe.disposable=true", "--env", "POSTGRES_PASSWORD=laypipe-test-only",
      "--env", "POSTGRES_DB=laypipe_test", postgresImage,
    ]);
    let ready = false;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      // pg_isready can succeed before the entrypoint has created POSTGRES_DB.
      // Probe the database itself to make this gate reliable under CI load.
      const result = await psql(container, "SELECT 1;", { allowFailure: true });
      if (result.code === 0) { ready = true; break; }
      await delay(250);
    }
    assert.equal(ready, true, "PostgreSQL did not become ready.");

    await psql(container, `
CREATE ROLE laypipe_migration_owner LOGIN CREATEROLE;
ALTER DATABASE laypipe_test OWNER TO laypipe_migration_owner;
ALTER SCHEMA public OWNER TO laypipe_migration_owner;
`);

    for (const name of [
      "0000_production_read_model.sql",
      "0001_runtime_security.sql",
      "0002_market_leader_snapshot.sql",
      "0003_market_baseline_semantics.sql",
    ]) {
      const migration = readFileSync(resolve(root, "db/migrations", name), "utf8")
        .split(/^\s*--> statement-breakpoint\s*$/gm).map((value) => value.trim()).filter(Boolean)
        .join(";\n");
      await psql(container, `${migration};`, { role: "laypipe_migration_owner" });
    }
    await psql(container, "CREATE ROLE laypipe_untrusted_login LOGIN;", {
      role: "laypipe_migration_owner",
    });
    const migrationOnlyExecute = await psql(container, `
SELECT
  has_function_privilege(
    'laypipe_untrusted_login',
    'laypipe_runtime_initialize_cursor(bigint,text,bigint)',
    'EXECUTE'
  ),
  has_function_privilege(
    'laypipe_untrusted_login',
    'laypipe_runtime_rollback_chain(bigint,bigint,evm_bytes32)',
    'EXECUTE'
  ),
  has_function_privilege(
    'laypipe_untrusted_login',
    'laypipe_refresh_market_leaders()',
    'EXECUTE'
  );
`);
    assert.equal(migrationOnlyExecute.stdout, "f|f|f");
    const migrationOnlyCall = await psql(
      container,
      "SELECT laypipe_runtime_initialize_cursor(4663, 'public-exec-probe', 42);",
      { role: "laypipe_untrusted_login", allowFailure: true },
    );
    assert.notEqual(migrationOnlyCall.code, 0);
    assert.match(migrationOnlyCall.stderr, /permission denied for function/);
    const publicCursor = await psql(
      container,
      "SELECT count(*) FROM indexer_cursors WHERE stream = 'public-exec-probe';",
      { role: "laypipe_migration_owner" },
    );
    assert.equal(publicCursor.stdout, "0");
    await psql(container, `
CREATE TABLE laypipe_schema_migrations (
  name text PRIMARY KEY,
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  applied_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO laypipe_schema_migrations (name, sha256) VALUES
  ('0000_production_read_model.sql', '${"a".repeat(64)}'),
  ('0001_runtime_security.sql', '${"b".repeat(64)}'),
  ('0002_market_leader_snapshot.sql', '${"c".repeat(64)}'),
  ('0003_market_baseline_semantics.sql', '${"d".repeat(64)}');
`, { role: "laypipe_migration_owner" });
    await psql(container, `
CREATE ROLE laypipe_runtime_read NOLOGIN;
CREATE ROLE laypipe_runtime_write NOLOGIN;
CREATE ROLE laypipe_runtime_service NOLOGIN;
CREATE ROLE laypipe_read_login LOGIN PASSWORD 'read-test-only' IN ROLE laypipe_runtime_read;
CREATE ROLE laypipe_write_login LOGIN PASSWORD 'write-test-only' IN ROLE laypipe_runtime_write;
`, { role: "laypipe_migration_owner" });
    await psql(container, `
GRANT laypipe_runtime_service TO laypipe_migration_owner WITH ADMIN OPTION;
GRANT laypipe_runtime_service TO laypipe_migration_owner WITH INHERIT TRUE;
GRANT laypipe_runtime_service TO laypipe_migration_owner WITH SET TRUE;
`);
    const preGrantRoles = await psql(container, `
SELECT r.rolname, r.rolsuper, r.rolinherit, r.rolcreaterole, r.rolcreatedb,
  r.rolcanlogin, r.rolreplication, r.rolbypassrls,
  EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.member = r.oid),
  EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.roleid = r.oid)
FROM pg_roles r
WHERE r.rolname IN ('laypipe_runtime_read','laypipe_runtime_write','laypipe_runtime_service')
ORDER BY r.rolname;
`);
    assert.equal(preGrantRoles.stdout, [
      "laypipe_runtime_read|f|t|f|f|f|f|f|f|t",
      "laypipe_runtime_service|f|t|f|f|f|f|f|f|t",
      "laypipe_runtime_write|f|t|f|f|f|f|f|f|t",
    ].join("\n"));
    await psql(container, plan.buildRuntimeGrantsSql({
  readRole: "laypipe_runtime_read",
  writeRole: "laypipe_runtime_write",
  serviceRole: "laypipe_runtime_service",
}), { role: "laypipe_migration_owner" });
    await psql(container, plan.buildRuntimeGrantsSql({
      readRole: "laypipe_runtime_read",
      writeRole: "laypipe_runtime_write",
      serviceRole: "laypipe_runtime_service",
    }), { role: "laypipe_migration_owner" });

    // Reapply the append-only function replacement after ownership has moved
    // to the NOLOGIN service role. This models applying 0003 to an existing
    // 0000-0002 database and proves CREATE OR REPLACE retains the service ACL.
    const baselineMigration = readFileSync(
      resolve(root, "db/migrations/0003_market_baseline_semantics.sql"),
      "utf8",
    )
      .split(/^\s*--> statement-breakpoint\s*$/gm)
      .map((value) => value.trim())
      .filter(Boolean)
      .join(";\n");
    await psql(container, `${baselineMigration};`, { role: "laypipe_migration_owner" });

    const matrix = await psql(container, `
SELECT
  has_table_privilege('laypipe_runtime_read', 'launches', 'SELECT'),
  has_table_privilege('laypipe_runtime_read', 'launches', 'INSERT'),
  has_table_privilege('laypipe_runtime_write', 'chain_blocks', 'INSERT'),
  has_table_privilege('laypipe_runtime_write', 'chain_blocks', 'UPDATE'),
  has_table_privilege('laypipe_runtime_write', 'ipfs_promotions', 'INSERT'),
  has_table_privilege('laypipe_runtime_write', 'ipfs_promotions', 'UPDATE'),
  has_function_privilege('laypipe_runtime_write', 'laypipe_runtime_initialize_cursor(bigint,text,bigint)', 'EXECUTE'),
  has_function_privilege('laypipe_runtime_write', 'laypipe_runtime_advance_cursor(bigint,text,bigint,bigint,evm_bytes32)', 'EXECUTE'),
  has_function_privilege('laypipe_runtime_write', 'laypipe_runtime_record_observation(bigint,text,bigint,timestamp with time zone,text)', 'EXECUTE'),
  has_function_privilege('laypipe_runtime_write', 'laypipe_runtime_rollback_chain(bigint,bigint,evm_bytes32)', 'EXECUTE'),
  has_function_privilege('laypipe_runtime_read', 'laypipe_runtime_initialize_cursor(bigint,text,bigint)', 'EXECUTE'),
  has_function_privilege('laypipe_runtime_read', 'laypipe_runtime_advance_cursor(bigint,text,bigint,bigint,evm_bytes32)', 'EXECUTE'),
  has_function_privilege('laypipe_runtime_read', 'laypipe_runtime_record_observation(bigint,text,bigint,timestamp with time zone,text)', 'EXECUTE'),
  has_function_privilege('laypipe_runtime_read', 'laypipe_runtime_rollback_chain(bigint,bigint,evm_bytes32)', 'EXECUTE'),
  has_function_privilege('laypipe_runtime_service', 'laypipe_refresh_market_leaders()', 'EXECUTE'),
  has_function_privilege('laypipe_untrusted_login', 'laypipe_refresh_market_leaders()', 'EXECUTE'),
  has_function_privilege('laypipe_runtime_read', 'laypipe_refresh_market_leaders()', 'EXECUTE'),
  has_function_privilege('laypipe_runtime_write', 'laypipe_refresh_market_leaders()', 'EXECUTE');
`);
    assert.equal(matrix.stdout, "t|f|t|t|t|t|t|t|t|t|f|f|f|f|t|f|f|f");

    const readSelect = await psql(container, "SELECT count(*) FROM launches;", {
      role: "laypipe_read_login",
    });
    assert.equal(readSelect.stdout, "0");

    for (const [role, sql] of [
      ["laypipe_read_login", "CREATE TABLE escaped_read(id integer);"],
      ["laypipe_read_login", "UPDATE chain_blocks SET block_number = block_number;"],
      ["laypipe_read_login", "DELETE FROM launches;"],
      ["laypipe_write_login", "CREATE TABLE escaped_write(id integer);"],
      ["laypipe_write_login", "CREATE TEMP TABLE escaped_temp(id integer);"],
      ["laypipe_write_login", "DELETE FROM chain_blocks;"],
      ["laypipe_write_login", "TRUNCATE chain_blocks CASCADE;"],
      ["laypipe_write_login", "UPDATE indexer_cursors SET next_block = 99;"],
      ["laypipe_write_login", "UPDATE pool_market_totals SET total_trades = 0;"],
      ["laypipe_write_login", "UPDATE token_holder_balance_state SET balance = 0;"],
      ["laypipe_write_login", "UPDATE market_leader_snapshots SET refreshed_at = now();"],
      ["laypipe_write_login", "DELETE FROM market_leader_entries;"],
      ["laypipe_write_login", "DELETE FROM ipfs_promotions;"],
    ]) {
      const denied = await psql(container, sql, { role, allowFailure: true });
      assert.notEqual(denied.code, 0, `${role} unexpectedly executed: ${sql}`);
      assert.match(denied.stderr, /permission denied/);
    }

    const readIdentity = await runtimeIdentity(
      container, "laypipe_read_login", "laypipe_runtime_read",
    );
    const writeIdentity = await runtimeIdentity(
      container, "laypipe_write_login", "laypipe_runtime_write",
    );
    databaseSecurity.attestRuntimeDatabaseIdentity(readIdentity, "read");
    databaseSecurity.attestRuntimeDatabaseIdentity(writeIdentity, "write");
    databaseSecurity.assertMatchingRuntimeDatabaseIdentities(readIdentity, writeIdentity);

    for (const { field, signature } of runtimeWrapperCapabilities) {
      await psql(container, `
SET ROLE laypipe_runtime_service;
GRANT EXECUTE ON FUNCTION ${signature} TO laypipe_read_login;
RESET ROLE;
`, { role: "laypipe_migration_owner" });
      const injectedReadIdentity = await runtimeIdentity(
        container, "laypipe_read_login", "laypipe_runtime_read",
      );
      assert.equal(injectedReadIdentity[field], true, `${field} grant was not effective`);
      assert.throws(
        () => databaseSecurity.attestRuntimeDatabaseIdentity(injectedReadIdentity, "read"),
        /write capability/,
        `read attestation accepted injected ${field}`,
      );
      await psql(container, `
SET ROLE laypipe_runtime_service;
REVOKE EXECUTE ON FUNCTION ${signature} FROM laypipe_read_login;
RESET ROLE;
`, { role: "laypipe_migration_owner" });
    }
    databaseSecurity.attestRuntimeDatabaseIdentity(
      await runtimeIdentity(container, "laypipe_read_login", "laypipe_runtime_read"),
      "read",
    );

    await psql(container, `
CREATE ROLE laypipe_owner_copy LOGIN CREATEDB IN ROLE laypipe_runtime_write;
`);
    const copiedOwnerIdentity = await runtimeIdentity(
      container, "laypipe_owner_copy", "laypipe_runtime_write",
    );
    assert.throws(
      () => databaseSecurity.attestRuntimeDatabaseIdentity(copiedOwnerIdentity, "write"),
      /role attestation/,
    );

    const block100 = `0x${"1".repeat(64)}`;
    const block101 = `0x${"2".repeat(64)}`;
    const parent99 = `0x${"0".repeat(64)}`;
    const launchTx = `0x${"3".repeat(64)}`;
    const secondLaunchTx = `0x${"a".repeat(64)}`;
    const swapTx = `0x${"4".repeat(64)}`;
    const swapTx2 = `0x${"8".repeat(64)}`;
    const secondSwapTx = `0x${"b".repeat(64)}`;
    const secondSwapTx2 = `0x${"c".repeat(64)}`;
    const transferTx = `0x${"5".repeat(64)}`;
    const factory = `0x${"1".repeat(40)}`;
    const creator = `0x${"2".repeat(40)}`;
    const token = `0x${"3".repeat(40)}`;
    const secondToken = `0x${"8".repeat(40)}`;
    const hook = `0x${"4".repeat(40)}`;
    const pool = `0x${"6".repeat(64)}`;
    const secondPool = `0x${"9".repeat(64)}`;
    const holder = `0x${"7".repeat(40)}`;
    const zero = `0x${"0".repeat(40)}`;
    const ingest = await psql(container, `
SELECT laypipe_runtime_initialize_cursor(4663, 'laypipe', 100);
INSERT INTO chain_blocks (
  chain_id, block_number, block_hash, parent_hash, block_timestamp
) VALUES
  (4663, 100, '${block100}', '${parent99}', '2026-08-12T00:00:00Z'),
  (4663, 101, '${block101}', '${block100}', '2026-08-12T00:00:01Z')
ON CONFLICT (chain_id, block_number) DO UPDATE
SET block_hash = chain_blocks.block_hash;
INSERT INTO chain_events (
  chain_id, block_number, transaction_hash, transaction_index, log_index,
  contract_address, topics, data, event_name, decoded_args
) VALUES
  (4663, 100, '${launchTx}', 0, 0, '${factory}', '[]', '0x', 'TokenLaunched', '{}'),
  (4663, 100, '${secondLaunchTx}', 1, 1, '${factory}', '[]', '0x', 'TokenLaunched', '{}'),
  (4663, 101, '${swapTx}', 0, 0, '${hook}', '[]', '0x', 'Swap', '{}'),
  (4663, 101, '${swapTx2}', 0, 2, '${hook}', '[]', '0x', 'Swap', '{}'),
  (4663, 101, '${secondSwapTx}', 0, 3, '${hook}', '[]', '0x', 'Swap', '{}'),
  (4663, 101, '${secondSwapTx2}', 0, 4, '${hook}', '[]', '0x', 'Swap', '{}'),
  (4663, 101, '${transferTx}', 1, 1, '${token}', '[]', '0x', 'Transfer', '{}')
ON CONFLICT (chain_id, transaction_hash, log_index) DO UPDATE
SET transaction_hash = chain_events.transaction_hash;
INSERT INTO launches (
  chain_id, token_address, pool_id, creator_address, config_id, first_buy_in,
  first_buy_out, hook_address, fee_recipient_address, fee_mode, block_number,
  launched_at, transaction_hash, log_index
) VALUES (
  4663, '${token}', '${pool}', '${creator}', 1, 0, 0, '${hook}', '${creator}',
  'creator', 100, '2026-08-12T00:00:00Z', '${launchTx}', 0
), (
  4663, '${secondToken}', '${secondPool}', '${creator}', 1, 0, 0, '${hook}', '${creator}',
  'creator', 100, '2026-08-12T00:00:00Z', '${secondLaunchTx}', 1
)
ON CONFLICT (chain_id, token_address) DO UPDATE
SET token_address = launches.token_address;
INSERT INTO swaps (
  chain_id, pool_id, sender_address, side, amount0, amount1, sqrt_price_x96,
  liquidity, tick, fee_pips, pipedog_amount, token_amount, block_number,
  block_timestamp, transaction_hash, log_index
) VALUES (
  4663, '${pool}', '${creator}', 'buy', -12, 20, 1, 1, 0, 10000, 12, 20,
  101, '2026-08-12T00:00:01Z', '${swapTx}', 0
) , (
  4663, '${pool}', '${creator}', 'buy', -10, 20, 1, 1, 0, 10000, 10, 20,
  101, '2026-08-12T00:00:01Z', '${swapTx2}', 2
), (
  4663, '${secondPool}', '${creator}', 'buy', -5, 10, 1, 1, 0, 10000, 5, 10,
  101, '2026-08-12T00:00:01Z', '${secondSwapTx}', 3
), (
  4663, '${secondPool}', '${creator}', 'buy', -5, 10, 1, 1, 0, 10000, 5, 10,
  101, '2026-08-12T00:00:01Z', '${secondSwapTx2}', 4
)
ON CONFLICT (chain_id, transaction_hash, log_index) DO UPDATE
SET transaction_hash = swaps.transaction_hash;
INSERT INTO token_transfers (
  chain_id, token_address, from_address, to_address, amount, block_number,
  block_timestamp, transaction_hash, log_index
) VALUES (
  4663, '${token}', '${zero}', '${holder}', 1000, 101,
  '2026-08-12T00:00:01Z', '${transferTx}', 1
)
ON CONFLICT (chain_id, transaction_hash, log_index) DO UPDATE
SET transaction_hash = token_transfers.transaction_hash;
SELECT laypipe_runtime_advance_cursor(4663, 'laypipe', 100, 101, '${block101}');
SELECT laypipe_runtime_record_observation(
  4663, 'laypipe', 101, '2026-08-12T00:00:02Z', 'caught-up'
);
SELECT total_trades FROM pool_market_totals WHERE chain_id = 4663 AND pool_id = '${pool}';
SELECT balance FROM token_holder_balance_state
WHERE chain_id = 4663 AND token_address = '${token}' AND holder_address = '${holder}';
`, { role: "laypipe_write_login" });
    assert.match(ingest.stdout, /t\n2\n1000$/);

    const leaders = await psql(container, `
SELECT snapshot_block, snapshot_hash, snapshot_at::text
FROM market_leader_snapshots WHERE chain_id = 4663;
SELECT leader_kind, token_address
FROM market_leader_entries WHERE chain_id = 4663 ORDER BY leader_kind;
`, { role: "laypipe_read_login" });
    assert.equal(leaders.stdout, [
      `101|${block101}|2026-08-12 00:00:01+00`,
      `most-traded|${token}`,
      `newest|${secondToken}`,
    ].join("\n"), "all-negative or unchanged new pools must not publish a mover");

    const firstRefresh = await psql(container, `
SELECT refreshed_at::text FROM market_leader_snapshots WHERE chain_id = 4663;
`, { role: "laypipe_migration_owner" });
    await psql(container, `
SELECT laypipe_runtime_record_observation(
  4663, 'laypipe', 101, '2026-08-12T00:00:03Z', 'caught-up'
);
`, { role: "laypipe_write_login" });
    const throttledRefresh = await psql(container, `
SELECT refreshed_at::text FROM market_leader_snapshots WHERE chain_id = 4663;
`, { role: "laypipe_migration_owner" });
    assert.equal(throttledRefresh.stdout, firstRefresh.stdout);

    const wrongRollback = await psql(
      container,
      `SELECT laypipe_runtime_rollback_chain(4663, 100, '${block101}');`,
      { role: "laypipe_write_login", allowFailure: true },
    );
    assert.notEqual(wrongRollback.code, 0);
    assert.match(wrongRollback.stderr, /ancestor does not match/);
    const rollback = await psql(container, `
SELECT laypipe_runtime_rollback_chain(4663, 100, '${block100}');
SELECT next_block, last_processed_block, last_processed_hash
FROM indexer_cursors WHERE chain_id = 4663 AND stream = 'laypipe';
SELECT count(*) FROM swaps;
SELECT count(*) FROM token_holder_balance_state;
`, { role: "laypipe_write_login" });
    assert.equal(rollback.stdout, `1\n101|100|${block100}\n0\n0`);
    const invalidatedLeaders = await psql(container, `
SELECT count(*) FROM market_leader_snapshots;
SELECT count(*) FROM market_leader_entries;
`, { role: "laypipe_read_login" });
    assert.equal(invalidatedLeaders.stdout, "0\n0");

    await psql(container, `
INSERT INTO chain_blocks (
  chain_id, block_number, block_hash, parent_hash, block_timestamp
) VALUES (4663, 101, '${block101}', '${block100}', '2026-08-12T00:00:01Z');
INSERT INTO chain_events (
  chain_id, block_number, transaction_hash, transaction_index, log_index,
  contract_address, topics, data, event_name, decoded_args
) VALUES
  (4663, 101, '${swapTx}', 0, 0, '${hook}', '[]', '0x', 'Swap', '{}'),
  (4663, 101, '${swapTx2}', 0, 2, '${hook}', '[]', '0x', 'Swap', '{}'),
  (4663, 101, '${secondSwapTx}', 0, 3, '${hook}', '[]', '0x', 'Swap', '{}'),
  (4663, 101, '${secondSwapTx2}', 0, 4, '${hook}', '[]', '0x', 'Swap', '{}');
INSERT INTO swaps (
  chain_id, pool_id, sender_address, side, amount0, amount1, sqrt_price_x96,
  liquidity, tick, fee_pips, pipedog_amount, token_amount, block_number,
  block_timestamp, transaction_hash, log_index
) VALUES
  (4663, '${pool}', '${creator}', 'buy', -10, 20, 1, 1, 0, 10000, 10, 20,
   101, '2026-08-12T00:00:01Z', '${swapTx}', 0),
  (4663, '${pool}', '${creator}', 'buy', -12, 20, 1, 1, 0, 10000, 12, 20,
   101, '2026-08-12T00:00:01Z', '${swapTx2}', 2),
  (4663, '${secondPool}', '${creator}', 'buy', -6, 10, 1, 1, 0, 10000, 6, 10,
   101, '2026-08-12T00:00:01Z', '${secondSwapTx}', 3),
  (4663, '${secondPool}', '${creator}', 'buy', -5, 10, 1, 1, 0, 10000, 5, 10,
   101, '2026-08-12T00:00:01Z', '${secondSwapTx2}', 4);
SELECT laypipe_runtime_advance_cursor(4663, 'laypipe', 101, 101, '${block101}');
SELECT laypipe_runtime_record_observation(
  4663, 'laypipe', 101, '2026-08-12T00:00:04Z', 'caught-up'
);
`, { role: "laypipe_write_login" });
    const replayedMover = await psql(container, `
SELECT token_address FROM market_leader_entries
WHERE chain_id = 4663 AND leader_kind = 'biggest-mover';
`, { role: "laypipe_read_login" });
    assert.equal(
      replayedMover.stdout,
      token,
      "a new pool must use its first in-window swap as baseline and its second as latest",
    );

    const promotionId = "a".repeat(64);
    const pinDigest = "b".repeat(64);
    const fileSha = "c".repeat(64);
    const imageCid = `b${"a".repeat(45)}`;
    const metadataCid = `b${"b".repeat(45)}`;
    const promotionInsert = `
INSERT INTO ipfs_promotions (
  promotion_id, stage_file_id, pin_digest, wallet_address, file_sha256,
  image_cid, metadata_cid, image_file_id, metadata_file_id,
  image_size, metadata_size, image_mime_type, metadata_mime_type,
  status, completed_at
) VALUES (
  '${promotionId}', '11111111-1111-4111-8111-111111111111', '${pinDigest}',
  '0x${"1".repeat(40)}', '${fileSha}', '${imageCid}', '${metadataCid}',
  '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333', 10, 20,
  'image/webp', 'application/json', 'completed', now()
)
ON CONFLICT (promotion_id) DO UPDATE
SET promotion_id = ipfs_promotions.promotion_id
WHERE ipfs_promotions.pin_digest = EXCLUDED.pin_digest
RETURNING promotion_id;`;
    const inserted = await psql(container, promotionInsert, {
      role: "laypipe_write_login",
    });
    assert.equal(inserted.stdout, promotionId);
    const retried = await psql(container, promotionInsert, {
      role: "laypipe_write_login",
    });
    assert.equal(retried.stdout, promotionId);
    const changed = await psql(
      container,
      `UPDATE ipfs_promotions SET file_sha256 = '${"d".repeat(64)}' WHERE promotion_id = '${promotionId}';`,
      { role: "laypipe_write_login", allowFailure: true },
    );
    assert.notEqual(changed.code, 0);
    assert.match(changed.stderr, /attempted to mutate immutable indexed row/);

    const searchPaths = await psql(container, `
SELECT count(*)
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname LIKE 'laypipe_%'
  AND 'search_path=pg_catalog, public' = ANY(coalesce(p.proconfig, ARRAY[]::text[]));
`);
    assert.equal(searchPaths.stdout, "13");

    const futureTable = await psql(container, "CREATE TABLE escaped_future(id integer);", {
      role: "laypipe_write_login",
      allowFailure: true,
    });
    assert.notEqual(futureTable.code, 0);
    assert.match(futureTable.stderr, /permission denied/);
  } finally {
    await docker(["rm", "--force", "--volumes", container], { allowFailure: true });
  }
});
