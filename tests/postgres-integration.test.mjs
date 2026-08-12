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
const multiformatsCid = await import("multiformats/cid");
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
  "approved_logo_cid",
  "socials", "block_number", "log_index", "launched_at",
  "last_pipedog_amount", "last_token_amount", "last_trade_at",
  "baseline_pipedog_amount", "baseline_token_amount", "volume_24h_pipedog",
  "trades_24h", "total_trades",
];
const WATERMARK_COLUMNS = [
  "stream", "next_block", "last_processed_block", "last_processed_hash",
  "observed_safe_head", "observed_at", "last_run_status", "updated_at",
];

function interpolateSql(sql, parameters = []) {
  return sql.replace(/\$(\d+)/g, (_match, index) => {
    const value = parameters[Number(index) - 1];
    if (value === undefined) throw new Error(`Missing SQL parameter $${index}.`);
    return sqlLiteral(value);
  });
}

function repositoryDatabase(container) {
  return {
    async query(sql, parameters = []) {
      await psql(container, interpolateSql(sql, parameters));
      return [];
    },
    async transaction(callback) {
      const statements = [];
      const transaction = {
        query(sql, parameters = []) {
          statements.push(interpolateSql(sql, parameters));
          return Promise.resolve([]);
        },
      };
      const promised = callback(transaction);
      await Promise.all(promised);
      await psql(container, `BEGIN ISOLATION LEVEL SERIALIZABLE;\n${statements.join(";\n")};\nCOMMIT;`);
      return statements.map(() => []);
    },
  };
}

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
    const repository = loadTypeScript("lib/server/indexer/repository.ts");
    const promotionRegistry = loadTypeScript("lib/server/ipfs/registry.ts");
    process.env.IPFS_GATEWAY_BASE_URL = "https://laypipe-test.mypinata.cloud/ipfs";
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
      const feeTx = hash("6");
      const burnTx = hash("7");
      const revenueTx = hash("8");
      const adminTx = hash("9");
      const imageCid = "bafkreig6cmq5xgc3ed4qknhtupzyqvkt3qquhyxphgxdxd3hkpdvweezly";
      const metadataCid = "bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku";

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
  (4663, 101, '${oldTransferTx}', 1, 1, '${token}', '${hash("9")}', '[]', '0x', 'Transfer', '{}'),
  (4663, 101, '${feeTx}', 2, 2, '${hook}', '${hash("1")}', '[]', '0x', 'FeeAccrued', '{}'),
  (4663, 101, '${burnTx}', 3, 3, '${feeRecipient}', '${hash("2")}', '[]', '0x', 'Burned', '{}'),
  (4663, 101, '${revenueTx}', 4, 4, '${address("1")}', '${hash("3")}', '[]', '0x', 'RevenueAllocated', '{}'),
  (4663, 101, '${adminTx}', 5, 5, '${hook}', '${hash("4")}', '[]', '0x', 'TreasuryUpdated', '{}');
