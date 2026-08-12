import { normalizeBytes32, normalizeUint256, type DecimalInput } from "./model";

export interface StoredBlockIdentity {
  number: DecimalInput;
  hash: string;
}

export interface CommonAncestor {
  number: string;
  hash: `0x${string}`;
}

/**
 * Finds the newest stored block whose hash still matches the canonical RPC.
 * Callers should pass stored blocks newest-first and bound the lookback.
 */
export async function findCommonAncestor(
  storedNewestFirst: readonly StoredBlockIdentity[],
  canonicalHashAt: (blockNumber: string) => Promise<string | null>,
): Promise<CommonAncestor | null> {
  let previous: bigint | null = null;
  for (const candidate of storedNewestFirst) {
    const number = normalizeUint256(candidate.number, "Stored block number");
    const numeric = BigInt(number);
    if (previous !== null && numeric >= previous) {
      throw new Error("Stored fork candidates must be ordered newest-first.");
    }
    previous = numeric;
    const storedHash = normalizeBytes32(candidate.hash, "Stored block hash");
    const canonical = await canonicalHashAt(number);
    if (canonical && normalizeBytes32(canonical, "Canonical block hash") === storedHash) {
      return { number, hash: storedHash };
    }
  }
  return null;
}

export function requiresRollback(
  storedHash: string | null,
  canonicalHash: string | null,
) {
  if (storedHash === null) return false;
  if (canonicalHash === null) return true;
  return normalizeBytes32(storedHash) !== normalizeBytes32(canonicalHash);
}
