const BREAKPOINT = /^\s*--> statement-breakpoint\s*$/gm;
const MIGRATION_NAME = /^\d+[A-Za-z0-9_.-]*\.sql$/;
const SHA256 = /^[0-9a-f]{64}$/;

export function migrationStatements(source: string) {
  return source
    .split(BREAKPOINT)
    .map((statement) => statement.trim())
    .filter(Boolean);
}

function sqlLiteral(value: string) {
  return `'${value.replaceAll("'", "''")}'`;
}

function dollarQuote(value: string, baseTag: string) {
  let suffix = 0;
  while (true) {
    const tag = `$${baseTag}${suffix || ""}$`;
    if (!value.includes(tag)) return `${tag}${value}${tag}`;
    suffix += 1;
  }
}

/**
 * Builds one PostgreSQL command for one migration. The command takes the
 * transaction-scoped lock before creating or reading the ledger, then either
 * verifies the already-applied hash or executes every migration statement and
 * records the hash. A concurrent runner therefore re-checks state only after
 * it owns the same lock and cannot replay stale discovery results.
 */
export function buildMigrationCommand(options: {
  name: string;
  sha256: string;
  statements: readonly string[];
}) {
  if (!MIGRATION_NAME.test(options.name)) throw new Error("Invalid migration name.");
  if (!SHA256.test(options.sha256)) throw new Error("Invalid migration digest.");
  if (options.statements.length === 0) throw new Error("Migration contains no statements.");

  const name = sqlLiteral(options.name);
  const sha256 = sqlLiteral(options.sha256);
  const statementExecutions = options.statements
    .map(
      (statement, index) =>
        `    EXECUTE ${dollarQuote(statement, `laypipe_statement_${index}`)};`,
    )
    .join("\n");

  const body = `
DECLARE
  prior_hash text;
BEGIN
  PERFORM pg_advisory_xact_lock(4663, 1);

  EXECUTE $laypipe_migration_ledger$
    CREATE TABLE IF NOT EXISTS laypipe_schema_migrations (
      name text PRIMARY KEY,
      sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  $laypipe_migration_ledger$;

  SELECT ledger.sha256 INTO prior_hash
  FROM laypipe_schema_migrations AS ledger
  WHERE ledger.name = ${name};

  IF prior_hash IS NOT NULL THEN
    IF prior_hash <> ${sha256} THEN
      RAISE EXCEPTION 'Applied migration % was modified; refusing to continue.', ${name};
    END IF;
    RETURN;
  END IF;

${statementExecutions}

  INSERT INTO laypipe_schema_migrations (name, sha256)
  VALUES (${name}, ${sha256});
END;
`.trim();

  return `DO ${dollarQuote(body, "laypipe_migration_runner")};`;
}