INSERT INTO launches (
  chain_id, token_address, pool_id, creator_address, config_id, first_buy_in,
  first_buy_out, hook_address, fee_recipient_address, fee_mode, name, symbol,
  description, logo_uri, metadata_uri, socials, block_number, launched_at,
  transaction_hash, log_index
) VALUES (
  4663, '${token}', '${pool}', '${creator}', 1, 1000000000000000000,
  2000000000000000000, '${hook}', '${feeRecipient}', 'self-burn',
  'Pipe Integration', 'PIPE', 'Disposable PostgreSQL integration token.',
  'ipfs://${imageCid}', 'ipfs://${metadataCid}', '{"website":"https://example.test"}',
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
INSERT INTO fee_events (
  chain_id, fee_kind, pool_id, amount, block_number, block_timestamp,
  transaction_hash, log_index
) VALUES (
  4663, 'accrued', '${pool}', 7000000000000000, 101,
  now() - interval '5 minutes', '${feeTx}', 2
);
INSERT INTO burn_events (
  chain_id, pool_id, token_address, pipedog_in, tokens_burned, pipedog_bounty,
  block_number, block_timestamp, transaction_hash, log_index
) VALUES (
  4663, '${pool}', '${token}', 900000000000000000, 1800000000000000000,
  100000000000000000, 101, now() - interval '5 minutes', '${burnTx}', 3
);
INSERT INTO revenue_events (
  chain_id, route_kind, amount, sequester_amount, treasury_amount,
  operations_amount, block_number, block_timestamp, transaction_hash, log_index
) VALUES (
  4663, 'allocated', 1000000000000000000, 250000000000000000,
  250000000000000000, 500000000000000000, 101,
  now() - interval '5 minutes', '${revenueTx}', 4
);
INSERT INTO admin_events (
  chain_id, contract_address, event_name, subject_address, details,
  block_number, block_timestamp, transaction_hash, log_index
) VALUES (
  4663, '${hook}', 'TreasuryUpdated', '${feeRecipient}',
  '{"oldTreasury":"${creator}","newTreasury":"${feeRecipient}"}',
  101, now() - interval '5 minutes', '${adminTx}', 5
);
SELECT laypipe_advance_cursor(4663, 'laypipe', 100, 101, '${oldBlock101}');
COMMIT;
`);

      const promotionDatabase = {
        query(sql, parameters = []) {
          assert.equal(sql, promotionRegistry.RECORD_COMPLETED_PROMOTION_SQL);
          return preparedQuery(
            container,
            sql,
            [
              "text", "uuid", "text", "evm_address", "text", "text", "text",
              "uuid", "uuid", "integer", "integer", "text", "text", "double precision",
            ],
            parameters,
            ["promotion_id"],
          );
        },
      };
      const promotionRecord = {
        promotionId: "1".repeat(64),
        stageFileId: "11111111-1111-4111-8111-111111111111",
        pinDigest: "2".repeat(64),
        wallet: creator,
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
      await promotionRegistry.recordCompletedPromotion(promotionDatabase, promotionRecord);
      await promotionRegistry.recordCompletedPromotion(promotionDatabase, promotionRecord);
      await assert.rejects(
        promotionRegistry.recordCompletedPromotion(promotionDatabase, {
          ...promotionRecord,
          wallet: holder,
        }),
        (error) => error?.code === "PROMOTION_REGISTRY_UNAVAILABLE",
      );
      const promotionRows = await psql(container, `
SELECT promotion_id, image_cid, metadata_cid, status
FROM ipfs_promotions;
`);
      assert.equal(
        promotionRows.stdout,
        `${promotionRecord.promotionId}\t${imageCid}\t${metadataCid}\tcompleted`,
      );
      const mutatedPromotion = await psql(container, `
UPDATE ipfs_promotions
SET wallet_address = '${holder}'
WHERE promotion_id = '${promotionRecord.promotionId}';
`, { allowFailure: true });
      assert.notEqual(mutatedPromotion.code, 0);
      assert.match(mutatedPromotion.stderr, /attempted to mutate immutable indexed row/i);

      const initial = await psql(container, `
SELECT
  (SELECT next_block::text FROM indexer_cursors WHERE chain_id = 4663 AND stream = 'laypipe'),
  (SELECT count(*)::text FROM chain_blocks WHERE chain_id = 4663),
  (SELECT count(*)::text FROM chain_events WHERE chain_id = 4663),
  (SELECT count(*)::text FROM swaps WHERE chain_id = 4663),
  (SELECT coalesce(sum(total_trades), 0)::text FROM pool_market_totals WHERE chain_id = 4663),
  (SELECT count(*)::text FROM fee_events WHERE chain_id = 4663),
  (SELECT count(*)::text FROM burn_events WHERE chain_id = 4663),
  (SELECT count(*)::text FROM revenue_events WHERE chain_id = 4663),
  (SELECT count(*)::text FROM admin_events WHERE chain_id = 4663),
  (SELECT balance::text FROM token_balances WHERE chain_id = 4663 AND token_address = '${token}' AND holder_address = '${holder}'),
  (SELECT balance::text FROM token_holder_balance_state WHERE chain_id = 4663 AND token_address = '${token}' AND holder_address = '${holder}');
`);
      assert.equal(initial.stdout, "102\t2\t7\t1\t1\t1\t1\t1\t1\t1000000000000000000000\t1000000000000000000000");

      await psql(container, `
INSERT INTO token_transfers (
  chain_id, token_address, from_address, to_address, amount, block_number,
  block_timestamp, transaction_hash, log_index
)
SELECT chain_id, token_address, from_address, to_address, amount, block_number,
  block_timestamp, transaction_hash, log_index
FROM token_transfers
WHERE chain_id = 4663 AND transaction_hash = '${oldTransferTx}' AND log_index = 1
ON CONFLICT (chain_id, transaction_hash, log_index) DO NOTHING;
`);
      const identicalReplay = await psql(container, `
SELECT
  (SELECT count(*)::text FROM token_transfers WHERE chain_id = 4663),
  (SELECT balance::text FROM token_holder_balance_state WHERE chain_id = 4663 AND token_address = '${token}' AND holder_address = '${holder}');
`);
      assert.equal(identicalReplay.stdout, "1\t1000000000000000000000");

      const divergentBlock = await psql(container, `
INSERT INTO chain_blocks (chain_id, block_number, block_hash, parent_hash, block_timestamp)
VALUES (4663, 101, '${newBlock101}', '${block100}', now())
ON CONFLICT (chain_id, block_number) DO UPDATE SET block_hash = EXCLUDED.block_hash;
`, { allowFailure: true });
      assert.notEqual(divergentBlock.code, 0);
      assert.match(divergentBlock.stderr, /attempted to mutate immutable indexed row/i);

      await psql(container, `
UPDATE indexer_cursors
SET observed_safe_head = 101, observed_at = now(), last_run_status = 'caught-up'
WHERE chain_id = 4663 AND stream = 'laypipe';
`);

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
  (SELECT coalesce(sum(total_trades), 0)::text FROM pool_market_totals WHERE chain_id = 4663),
  (SELECT count(*)::text FROM token_transfers WHERE chain_id = 4663),
  (SELECT count(*)::text FROM fee_events WHERE chain_id = 4663),
  (SELECT count(*)::text FROM burn_events WHERE chain_id = 4663),
  (SELECT count(*)::text FROM revenue_events WHERE chain_id = 4663),
  (SELECT count(*)::text FROM admin_events WHERE chain_id = 4663),
  (SELECT count(*)::text FROM token_balances WHERE chain_id = 4663 AND token_address = '${token}'),
  (SELECT count(*)::text FROM token_holder_balance_state WHERE chain_id = 4663 AND token_address = '${token}'),
  (SELECT coalesce(observed_safe_head::text, 'null') FROM indexer_cursors WHERE chain_id = 4663 AND stream = 'laypipe'),
  (SELECT coalesce(last_run_status, 'null') FROM indexer_cursors WHERE chain_id = 4663 AND stream = 'laypipe');
`);
      assert.equal(rolledBack.stdout, "101\t100\t1\t1\t0\t0\t0\t0\t0\t0\t0\t0\t0\tnull\tnull");

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
UPDATE indexer_cursors
SET observed_safe_head = 101, observed_at = now(), last_run_status = 'caught-up'
WHERE chain_id = 4663 AND stream = 'laypipe';
COMMIT;
`);

      await psql(container, `
