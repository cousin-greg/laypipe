import { getMigrationDatabase, DATABASE_WRITE_TIMEOUT_MS, databaseFetchOptions } from
  "../../lib/server/db/neon";
import { buildRuntimeGrantsSql, validateRoleIdentifier } from "./runtime-grants-plan";

async function main() {
  const readRole = validateRoleIdentifier(
    process.env.LAYPIPE_DB_READ_ROLE,
    "LAYPIPE_DB_READ_ROLE",
  );
  const writeRole = validateRoleIdentifier(
    process.env.LAYPIPE_DB_WRITE_ROLE,
    "LAYPIPE_DB_WRITE_ROLE",
  );
  const serviceRole = validateRoleIdentifier(
    process.env.LAYPIPE_DB_SERVICE_ROLE,
    "LAYPIPE_DB_SERVICE_ROLE",
  );
  const sql = buildRuntimeGrantsSql({ readRole, writeRole, serviceRole });
  const database = await getMigrationDatabase();
  await database.query(sql, [], databaseFetchOptions(DATABASE_WRITE_TIMEOUT_MS));
  process.stdout.write(
    `Applied LayPipe runtime grants for ${readRole}, ${writeRole}, and ${serviceRole}.\n`,
  );
}

await main();
