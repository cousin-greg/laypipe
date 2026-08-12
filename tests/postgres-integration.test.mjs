import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
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
const moduleCache = new Map();
const enabled = process.env.LAYPIPE_RUN_POSTGRES_INTEGRATION === "1";
const postgresImage = process.env.LAYPIPE_POSTGRES_IMAGE ?? "postgres:16-alpine";
const NULL_MARKER = "__LAYPIPE_POSTGRES_NULL__";

function loadTypeScript(relativePath) {
  const filename = resolve(root, relativePath);
  if (moduleCache.has(filename)) return moduleCache.get(filename).exports;
  const loaded = { exports: {} };
  moduleCache.set(filename, loaded);
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
      if (code === 0 || options.allowFailure) {
        resolvePromise(result);
        return;
      }
      const detail = [result.stderr, result.stdout].filter(Boolean).join("\n");
      rejectPromise(new Error(`${command} exited with code ${code}${detail ? `:\n${detail}` : ""}`));
    });
    if (options.input !== undefined) child.stdin.end(options.input);
    else child.stdin.end();
  });
}

function docker(args, options) {
  return run("docker", args, options);
}

function psql(container, sql, options = {}) {
  return docker(
    [
      "exec",
      "-i",
      container,
      "psql",
      "-X",
      "-qAt",
      "-F",
      "\t",
      "-P",
      `null=${NULL_MARKER}`,
      "-v",
      "ON_ERROR_STOP=1",
      "-U",
      "postgres",
      "-d",
      "laypipe_test",
    ],
    { input: sql, allowFailure: options.allowFailure },
  );
}

function sqlLiteral(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error("Unsafe numeric SQL test parameter.");
    return String(value);
  }
  if (typeof value !== "string") throw new Error("Unsupported SQL test parameter.");
  return `'${value.replaceAll("'", "''")}'`;
}

const TOKEN_COLUMNS = [
  "chain_id", "token_address", "pool_id", "creator_address", "config_id",
  "first_buy_in", "first_buy_out", "hook_address", "fee_recipient_address",
  "fee_mode", "name", "symbol", "description", "logo_uri", "metadata_uri",
  "socials", "block_number", "log_index", "launched_at",
  "last_pipedog_amount", "last_token_amount", "last_trade_at",
  "baseline_pipedog_amount", "baseline_token_amount", "volume_24h_pipedog",
  "trades_24h", "total_trades",
];
const WATERMARK_COLUMNS = [
  "stream", "next_block", "last_processed_block", "last_processed_hash", "updated_at",
];

function parseRows(output, columns) {
  if (!output) return [];
  return output.split(/\r?\n/).filter(Boolean).map((line) => {
    const values = line.split("\t");
    assert.equal(values.length, columns.length, `Unexpected PostgreSQL row: ${line}`);
    return Object.fromEntries(columns.map((column, index) => {
      const raw = values[index] === NULL_MARKER ? null : values[index];
      if (column === "log_index") return [column, Number(raw)];
      if (column === "socials") return [column, raw === null ? null : JSON.parse(raw)];
      return [column, raw];
    }));
  });
}

async function preparedQuery(container, sql, parameterTypes, parameters, columns) {
  assert.equal(parameterTypes.length, parameters.length);
  const statement = `PREPARE laypipe_integration_query(${parameterTypes.join(", ")}) AS\n${sql};\nEXECUTE laypipe_integration_query(${parameters.map(sqlLiteral).join(", ")});\n`;
  const result = await psql(container, statement);
  return parseRows(result.stdout, columns);
}

function address(nibble) {
  return `0x${nibble.repeat(40)}`;
}

function hash(nibble) {
  return `0x${nibble.repeat(64)}`;
}

