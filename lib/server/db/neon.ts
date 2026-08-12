import { neon } from "@neondatabase/serverless";

export type DbScalar = string | number | boolean | null;
export type DbParameter = DbScalar | readonly DbScalar[];
export type DbRow = Record<string, unknown>;
export type DbQueryPromise<T extends DbRow = DbRow> = Promise<T[]>;

export interface DbFetchOptions {
  fetchOptions?: { signal?: AbortSignal };
}

export interface DbTransactionQuery {
  query<T extends DbRow = DbRow>(
    text: string,
    params?: readonly DbParameter[],
    options?: DbFetchOptions,
  ): DbQueryPromise<T>;
}

export interface DbClient extends DbTransactionQuery {
  transaction<T extends readonly DbQueryPromise[]>(
    queries: (transaction: DbTransactionQuery) => T,
    options?: {
      isolationLevel?: "ReadUncommitted" | "ReadCommitted" | "RepeatableRead" | "Serializable";
      readOnly?: boolean;
      deferrable?: boolean;
      fetchOptions?: { signal?: AbortSignal };
    },
  ): Promise<{ [K in keyof T]: Awaited<T[K]> }>;
}

export const DATABASE_READ_TIMEOUT_MS = 3_000;
export const DATABASE_WRITE_TIMEOUT_MS = 10_000;

export function databaseFetchOptions(timeoutMs: number): DbFetchOptions {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) {
    throw new Error("Database timeout is outside the supported range.");
  }
  return { fetchOptions: { signal: AbortSignal.timeout(timeoutMs) } };
}

type RuntimeAccess = "read" | "write";
const DATABASE_URL_ENV = {
  read: "DATABASE_READ_URL",
  write: "DATABASE_WRITE_URL",
  migration: "DATABASE_MIGRATION_URL",
} as const;

export interface RuntimeDatabaseIdentity extends DbRow {
  database_id: string;
  database_name: string;
  session_user: string;
  current_user: string;
  migration_fingerprint: string;
  migration_count: string;
  expected_group: string;
  direct_memberships: string;
  in_expected_group: boolean;
  membership_admin_option: boolean;
  membership_inherit_option: boolean;
  membership_set_option: boolean;
  role_superuser: boolean;
  role_inherit: boolean;
  role_create_role: boolean;
  role_create_db: boolean;
  role_can_login: boolean;
  role_replication: boolean;
  role_bypass_rls: boolean;
  owns_relation: boolean;
  owns_function: boolean;
  owns_schema: boolean;
  expected_group_superuser: boolean;
  expected_group_inherit: boolean;
  expected_group_create_role: boolean;
  expected_group_create_db: boolean;
  expected_group_can_login: boolean;
  expected_group_replication: boolean;
  expected_group_bypass_rls: boolean;
  expected_group_has_parent: boolean;
  expected_group_owns_relation: boolean;
  expected_group_owns_function: boolean;
  expected_group_owns_schema: boolean;
  can_create_database: boolean;
  can_create_schema: boolean;
  can_create_temp: boolean;
  can_modify_identity: boolean;
  can_modify_migration_ledger: boolean;
  can_modify_canonical: boolean;
  has_exact_canonical_write: boolean;
  can_modify_cursor_or_derived: boolean;
  can_delete_or_truncate_any: boolean;
  can_read_launches: boolean;
  can_write_blocks: boolean;
  can_delete_blocks: boolean;
  can_write_cursor: boolean;
  can_write_derived: boolean;
  can_insert_promotion: boolean;
  can_update_promotion: boolean;
  can_delete_promotion: boolean;
  can_execute_initialize_cursor: boolean;
  can_execute_advance_cursor: boolean;
  can_execute_record_observation: boolean;
  can_execute_rollback: boolean;
}

