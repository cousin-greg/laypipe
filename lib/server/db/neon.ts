import { neon } from "@neondatabase/serverless";

export type DbScalar = string | number | boolean | null;
export type DbParameter = DbScalar | readonly DbScalar[];
export type DbRow = Record<string, unknown>;

export type DbQueryPromise<T extends DbRow = DbRow> = Promise<T[]>;

export interface DbFetchOptions {
  fetchOptions?: {
    signal?: AbortSignal;
  };
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
      fetchOptions?: {
        signal?: AbortSignal;
      };
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

let clientPromise: Promise<DbClient> | null = null;

function readDatabaseUrl() {
  const value = process.env.DATABASE_URL?.trim();
  if (!value) {
    throw new Error("DATABASE_URL is required for the LayPipe data layer.");
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("DATABASE_URL is not a valid PostgreSQL connection URL.");
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error("DATABASE_URL must use the postgres or postgresql protocol.");
  }
  if (!parsed.hostname || !parsed.username || !parsed.pathname.slice(1)) {
    throw new Error("DATABASE_URL is missing its host, user, or database name.");
  }
  return value;
}

async function createClient() {
  const connectionString = readDatabaseUrl();
  // The connection is lazy so `next build` never needs a provisioned database,
  // while the static driver import keeps the production dependency traceable.
  return neon(connectionString) as unknown as DbClient;
}

export function getDatabase(): Promise<DbClient> {
  if (!clientPromise) clientPromise = createClient();
  return clientPromise;
}

/** Test-only reset; never call this from a request path. */
export function resetDatabaseClientForTests() {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("Database client reset is test-only.");
  }
  clientPromise = null;
}
