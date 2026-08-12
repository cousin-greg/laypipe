import { randomUUID } from "node:crypto";

import { redisCommand } from "../auth/redis";

const LEASE_KEY = "laypipe:indexer:lease:v1";
const LEASE_SECONDS = 60;
const RELEASE_SCRIPT = [
  "if redis.call('GET', KEYS[1]) == ARGV[1] then",
  "  return redis.call('DEL', KEYS[1])",
  "end",
  "return 0",
].join("\n");

export interface IndexerLease {
  acquired: boolean;
  release(): Promise<void>;
}

/**
 * Serializes Vercel Cron and webhook wake-ups across function instances.
 * The Postgres cursor CAS is still the final correctness boundary; this lease
 * prevents a losing invocation from returning 500 and causing a retry storm.
 */
export async function acquireIndexerLease(options?: {
  fetcher?: typeof fetch;
}): Promise<IndexerLease> {
  const token = randomUUID();
  const result = await redisCommand(
    ["SET", LEASE_KEY, token, "NX", "EX", LEASE_SECONDS],
    options?.fetcher,
  );
  if (result === null) {
    return { acquired: false, release: async () => undefined };
  }
  if (result !== undefined && result !== "OK") {
    throw new Error("Indexer lease store returned an invalid response.");
  }
  let released = false;
  return {
    acquired: true,
    async release() {
      if (released || result === undefined) return;
      released = true;
      try {
        await redisCommand(
          ["EVAL", RELEASE_SCRIPT, "1", LEASE_KEY, token],
          options?.fetcher,
        );
      } catch {
        // The 60-second TTL is the safe fallback. A completed canonical commit
        // must not be reported as failed solely because cleanup lost Redis.
      }
    },
  };
}