export const RUNTIME_DATABASE_ATTESTATION_SQL = `/* laypipe:runtime-database-attestation */
SELECT identity.database_id::text,
  current_database()::text AS database_name,
  session_user::text, current_user::text,
  string_agg(m.name || ':' || m.sha256, ',' ORDER BY m.name)::text AS migration_fingerprint,
  count(m.name)::text AS migration_count,
  $1::text AS expected_group,
  COALESCE((
    SELECT string_agg(granted_role.rolname, ',' ORDER BY granted_role.rolname)
    FROM pg_auth_members membership
    JOIN pg_roles member_role ON member_role.oid = membership.member
    JOIN pg_roles granted_role ON granted_role.oid = membership.roleid
    WHERE member_role.rolname = session_user
  ), '')::text AS direct_memberships,
  pg_has_role(session_user, $1::name, 'MEMBER') AS in_expected_group,
  COALESCE((
    SELECT membership.admin_option
    FROM pg_auth_members membership
    JOIN pg_roles member_role ON member_role.oid = membership.member
    JOIN pg_roles granted_role ON granted_role.oid = membership.roleid
    WHERE member_role.rolname = session_user AND granted_role.rolname = $1::text
  ), false) AS membership_admin_option,
  COALESCE((
    SELECT membership.inherit_option
    FROM pg_auth_members membership
    JOIN pg_roles member_role ON member_role.oid = membership.member
    JOIN pg_roles granted_role ON granted_role.oid = membership.roleid
    WHERE member_role.rolname = session_user AND granted_role.rolname = $1::text
  ), false) AS membership_inherit_option,
  COALESCE((
    SELECT membership.set_option
    FROM pg_auth_members membership
    JOIN pg_roles member_role ON member_role.oid = membership.member
    JOIN pg_roles granted_role ON granted_role.oid = membership.roleid
    WHERE member_role.rolname = session_user AND granted_role.rolname = $1::text
  ), false) AS membership_set_option,
  (SELECT role.rolsuper FROM pg_roles role WHERE role.rolname = session_user) AS role_superuser,
  (SELECT role.rolinherit FROM pg_roles role WHERE role.rolname = session_user) AS role_inherit,
  (SELECT role.rolcreaterole FROM pg_roles role WHERE role.rolname = session_user) AS role_create_role,
  (SELECT role.rolcreatedb FROM pg_roles role WHERE role.rolname = session_user) AS role_create_db,
  (SELECT role.rolcanlogin FROM pg_roles role WHERE role.rolname = session_user) AS role_can_login,
  (SELECT role.rolreplication FROM pg_roles role WHERE role.rolname = session_user) AS role_replication,
  (SELECT role.rolbypassrls FROM pg_roles role WHERE role.rolname = session_user) AS role_bypass_rls,
  EXISTS (
    SELECT 1 FROM pg_class object
    JOIN pg_roles role ON role.oid = object.relowner
    WHERE role.rolname = session_user
  ) AS owns_relation,
  EXISTS (
    SELECT 1 FROM pg_proc object
    JOIN pg_roles role ON role.oid = object.proowner
    WHERE role.rolname = session_user
  ) AS owns_function,
  EXISTS (
    SELECT 1 FROM pg_namespace object
    JOIN pg_roles role ON role.oid = object.nspowner
    WHERE role.rolname = session_user
  ) AS owns_schema,
  (SELECT role.rolsuper FROM pg_roles role WHERE role.rolname = $1::text)
    AS expected_group_superuser,
  (SELECT role.rolinherit FROM pg_roles role WHERE role.rolname = $1::text)
    AS expected_group_inherit,
  (SELECT role.rolcreaterole FROM pg_roles role WHERE role.rolname = $1::text)
    AS expected_group_create_role,
  (SELECT role.rolcreatedb FROM pg_roles role WHERE role.rolname = $1::text)
    AS expected_group_create_db,
  (SELECT role.rolcanlogin FROM pg_roles role WHERE role.rolname = $1::text)
    AS expected_group_can_login,
  (SELECT role.rolreplication FROM pg_roles role WHERE role.rolname = $1::text)
    AS expected_group_replication,
  (SELECT role.rolbypassrls FROM pg_roles role WHERE role.rolname = $1::text)
    AS expected_group_bypass_rls,
  EXISTS (
    SELECT 1 FROM pg_auth_members membership
    JOIN pg_roles expected_role ON expected_role.oid = membership.member
    WHERE expected_role.rolname = $1::text
  ) AS expected_group_has_parent,
  EXISTS (
    SELECT 1 FROM pg_class object
    JOIN pg_roles role ON role.oid = object.relowner
    WHERE role.rolname = $1::text
  ) AS expected_group_owns_relation,
  EXISTS (
    SELECT 1 FROM pg_proc object
    JOIN pg_roles role ON role.oid = object.proowner
    WHERE role.rolname = $1::text
  ) AS expected_group_owns_function,
  EXISTS (
    SELECT 1 FROM pg_namespace object
    JOIN pg_roles role ON role.oid = object.nspowner
    WHERE role.rolname = $1::text
  ) AS expected_group_owns_schema,
  has_database_privilege(session_user, current_database(), 'CREATE') AS can_create_database,
  has_schema_privilege(session_user, 'public', 'CREATE') AS can_create_schema,
  has_database_privilege(session_user, current_database(), 'TEMPORARY') AS can_create_temp,
  has_table_privilege(session_user, 'laypipe_database_identity', 'INSERT')
    OR has_table_privilege(session_user, 'laypipe_database_identity', 'UPDATE')
    OR has_table_privilege(session_user, 'laypipe_database_identity', 'DELETE')
    OR has_table_privilege(session_user, 'laypipe_database_identity', 'TRUNCATE') AS can_modify_identity,
  has_table_privilege(session_user, 'laypipe_schema_migrations', 'INSERT')
    OR has_table_privilege(session_user, 'laypipe_schema_migrations', 'UPDATE')
    OR has_table_privilege(session_user, 'laypipe_schema_migrations', 'DELETE')
    OR has_table_privilege(session_user, 'laypipe_schema_migrations', 'TRUNCATE') AS can_modify_migration_ledger,
  EXISTS (
    SELECT 1 FROM unnest(ARRAY[
      'chain_blocks', 'chain_events', 'launches', 'swaps', 'fee_events',
      'burn_events', 'revenue_events', 'token_transfers', 'admin_events'
    ]) table_name
    WHERE has_table_privilege(session_user, table_name, 'INSERT')
       OR has_table_privilege(session_user, table_name, 'UPDATE')
  ) AS can_modify_canonical,
  NOT EXISTS (
    SELECT 1 FROM unnest(ARRAY[
      'chain_blocks', 'chain_events', 'launches', 'swaps', 'fee_events',
      'burn_events', 'revenue_events', 'token_transfers', 'admin_events'
    ]) table_name
    WHERE NOT has_table_privilege(session_user, table_name, 'INSERT')
       OR NOT has_table_privilege(session_user, table_name, 'UPDATE')
  ) AS has_exact_canonical_write,
  EXISTS (
    SELECT 1 FROM unnest(ARRAY[
      'indexer_cursors', 'pool_market_totals', 'token_holder_balance_state',
      'market_leader_snapshots', 'market_leader_entries'
    ]) table_name
    WHERE has_table_privilege(session_user, table_name, 'INSERT')
       OR has_table_privilege(session_user, table_name, 'UPDATE')
       OR has_table_privilege(session_user, table_name, 'DELETE')
       OR has_table_privilege(session_user, table_name, 'TRUNCATE')
  ) AS can_modify_cursor_or_derived,
  EXISTS (
    SELECT 1 FROM unnest(ARRAY[
      'laypipe_schema_migrations', 'laypipe_database_identity', 'chain_blocks',
      'chain_events', 'indexer_cursors', 'launches', 'swaps',
      'pool_market_totals', 'fee_events', 'burn_events', 'revenue_events',
      'token_transfers', 'token_holder_balance_state', 'admin_events',
      'ipfs_promotions', 'market_leader_snapshots', 'market_leader_entries'
    ]) table_name
    WHERE has_table_privilege(session_user, table_name, 'DELETE')
       OR has_table_privilege(session_user, table_name, 'TRUNCATE')
  ) AS can_delete_or_truncate_any,
  has_table_privilege(session_user, 'launches', 'SELECT') AS can_read_launches,
  has_table_privilege(session_user, 'chain_blocks', 'INSERT') AS can_write_blocks,
  has_table_privilege(session_user, 'chain_blocks', 'DELETE') AS can_delete_blocks,
  has_table_privilege(session_user, 'indexer_cursors', 'UPDATE') AS can_write_cursor,
  has_table_privilege(session_user, 'pool_market_totals', 'UPDATE')
    OR has_table_privilege(session_user, 'token_holder_balance_state', 'UPDATE')
    OR has_table_privilege(session_user, 'market_leader_snapshots', 'UPDATE')
    OR has_table_privilege(session_user, 'market_leader_entries', 'UPDATE') AS can_write_derived,
  has_table_privilege(session_user, 'ipfs_promotions', 'INSERT') AS can_insert_promotion,
  has_table_privilege(session_user, 'ipfs_promotions', 'UPDATE') AS can_update_promotion,
  has_table_privilege(session_user, 'ipfs_promotions', 'DELETE') AS can_delete_promotion,
  has_function_privilege(session_user,
    'public.laypipe_runtime_initialize_cursor(bigint,text,bigint)',
    'EXECUTE') AS can_execute_initialize_cursor,
  has_function_privilege(session_user,
    'public.laypipe_runtime_advance_cursor(bigint,text,bigint,bigint,evm_bytes32)',
    'EXECUTE') AS can_execute_advance_cursor,
  has_function_privilege(session_user,
    'public.laypipe_runtime_record_observation(bigint,text,bigint,timestamp with time zone,text)',
    'EXECUTE') AS can_execute_record_observation,
  has_function_privilege(session_user,
    'public.laypipe_runtime_rollback_chain(bigint,bigint,evm_bytes32)',
    'EXECUTE') AS can_execute_rollback
FROM laypipe_database_identity identity
CROSS JOIN laypipe_schema_migrations m
WHERE identity.singleton
GROUP BY identity.database_id`;