UPDATE indexer_cursors
SET observed_safe_head = 102, observed_at = now() + interval '1 second', last_run_status = 'caught-up'
WHERE chain_id = 4663 AND stream = 'laypipe';
`);
      const observationBehindCursor = await psql(container, `
UPDATE indexer_cursors
SET observed_safe_head = 100, observed_at = now() + interval '2 seconds', last_run_status = 'caught-up'
WHERE chain_id = 4663 AND stream = 'laypipe';
`, { allowFailure: true });
      assert.notEqual(observationBehindCursor.code, 0);
      assert.match(observationBehindCursor.stderr, /observed safe head is behind|regressed/i);
      const observationRegressed = await psql(container, `
UPDATE indexer_cursors
SET observed_safe_head = 101, observed_at = now() + interval '2 seconds', last_run_status = 'caught-up'
WHERE chain_id = 4663 AND stream = 'laypipe';
`, { allowFailure: true });
      assert.notEqual(observationRegressed.code, 0);
      assert.match(observationRegressed.stderr, /observed safe head regressed/i);
      const observationTimeRegressed = await psql(container, `
UPDATE indexer_cursors
SET observed_safe_head = 102, observed_at = now() - interval '1 day', last_run_status = 'caught-up'
WHERE chain_id = 4663 AND stream = 'laypipe';
`, { allowFailure: true });
      assert.notEqual(observationTimeRegressed.code, 0);
      assert.match(observationTimeRegressed.stderr, /observation time regressed/i);

      const queryMarketDatabase = async (sql, parameters = []) => {
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
        if (sql === readModel.MARKET_SNAPSHOT_WATERMARK_SQL) {
          return preparedQuery(
            container,
            sql,
            ["bigint", "text"],
            parameters,
            WATERMARK_COLUMNS,
          );
        }
        throw new Error("Unexpected read-model SQL in PostgreSQL integration test.");
      };
      const database = {
        query: queryMarketDatabase,
        async transaction(factory, options) {
          assert.equal(options?.isolationLevel, "RepeatableRead");
          assert.equal(options?.readOnly, true);
          const queries = factory({ query: queryMarketDatabase });
          return Promise.all(queries);
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
      assert.equal(
        list.tokens[0].logoGatewayUrl,
        `https://laypipe-test.mypinata.cloud/ipfs/${imageCid}`,
      );
      assert.deepEqual(list.tokens[0].metrics.lastPricePipedog.value, {
        pipedogAmount: "3000000000000000000",
        tokenAmount: "6000000000000000000",
      });
      assert.equal(list.tokens[0].metrics.volume24hPipedog.value, "3000000000000000000");
      assert.equal(list.tokens[0].metrics.trades24h.value, 1);
      assert.equal(list.tokens[0].metrics.totalTrades.value, 1);

      const indexes = await psql(container, `
SELECT indexname
FROM pg_indexes
WHERE schemaname = 'public'
  AND indexname IN ('launches_market_page_idx', 'swaps_pool_market_metrics_idx')
ORDER BY indexname;
`);
      assert.equal(
        indexes.stdout,
        "launches_market_page_idx\nswaps_pool_market_metrics_idx",
      );

      const launchPlan = await psql(container, `
SET enable_seqscan = off;
EXPLAIN (COSTS OFF)
SELECT l.*
FROM launches l
WHERE l.chain_id = 4663
ORDER BY l.block_number DESC, l.log_index DESC, l.token_address DESC
LIMIT 50;
`);
      assert.match(launchPlan.stdout, /Index Scan using launches_market_page_idx/);

      const swapPlan = await psql(container, `
SET enable_seqscan = off;
EXPLAIN (COSTS OFF)
SELECT s.pool_id, s.pipedog_amount, s.token_amount, s.block_timestamp
FROM swaps s
WHERE s.chain_id = 4663 AND s.pool_id = '${pool}' AND s.token_amount > 0
ORDER BY s.block_timestamp DESC, s.block_number DESC, s.log_index DESC
LIMIT 1;
`);
      assert.match(swapPlan.stdout, /Index Only Scan using swaps_pool_market_metrics_idx/);

      const artworkPlan = await psql(container, `
SET enable_seqscan = off;
EXPLAIN (COSTS OFF)
SELECT promotion_id
FROM ipfs_promotions
WHERE status = 'completed'
  AND image_cid = '${imageCid}'
  AND metadata_cid = '${metadataCid}'
LIMIT 1;
`);
      assert.match(
        artworkPlan.stdout,
        /Index Only Scan using ipfs_promotions_completed_cids_idx/,
      );
      const artworkPair = await psql(container, `
SELECT
  count(*) FILTER (
    WHERE image_cid = '${imageCid}' AND metadata_cid = '${metadataCid}'
  )::text,
  count(*) FILTER (
    WHERE image_cid = '${imageCid}' AND metadata_cid = '${imageCid}'
  )::text
FROM ipfs_promotions
WHERE status = 'completed';
`);
      assert.equal(artworkPair.stdout, "1\t0");

      const walletPlan = await psql(container, `
SET enable_seqscan = off;
PREPARE laypipe_wallet_plan(bigint, evm_address, bigint, integer, evm_address, integer) AS
${loadTypeScript("lib/server/wallet/read-model.ts").WALLET_POSITIONS_SQL};
EXPLAIN (COSTS OFF) EXECUTE laypipe_wallet_plan(4663, '${holder}', NULL, NULL, NULL, 13);
`);
      assert.match(walletPlan.stdout, /token_holder_balance_state_pkey/);
      assert.match(walletPlan.stdout, /admin_events_creator_subject_idx/);
      assert.match(walletPlan.stdout, /admin_events_creator_pool_idx/);

      await psql(container, `
UPDATE indexer_cursors
SET observed_at = now() + interval '3 seconds', last_run_status = 'bounded'
WHERE chain_id = 4663 AND stream = 'laypipe';
`);
      const staleWalletPlan = await psql(container, `
SET enable_seqscan = off;
PREPARE laypipe_stale_wallet_plan(bigint, evm_address, bigint, integer, evm_address, integer) AS
${loadTypeScript("lib/server/wallet/read-model.ts").WALLET_POSITIONS_SQL};
EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF, SUMMARY OFF)
EXECUTE laypipe_stale_wallet_plan(4663, '${holder}', NULL, NULL, NULL, 13);
`);
      assert.match(
        staleWalletPlan.stdout,
        /Index Scan using token_holder_balance_state_pkey[^\n]*\(never executed\)/,
      );
      assert.match(
        staleWalletPlan.stdout,
        /Index Only Scan using admin_events_creator_subject_idx[^\n]*\(never executed\)/,
      );
      await psql(container, `
UPDATE indexer_cursors
SET observed_at = now() + interval '4 seconds', last_run_status = 'caught-up'
WHERE chain_id = 4663 AND stream = 'laypipe';
`);

      const detail = await readModel.getLiveToken(database, token);
      assert.equal(detail.token.name, "Pipe Integration");
      assert.deepEqual(detail.token.socials, { website: "https://example.test" });
      const missing = await readModel.getLiveToken(database, address("1"));
      assert.equal(missing, null);

      const repositoryChain = 9999;
      const repositoryPool = hash("d");
      const repositoryToken = address("2");
      const repositoryBlock = hash("e");
      const repositoryTransactions = ["a", "b", "c", "d", "e"].map(hash);
      await psql(
        container,
        `SELECT laypipe_initialize_cursor(${repositoryChain}, 'laypipe-repository', 200);`,
      );
      await repository.ingestCanonicalBatch(
        {
          chainId: repositoryChain,
          stream: "laypipe-repository",
          expectedNextBlock: "200",
          blocks: [{
            number: "200",
            hash: repositoryBlock,
            parentHash: hash("f"),
            timestamp: "2026-08-11T12:00:00.000Z",
          }],
          logs: repositoryTransactions.map((transactionHash, logIndex) => ({
            blockNumber: "200",
            transactionHash,
            transactionIndex: logIndex,
            logIndex,
            contractAddress: address("3"),
            topics: [hash("4")],
            data: "0x",
            eventName: ["TokenLaunched", "FeeAccrued", "Burned", "RevenueAllocated", "TreasuryUpdated"][logIndex],
            decodedArgs: {},
          })),
          projections: [
            {
              kind: "launch",
              transactionHash: repositoryTransactions[0],
              logIndex: 0,
              tokenAddress: repositoryToken,
              poolId: repositoryPool,
              creatorAddress: address("4"),
              configId: "1",
              firstBuyIn: "0",
              firstBuyOut: "0",
              hookAddress: address("5"),
              feeRecipientAddress: address("4"),
              feeMode: "creator",
              name: "Repository SQL",
              symbol: "RSQL",
            },
            {
              kind: "fee",
              transactionHash: repositoryTransactions[1],
              logIndex: 1,
              feeKind: "accrued",
              poolId: repositoryPool,
              amount: "7",
            },
            {
              kind: "burn",
              transactionHash: repositoryTransactions[2],
              logIndex: 2,
              poolId: repositoryPool,
              tokenAddress: repositoryToken,
              pipedogIn: "9",
              tokensBurned: "18",
              pipedogBounty: "1",
            },
            {
              kind: "revenue",
              transactionHash: repositoryTransactions[3],
              logIndex: 3,
              routeKind: "allocated",
              amount: "100",
              sequesterAmount: "25",
              treasuryAmount: "25",
              operationsAmount: "50",
            },
            {
              kind: "admin",
              transactionHash: repositoryTransactions[4],
              logIndex: 4,
              contractAddress: address("3"),
              eventName: "TreasuryUpdated",
              subjectAddress: address("6"),
              details: { oldTreasury: address("7"), newTreasury: address("6") },
            },
          ],
        },
        repositoryDatabase(container),
      );
      const repositoryRows = await psql(container, `
SELECT
  (SELECT next_block::text FROM indexer_cursors WHERE chain_id = ${repositoryChain} AND stream = 'laypipe-repository'),
  (SELECT count(*)::text FROM launches WHERE chain_id = ${repositoryChain}),
  (SELECT count(*)::text FROM fee_events WHERE chain_id = ${repositoryChain}),
  (SELECT count(*)::text FROM burn_events WHERE chain_id = ${repositoryChain}),
  (SELECT count(*)::text FROM revenue_events WHERE chain_id = ${repositoryChain}),
  (SELECT count(*)::text FROM admin_events WHERE chain_id = ${repositoryChain});
`);
      assert.equal(repositoryRows.stdout, "201\t1\t1\t1\t1\t1");

      const replayed = await psql(container, `
SELECT
  (SELECT count(*)::text FROM chain_blocks WHERE chain_id = 4663),
  (SELECT count(*)::text FROM chain_events WHERE chain_id = 4663),
  (SELECT count(*)::text FROM swaps WHERE chain_id = 4663),
  (SELECT balance::text FROM token_balances WHERE chain_id = 4663 AND token_address = '${token}' AND holder_address = '${holder}'),
  (SELECT balance::text FROM token_holder_balance_state WHERE chain_id = 4663 AND token_address = '${token}' AND holder_address = '${holder}');
`);
      assert.equal(replayed.stdout, "2\t3\t1\t2000000000000000000000\t2000000000000000000000");
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
