import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { getDatabase } from "../../lib/server/db/neon";
import { buildMigrationCommand, migrationStatements } from "./migration-plan";

async function main() {
  const directory = resolve(process.cwd(), "db", "migrations");
  const names = (await readdir(directory))
    .filter((name) => /^\d+.*\.sql$/.test(name))
    .sort((left, right) => left.localeCompare(right));
  if (names.length === 0) throw new Error("No LayPipe database migrations found.");

  const database = await getDatabase();
  for (const name of names) {
    const source = await readFile(resolve(directory, name), "utf8");
    const sha256 = createHash("sha256").update(source).digest("hex");
    const statements = migrationStatements(source);
    await database.query(buildMigrationCommand({ name, sha256, statements }));
  }
}

await main();