let clients: Record<RuntimeAccess, DbClient | null> = { read: null, write: null };
let runtimePairPromise: Promise<{ read: DbClient; write: DbClient }> | null = null;

function parseDatabaseUrl(variable: string) {
  const value = process.env[variable]?.trim();
  if (!value) throw new Error(`${variable} is required for the LayPipe data layer.`);
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error(`${variable} is not a valid PostgreSQL connection URL.`); }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new Error(`${variable} must use the postgres or postgresql protocol.`);
  }
  if (!parsed.hostname || !parsed.username || !parsed.pathname.slice(1)) {
    throw new Error(`${variable} is missing its host, user, or database name.`);
  }
  return { value, parsed };
}

export function normalizedDatabaseEndpoint(value: string) {
  const { parsed } = (() => {
    const parsed = new URL(value);
    return { parsed };
  })();
  let hostname = parsed.hostname.toLowerCase();
  if (hostname.endsWith(".neon.tech")) {
    const labels = hostname.split(".");
    labels[0] = labels[0]!.replace(/-pooler$/, "");
    hostname = labels.join(".");
  }
  const database = decodeURIComponent(parsed.pathname.slice(1));
  return `${hostname}:${parsed.port || "5432"}/${database}`;
}

function expectedRole(access: RuntimeAccess) {
  const variable = access === "read" ? "LAYPIPE_DB_READ_ROLE" : "LAYPIPE_DB_WRITE_ROLE";
  const value = process.env[variable]?.trim();
  if (!value || !/^[a-z_][a-z0-9_]{0,62}$/.test(value) || value.startsWith("pg_")) {
    throw new Error(`${variable} is invalid.`);
  }
  return value;
}