test(
  "production migration supports canonical ingest, rollback/replay, and live market reads",
  {
    skip: enabled ? false : "Set LAYPIPE_RUN_POSTGRES_INTEGRATION=1 to run the disposable PostgreSQL integration test.",
    timeout: 240_000,
  },
  async () => {
    const migrationPlan = loadTypeScript("scripts/indexer/migration-plan.ts");
    const readModel = loadTypeScript("lib/server/market/read-model.ts");
    const migrationSource = readFileSync(
      resolve(root, "db/migrations/0000_production_read_model.sql"),
      "utf8",
    );
    const migrationName = "0000_production_read_model.sql";
    const migrationHash = createHash("sha256").update(migrationSource).digest("hex");
    const migrationCommand = migrationPlan.buildMigrationCommand({
      name: migrationName,
      sha256: migrationHash,
      statements: migrationPlan.migrationStatements(migrationSource),
    });
    const container = `laypipe-pg-${process.pid}-${randomBytes(4).toString("hex")}`;
    let started = false;

    try {
      await docker(["version", "--format", "{{.Server.Version}}"]);
      await docker([
        "run",
        "--detach",
        "--name",
        container,
        "--label",
        "laypipe.disposable=true",
        "--network",
        "none",
        "--tmpfs",
        "/var/lib/postgresql/data:rw,nosuid,nodev,size=512m",
        "--env",
        "POSTGRES_HOST_AUTH_METHOD=trust",
        "--env",
        "POSTGRES_DB=laypipe_test",
        postgresImage,
      ]);
      started = true;

      let ready = false;
      for (let attempt = 0; attempt < 60; attempt += 1) {
        const probe = await docker(
          ["exec", container, "pg_isready", "-U", "postgres", "-d", "laypipe_test"],
          { allowFailure: true },
        );
        if (probe.code === 0) {
          ready = true;
          break;
        }
        await delay(1_000);
      }
      assert.equal(ready, true, "Disposable PostgreSQL did not become ready.");

      await psql(container, migrationCommand);
      await psql(container, migrationCommand);
      const ledger = await psql(
        container,
        "SELECT name, sha256 FROM laypipe_schema_migrations ORDER BY name;",
      );
      assert.equal(ledger.stdout, `${migrationName}\t${migrationHash}`);

      const mismatchedMigration = migrationPlan.buildMigrationCommand({
        name: migrationName,
        sha256: "f".repeat(64),
        statements: migrationPlan.migrationStatements(migrationSource),
      });
      const mismatch = await psql(container, mismatchedMigration, { allowFailure: true });
      assert.notEqual(mismatch.code, 0);
      assert.match(mismatch.stderr, /was modified; refusing to continue/i);

      const token = address("a");
      const creator = address("b");
      const hook = address("c");
      const feeRecipient = address("d");
      const trader = address("e");
      const holder = address("f");
      const zero = address("0");
      const pool = hash("6");
      const block100 = hash("a");
      const oldBlock101 = hash("b");
      const newBlock101 = hash("c");
      const launchTx = hash("1");
      const oldSwapTx = hash("2");
      const oldTransferTx = hash("3");
      const newSwapTx = hash("4");
      const newTransferTx = hash("5");

      await psql(container, `
BEGIN ISOLATION LEVEL SERIALIZABLE;
SELECT laypipe_initialize_cursor(4663, 'laypipe', 100);
INSERT INTO chain_blocks (chain_id, block_number, block_hash, parent_hash, block_timestamp)
VALUES
  (4663, 100, '${block100}', '${hash("0")}', now() - interval '10 minutes'),
  (4663, 101, '${oldBlock101}', '${block100}', now() - interval '5 minutes');
INSERT INTO chain_events (
  chain_id, block_number, transaction_hash, transaction_index, log_index,
  contract_address, topic0, topics, data, event_name, decoded_args
) VALUES
  (4663, 100, '${launchTx}', 0, 0, '${hook}', '${hash("7")}', '[]', '0x', 'Launched', '{}'),
  (4663, 101, '${oldSwapTx}', 0, 0, '${hook}', '${hash("8")}', '[]', '0x', 'Swap', '{}'),
  (4663, 101, '${oldTransferTx}', 1, 1, '${token}', '${hash("9")}', '[]', '0x', 'Transfer', '{}');
INSERT INTO launches (
  chain_id, token_address, pool_id, creator_address, config_id, first_buy_in,
  first_buy_out, hook_address, fee_recipient_address, fee_mode, name, symbol,
  description, logo_uri, metadata_uri, socials, block_number, launched_at,
  transaction_hash, log_index
) VALUES (
  4663, '${token}', '${pool}', '${creator}', 1, 1000000000000000000,
  2000000000000000000, '${hook}', '${feeRecipient}', 'self-burn',
  'Pipe Integration', 'PIPE', 'Disposable PostgreSQL integration token.',
  'ipfs://image', 'ipfs://metadata', '{"website":"https://example.test"}',
  100, now() - interval '10 minutes', '${launchTx}', 0
);
INSERT INTO swaps (
  chain_id, pool_id, sender_address, side, amount0, amount1, sqrt_price_x96,
  liquidity, tick, fee_pips, pipedog_amount, token_amount, block_number,
  block_timestamp, transaction_hash, log_index
) VALUES (
  4663, '${pool}', '${trader}', 'buy', -1000000000000000000,
  2000000000000000000, 79228162514264337593543950336, 1000000, 0, 10000,
  1000000000000000000, 2000000000000000000, 101,
  now() - interval '5 minutes', '${oldSwapTx}', 0
);
INSERT INTO token_transfers (
  chain_id, token_address, from_address, to_address, amount, block_number,
  block_timestamp, transaction_hash, log_index
) VALUES (
  4663, '${token}', '${zero}', '${holder}', 1000000000000000000000, 101,
  now() - interval '5 minutes', '${oldTransferTx}', 1
);
SELECT laypipe_advance_cursor(4663, 'laypipe', 100, 101, '${oldBlock101}');
COMMIT;
`);

      const initial = await psql(container, `
SELECT
  (SELECT next_block::text FROM indexer_cursors WHERE chain_id = 4663 AND stream = 'laypipe'),
  (SELECT count(*)::text FROM chain_blocks WHERE chain_id = 4663),
  (SELECT count(*)::text FROM chain_events WHERE chain_id = 4663),
  (SELECT count(*)::text FROM swaps WHERE chain_id = 4663),
  (SELECT balance::text FROM token_balances WHERE chain_id = 4663 AND token_address = '${token}' AND holder_address = '${holder}');
`);
      assert.equal(initial.stdout, "102\t2\t3\t1\t1000000000000000000000");

      const divergentBlock = await psql(container, `
INSERT INTO chain_blocks (chain_id, block_number, block_hash, parent_hash, block_timestamp)
VALUES (4663, 101, '${newBlock101}', '${block100}', now())
ON CONFLICT (chain_id, block_number) DO UPDATE SET block_hash = EXCLUDED.block_hash;
`, { allowFailure: true });
      assert.notEqual(divergentBlock.code, 0);
      assert.match(divergentBlock.stderr, /attempted to mutate immutable indexed row/i);

      const rollback = await psql(
        container,
        `SELECT laypipe_rollback_chain(4663, 100, '${block100}')::text;`,
      );
      assert.equal(rollback.stdout, "1");
      const rolledBack = await psql(container, `
SELECT
  (SELECT next_block::text FROM indexer_cursors WHERE chain_id = 4663 AND stream = 'laypipe'),
  (SELECT last_processed_block::text FROM indexer_cursors WHERE chain_id = 4663 AND stream = 'laypipe'),
  (SELECT count(*)::text FROM chain_blocks WHERE chain_id = 4663),
  (SELECT count(*)::text FROM chain_events WHERE chain_id = 4663),
  (SELECT count(*)::text FROM swaps WHERE chain_id = 4663),
  (SELECT count(*)::text FROM token_transfers WHERE chain_id = 4663),
  (SELECT count(*)::text FROM token_balances WHERE chain_id = 4663 AND token_address = '${token}');
`);
      assert.equal(rolledBack.stdout, "101\t100\t1\t1\t0\t0\t0");

      await psql(container, `
BEGIN ISOLATION LEVEL SERIALIZABLE;
INSERT INTO chain_blocks (chain_id, block_number, block_hash, parent_hash, block_timestamp)
VALUES (4663, 101, '${newBlock101}', '${block100}', now() - interval '1 minute');
INSERT INTO chain_events (
  chain_id, block_number, transaction_hash, transaction_index, log_index,
  contract_address, topic0, topics, data, event_name, decoded_args
) VALUES
  (4663, 101, '${newSwapTx}', 0, 0, '${hook}', '${hash("8")}', '[]', '0x', 'Swap', '{}'),
  (4663, 101, '${newTransferTx}', 1, 1, '${token}', '${hash("9")}', '[]', '0x', 'Transfer', '{}');
INSERT INTO swaps (
  chain_id, pool_id, sender_address, side, amount0, amount1, sqrt_price_x96,
  liquidity, tick, fee_pips, pipedog_amount, token_amount, block_number,
  block_timestamp, transaction_hash, log_index
) VALUES (
  4663, '${pool}', '${trader}', 'buy', -3000000000000000000,
  6000000000000000000, 79228162514264337593543950336, 2000000, 1, 10000,
  3000000000000000000, 6000000000000000000, 101,
  now() - interval '1 minute', '${newSwapTx}', 0
);
INSERT INTO token_transfers (
  chain_id, token_address, from_address, to_address, amount, block_number,
  block_timestamp, transaction_hash, log_index
) VALUES (
  4663, '${token}', '${zero}', '${holder}', 2000000000000000000000, 101,
  now() - interval '1 minute', '${newTransferTx}', 1
);
SELECT laypipe_advance_cursor(4663, 'laypipe', 101, 101, '${newBlock101}');
COMMIT;
`);

      const database = {
        async query(sql, parameters = []) {
          if (sql === readModel.TOKEN_LIST_SQL) {
            return preparedQuery(
              container,
              sql,
              ["bigint", "bigint", "integer", "evm_address", "integer"],
              parameters,
              TOKEN_COLUMNS,
            );
          }
          if (sql === readModel.TOKEN_DETAIL_SQL) {
            return preparedQuery(
              container,
              sql,
              ["bigint", "evm_address"],
              parameters,
              TOKEN_COLUMNS,
            );
          }
          if (sql === readModel.INDEXER_WATERMARK_SQL) {
            return preparedQuery(
              container,
              sql,
              ["bigint", "text"],
              parameters,
              WATERMARK_COLUMNS,
            );
          }
          throw new Error("Unexpected read-model SQL in PostgreSQL integration test.");
        },
      };

      const list = await readModel.listLiveTokens(
        database,
        { limit: 10, cursor: null },
        "postgres-integration-cursor-secret-longer-than-thirty-two-bytes",
      );
      assert.equal(list.tokens.length, 1);
      assert.equal(list.page.nextCursor, null);
      assert.equal(list.indexer.nextBlock, "102");
      assert.equal(list.indexer.lastProcessedBlock, "101");
      assert.equal(list.indexer.lastProcessedHash, newBlock101);
      assert.equal(list.tokens[0].tokenAddress, token);
      assert.deepEqual(list.tokens[0].metrics.lastPricePipedog.value, {
        pipedogAmount: "3000000000000000000",
        tokenAmount: "6000000000000000000",
      });
      assert.equal(list.tokens[0].metrics.volume24hPipedog.value, "3000000000000000000");
      assert.equal(list.tokens[0].metrics.trades24h.value, 1);
      assert.equal(list.tokens[0].metrics.totalTrades.value, 1);

      const detail = await readModel.getLiveToken(database, token);
      assert.equal(detail.token.name, "Pipe Integration");
      assert.deepEqual(detail.token.socials, { website: "https://example.test" });
      const missing = await readModel.getLiveToken(database, address("1"));
      assert.equal(missing, null);

      const replayed = await psql(container, `
SELECT
  (SELECT count(*)::text FROM chain_blocks WHERE chain_id = 4663),
  (SELECT count(*)::text FROM chain_events WHERE chain_id = 4663),
  (SELECT count(*)::text FROM swaps WHERE chain_id = 4663),
  (SELECT balance::text FROM token_balances WHERE chain_id = 4663 AND token_address = '${token}' AND holder_address = '${holder}');
`);
      assert.equal(replayed.stdout, "2\t3\t1\t2000000000000000000000");
    } finally {
      if (started) {
        const cleanup = await docker(
          ["rm", "--force", "--volumes", container],
          { allowFailure: true },
        );
        assert.equal(cleanup.code, 0, cleanup.stderr || "Failed to remove disposable PostgreSQL container.");
      }
    }
  },
);
