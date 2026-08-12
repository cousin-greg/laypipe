import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function loadTypeScript(relativePath) {
  const filename = resolve(root, relativePath);
  const loaded = { exports: {} };
  const output = ts.transpileModule(readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: filename,
  }).outputText;
  new Function("require", "module", "exports", "__filename", "__dirname", output)(
    require, loaded, loaded.exports, filename, dirname(filename),
  );
  return loaded.exports;
}

const database = loadTypeScript("lib/server/db/neon.ts");
const fingerprint = [
  `0000_production_read_model.sql:${"a".repeat(64)}`,
  `0001_runtime_security.sql:${"b".repeat(64)}`,
  `0002_market_leader_snapshot.sql:${"c".repeat(64)}`,
].join(",");

function identity(access) {
  const write = access === "write";
  const group = `laypipe_runtime_${access}`;
  return {
    database_id: "11111111-1111-4111-8111-111111111111",
    database_name: "laypipe",
    session_user: `laypipe_${access}_login`,
    current_user: `laypipe_${access}_login`,
    migration_fingerprint: fingerprint,
    migration_count: "3",
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
}

const wrapperExecuteFields = [
  "can_execute_initialize_cursor",
  "can_execute_advance_cursor",
  "can_execute_record_observation",
  "can_execute_rollback",
];

test("Neon pooled and direct URLs normalize only for the same endpoint and database", () => {
  const pooled = "postgres://reader:secret@ep-warm-pipe-pooler.us-east-2.aws.neon.tech/laypipe?sslmode=require";
  const direct = "postgres://writer:secret@ep-warm-pipe.us-east-2.aws.neon.tech/laypipe?sslmode=require";
  assert.equal(database.normalizedDatabaseEndpoint(pooled), database.normalizedDatabaseEndpoint(direct));
  assert.notEqual(
    database.normalizedDatabaseEndpoint(direct),
    database.normalizedDatabaseEndpoint(direct.replace("ep-warm-pipe", "ep-cloned-pipe")),
  );
  assert.notEqual(
    database.normalizedDatabaseEndpoint(direct),
    database.normalizedDatabaseEndpoint(direct.replace("/laypipe", "/laypipe_clone")),
  );
});

test("runtime identity helpers accept only exact safe read/write identities", () => {
  const read = identity("read");
  const write = identity("write");
  assert.strictEqual(database.attestRuntimeDatabaseIdentity(read, "read"), read);
  assert.strictEqual(database.attestRuntimeDatabaseIdentity(write, "write"), write);
  database.assertMatchingRuntimeDatabaseIdentities(read, write);

  for (const patch of [
    { role_superuser: true },
    { role_create_role: true },
    { direct_memberships: "laypipe_admin,laypipe_runtime_read" },
    { membership_admin_option: true },
    { membership_set_option: false },
    { expected_group_superuser: true },
    { expected_group_has_parent: true },
    { expected_group_owns_function: true },
    { owns_relation: true },
    { can_modify_identity: true },
    { can_modify_migration_ledger: true },
    { can_delete_or_truncate_any: true },
    { can_modify_canonical: true },
  ]) {
    assert.throws(
      () => database.attestRuntimeDatabaseIdentity({ ...read, ...patch }, "read"),
      /attestation|write capability/,
    );
  }
  assert.throws(
    () => database.attestRuntimeDatabaseIdentity({ ...write, can_modify_cursor_or_derived: true }, "write"),
    /attestation/,
  );
  for (const field of wrapperExecuteFields) {
    assert.throws(
      () => database.attestRuntimeDatabaseIdentity({ ...read, [field]: true }, "read"),
      /write capability/,
      `read attestation accepted injected ${field}`,
    );
    assert.throws(
      () => database.attestRuntimeDatabaseIdentity({ ...write, [field]: false }, "write"),
      /missing required capability/,
      `write attestation accepted missing ${field}`,
    );
  }
});

test("runtime pair matching rejects reused credentials, marker, database, and ledger drift", () => {
  const read = identity("read");
  const write = identity("write");
  for (const patch of [
    { session_user: read.session_user },
    { database_id: "22222222-2222-4222-8222-222222222222" },
    { database_name: "laypipe_clone" },
    { migration_fingerprint: fingerprint.replace("b".repeat(64), "d".repeat(64)) },
    { migration_count: "4" },
  ]) {
    assert.throws(
      () => database.assertMatchingRuntimeDatabaseIdentities(read, { ...write, ...patch }),
      /do not match/,
    );
  }
});