function boolean(value: unknown, label: string) {
  if (typeof value !== "boolean") throw new Error(`${label} attestation was invalid.`);
  return value;
}

function validMigrationFingerprint(value: unknown, migrationCount: string) {
  if (typeof value !== "string" || value.length === 0 || value.length > 131_072) return false;
  const count = Number(migrationCount);
  if (!Number.isSafeInteger(count) || count < 2 || count > 1_000) return false;
  const entries = value.split(",");
  return entries.length === count && entries.every((entry) => (
    /^\d+[A-Za-z0-9_.-]*\.sql:[0-9a-f]{64}$/.test(entry)
  ));
}

export function attestRuntimeDatabaseIdentity(
  row: RuntimeDatabaseIdentity | undefined,
  access: RuntimeAccess,
) {
  if (!row || typeof row.database_id !== "string" || typeof row.database_name !== "string"
      || typeof row.session_user !== "string" || typeof row.current_user !== "string"
      || row.session_user !== row.current_user || typeof row.migration_count !== "string"
      || !/^\d+$/.test(row.migration_count)
      || !validMigrationFingerprint(row.migration_fingerprint, row.migration_count)
      || typeof row.expected_group !== "string"
      || !/^[a-z_][a-z0-9_]{0,62}$/.test(row.expected_group)
      || typeof row.direct_memberships !== "string") {
    throw new Error(`LayPipe ${access} database identity attestation failed.`);
  }
  const commonDenied = [row.can_create_database, row.can_create_schema, row.can_create_temp,
    row.can_modify_identity, row.can_modify_migration_ledger,
    row.can_modify_cursor_or_derived, row.can_delete_or_truncate_any,
    row.can_delete_blocks, row.can_write_cursor, row.can_write_derived,
    row.can_delete_promotion, row.role_superuser, row.role_create_role, row.role_create_db,
    row.role_replication, row.role_bypass_rls, row.owns_relation, row.owns_function,
    row.owns_schema, row.membership_admin_option, row.expected_group_superuser,
    row.expected_group_create_role, row.expected_group_create_db,
    row.expected_group_can_login, row.expected_group_replication,
    row.expected_group_bypass_rls, row.expected_group_has_parent,
    row.expected_group_owns_relation, row.expected_group_owns_function,
    row.expected_group_owns_schema].map((value, index) =>
      boolean(value, `Denied capability ${index}`));
  if (!boolean(row.in_expected_group, "Role membership") || commonDenied.some(Boolean)
      || row.direct_memberships !== row.expected_group
      || !boolean(row.role_can_login, "LOGIN role")
      || !boolean(row.role_inherit, "INHERIT role")
      || !boolean(row.membership_inherit_option, "Membership INHERIT option")
      || !boolean(row.membership_set_option, "Membership SET option")
      || !boolean(row.expected_group_inherit, "Expected group INHERIT role")
      || !boolean(row.can_read_launches, "Launch read")) {
    throw new Error(`LayPipe ${access} database role attestation failed.`);
  }
  const wrapperExecute = [
    row.can_execute_initialize_cursor,
    row.can_execute_advance_cursor,
    row.can_execute_record_observation,
    row.can_execute_rollback,
  ].map((value, index) => boolean(value, `Runtime wrapper EXECUTE ${index}`));
  if (access === "read") {
    if (boolean(row.can_modify_canonical, "Canonical write")
        || boolean(row.has_exact_canonical_write, "Canonical write matrix")
        || boolean(row.can_write_blocks, "Block write") || boolean(row.can_insert_promotion, "Promotion insert")
        || boolean(row.can_update_promotion, "Promotion update") || wrapperExecute.some(Boolean)) {
      throw new Error("LayPipe read database role has write capability.");
    }
  } else if (!boolean(row.can_modify_canonical, "Canonical write")
      || !boolean(row.has_exact_canonical_write, "Canonical write matrix")
      || !boolean(row.can_write_blocks, "Block write")
      || !boolean(row.can_insert_promotion, "Promotion insert")
      || !boolean(row.can_update_promotion, "Promotion update")
      || wrapperExecute.some((value) => !value)) {
    throw new Error("LayPipe write database role is missing required capability.");
  }
  return row;
}

export function assertMatchingRuntimeDatabaseIdentities(
  readIdentity: RuntimeDatabaseIdentity,
  writeIdentity: RuntimeDatabaseIdentity,
) {
  if (readIdentity.session_user === writeIdentity.session_user
      || readIdentity.database_id !== writeIdentity.database_id
      || readIdentity.database_name !== writeIdentity.database_name
      || readIdentity.migration_fingerprint !== writeIdentity.migration_fingerprint
      || readIdentity.migration_count !== writeIdentity.migration_count) {
    throw new Error("LayPipe read and write database identities do not match.");
  }
}

async function createRuntimePair() {
  if (process.env.NODE_ENV === "production" && process.env.DATABASE_MIGRATION_URL?.trim()) {
    throw new Error("DATABASE_MIGRATION_URL must never be present in production runtime.");
  }
  const readUrl = parseDatabaseUrl(DATABASE_URL_ENV.read);
  const writeUrl = parseDatabaseUrl(DATABASE_URL_ENV.write);
  if (normalizedDatabaseEndpoint(readUrl.value) !== normalizedDatabaseEndpoint(writeUrl.value)) {
    throw new Error("LayPipe read and write URLs do not target the same database endpoint.");
  }
  const read = neon(readUrl.value) as unknown as DbClient;
  const write = neon(writeUrl.value) as unknown as DbClient;
  const [readRows, writeRows] = await Promise.all([
    read.query<RuntimeDatabaseIdentity>(RUNTIME_DATABASE_ATTESTATION_SQL, [expectedRole("read")], databaseFetchOptions(DATABASE_READ_TIMEOUT_MS)),
    write.query<RuntimeDatabaseIdentity>(RUNTIME_DATABASE_ATTESTATION_SQL, [expectedRole("write")], databaseFetchOptions(DATABASE_READ_TIMEOUT_MS)),
  ]);
  const readIdentity = attestRuntimeDatabaseIdentity(readRows[0], "read");
  const writeIdentity = attestRuntimeDatabaseIdentity(writeRows[0], "write");
  if (readRows.length !== 1 || writeRows.length !== 1) {
    throw new Error("LayPipe read and write database identities do not match.");
  }
  assertMatchingRuntimeDatabaseIdentities(readIdentity, writeIdentity);
  clients = { read, write };
  return clients as { read: DbClient; write: DbClient };
}

async function runtimePair() {
  if (!runtimePairPromise) runtimePairPromise = createRuntimePair();
  try { return await runtimePairPromise; } catch (error) { runtimePairPromise = null; throw error; }
}

export async function getReadDatabase() { return (await runtimePair()).read; }
export async function getWriteDatabase() { return (await runtimePair()).write; }

/** Operator-only. Never import this from an application request or worker route. */
export function getMigrationDatabase(): Promise<DbClient> {
  if (process.env.NODE_ENV === "production") {
    throw new Error("Migration-owner database access is forbidden in production runtime.");
  }
  return Promise.resolve(neon(parseDatabaseUrl(DATABASE_URL_ENV.migration).value) as unknown as DbClient);
}

/** Test-only reset; never call this from a request path. */
export function resetDatabaseClientForTests() {
  if (process.env.NODE_ENV !== "test") throw new Error("Database client reset is test-only.");
  clients = { read: null, write: null };
  runtimePairPromise = null;
}
