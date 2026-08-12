import type { Address, Hex } from "@/lib/web3/types";
import { isAddress, isTransactionHash } from "@/lib/web3/types";

export const PENDING_CLAIMS_STORAGE_KEY = "laypipe.pending-claims.v1";
const MAX_PENDING_CLAIMS = 20;
const MAX_PENDING_AGE_MS = 30 * 24 * 60 * 60 * 1_000;
const EXPECTED_INTENT_KEYS = ["chainId", "hash", "invokedAt", "poolId", "wallet"] as const;

export interface PendingClaimIntent {
  chainId: 4663;
  wallet: Address;
  poolId: Hex;
  hash: Hex | null;
  invokedAt: number;
}

export type PendingClaimRecoveryReason =
  | "unreadable"
  | "malformed"
  | "over-cap"
  | "expired"
  | "corrupt";

export type PendingClaimRecoveryState = {
  status: "recovery-required";
  reason: PendingClaimRecoveryReason;
};

export type PendingClaimState =
  | { status: "clear" }
  | { status: "pending"; intent: PendingClaimIntent }
  | PendingClaimRecoveryState;

export class PendingClaimPersistenceError extends Error {
  constructor(
    public readonly reason: PendingClaimRecoveryReason,
    message: string,
    public readonly causeData?: unknown,
  ) {
    super(message);
    this.name = "PendingClaimPersistenceError";
  }
}

function persistenceError(
  reason: PendingClaimRecoveryReason,
  message: string,
  causeData?: unknown,
): never {
  throw new PendingClaimPersistenceError(reason, message, causeData);
}

function isPoolId(value: unknown): value is Hex {
  return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);
}

function parseIntent(value: unknown, now: number): PendingClaimIntent {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return persistenceError("corrupt", "A saved pending claim was not an object.");
  }
  const keys = Object.keys(value).sort();
  if (
    keys.length !== EXPECTED_INTENT_KEYS.length ||
    EXPECTED_INTENT_KEYS.some((key, index) => key !== keys[index])
  ) {
    return persistenceError("corrupt", "A saved pending claim had unexpected fields.");
  }
  const candidate = value as Partial<PendingClaimIntent>;
  if (
    candidate.chainId !== 4663 ||
    typeof candidate.wallet !== "string" ||
    !isAddress(candidate.wallet) ||
    !isPoolId(candidate.poolId) ||
    (candidate.hash !== null &&
      (typeof candidate.hash !== "string" || !isTransactionHash(candidate.hash))) ||
    typeof candidate.invokedAt !== "number" ||
    !Number.isSafeInteger(candidate.invokedAt) ||
    candidate.invokedAt <= 0 ||
    candidate.invokedAt > now + 60_000
  ) {
    return persistenceError("corrupt", "A saved pending claim failed integrity checks.");
  }
  if (now - candidate.invokedAt > MAX_PENDING_AGE_MS) {
    return persistenceError("expired", "A saved pending claim exceeded the recovery window.");
  }
  return {
    chainId: 4663,
    wallet: candidate.wallet,
    poolId: candidate.poolId,
    hash: candidate.hash,
    invokedAt: candidate.invokedAt,
  };
}

function readAll(storage: Storage, now = Date.now()) {
  let raw: string | null;
  try {
    raw = storage.getItem(PENDING_CLAIMS_STORAGE_KEY);
  } catch (cause) {
    return persistenceError("unreadable", "Pending claim storage could not be read.", cause);
  }
  if (raw === null) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    return persistenceError("malformed", "Pending claim storage was not valid JSON.", cause);
  }
  if (!Array.isArray(parsed)) {
    return persistenceError("malformed", "Pending claim storage was not a list.");
  }
  if (parsed.length > MAX_PENDING_CLAIMS) {
    return persistenceError("over-cap", "Pending claim storage exceeded its safety bound.");
  }

  const intents = parsed.map((value) => parseIntent(value, now));
  const wallets = new Set<string>();
  for (const intent of intents) {
    const wallet = intent.wallet.toLowerCase();
    if (wallets.has(wallet)) {
      return persistenceError("corrupt", "Multiple pending claims were saved for one wallet.");
    }
    wallets.add(wallet);
  }
  return intents;
}

function writeAll(storage: Storage, intents: PendingClaimIntent[]) {
  if (intents.length > MAX_PENDING_CLAIMS) {
    return persistenceError("over-cap", "Pending claim storage exceeded its safety bound.");
  }
  const serialized = JSON.stringify(intents);
  try {
    storage.setItem(PENDING_CLAIMS_STORAGE_KEY, serialized);
    if (storage.getItem(PENDING_CLAIMS_STORAGE_KEY) !== serialized) {
      return persistenceError("unreadable", "Pending claim storage did not retain the write.");
    }
  } catch (cause) {
    return persistenceError("unreadable", "Pending claim storage could not be written.", cause);
  }
}

function sameIntent(intent: PendingClaimIntent, wallet: Address, poolId: Hex) {
  return (
    intent.wallet.toLowerCase() === wallet.toLowerCase() &&
    intent.poolId.toLowerCase() === poolId.toLowerCase()
  );
}

function exactIntent(
  candidate: PendingClaimIntent,
  expected: PendingClaimIntent,
) {
  return (
    sameIntent(candidate, expected.wallet, expected.poolId) &&
    candidate.hash?.toLowerCase() === expected.hash?.toLowerCase() &&
    candidate.invokedAt === expected.invokedAt
  );
}

export function pendingClaimRecoveryFromError(error: unknown): PendingClaimRecoveryState {
  return {
    status: "recovery-required",
    reason:
      error instanceof PendingClaimPersistenceError ? error.reason : "unreadable",
  };
}

export function readPendingClaimStateForWallet(
  storage: Storage,
  wallet: Address,
  now = Date.now(),
): PendingClaimState {
  try {
    const intent = readAll(storage, now).find(
      (candidate) => candidate.wallet.toLowerCase() === wallet.toLowerCase(),
    );
    return intent ? { status: "pending", intent } : { status: "clear" };
  } catch (error) {
    return pendingClaimRecoveryFromError(error);
  }
}

export function savePendingClaim(
  storage: Storage,
  intent: PendingClaimIntent,
  now = Date.now(),
) {
  const validated = parseIntent(intent, now);
  const current = readAll(storage, now);
  if (
    current.some(
      (candidate) => candidate.wallet.toLowerCase() === validated.wallet.toLowerCase(),
    )
  ) {
    return persistenceError("corrupt", "This wallet already has an unresolved claim.");
  }
  current.push(validated);
  writeAll(storage, current);
}

export function savePendingClaimHash(
  storage: Storage,
  wallet: Address,
  poolId: Hex,
  hash: Hex,
  invokedAt = Date.now(),
) {
  const now = Date.now();
  const current = readAll(storage, now);
  const intent = current.find((candidate) => sameIntent(candidate, wallet, poolId));
  if (intent) {
    intent.hash = hash;
    parseIntent(intent, now);
  } else {
    if (
      current.some(
        (candidate) => candidate.wallet.toLowerCase() === wallet.toLowerCase(),
      )
    ) {
      return persistenceError("corrupt", "A wallet already has another unresolved claim.");
    }
    current.push(parseIntent({ chainId: 4663, wallet, poolId, hash, invokedAt }, now));
  }
  writeAll(storage, current);
}

export function removePendingClaim(
  storage: Storage,
  wallet: Address,
  poolId: Hex,
) {
  writeAll(
    storage,
    readAll(storage).filter((candidate) => !sameIntent(candidate, wallet, poolId)),
  );
}

export function removeExactPendingClaim(
  storage: Storage,
  expected: PendingClaimIntent,
  now = Date.now(),
) {
  const validated = parseIntent(expected, now);
  if (validated.hash === null) {
    return persistenceError(
      "corrupt",
      "A canonically resolved claim must include its exact transaction hash.",
    );
  }
  const current = readAll(storage, now);
  const walletIndex = current.findIndex(
    (candidate) =>
      candidate.wallet.toLowerCase() === validated.wallet.toLowerCase(),
  );
  if (walletIndex < 0 || !exactIntent(current[walletIndex]!, validated)) {
    return persistenceError(
      "corrupt",
      "The canonically resolved claim does not match the saved exact intent.",
    );
  }
  current.splice(walletIndex, 1);
  writeAll(storage, current);
}

export function removeExactUnsubmittedPendingClaim(
  storage: Storage,
  expected: PendingClaimIntent,
  now = Date.now(),
) {
  const validated = parseIntent(expected, now);
  if (validated.hash !== null) {
    return persistenceError(
      "corrupt",
      "Only an exact hashless claim intent can be cleared manually.",
    );
  }
  const current = readAll(storage, now);
  const walletIndex = current.findIndex(
    (candidate) => candidate.wallet.toLowerCase() === validated.wallet.toLowerCase(),
  );
  if (walletIndex < 0 || !exactIntent(current[walletIndex]!, validated)) {
    return persistenceError(
      "corrupt",
      "The hashless claim intent no longer matches the saved exact record.",
    );
  }
  current.splice(walletIndex, 1);
  writeAll(storage, current);
}

export function resetPendingClaimForWallet(storage: Storage, wallet: Address) {
  let value: unknown;
  try {
    const raw = storage.getItem(PENDING_CLAIMS_STORAGE_KEY);
    if (raw === null) return;
    value = JSON.parse(raw);
  } catch (cause) {
    return persistenceError(
      "unreadable",
      "The claim store cannot be safely reset for one wallet.",
      cause,
    );
  }
  if (!Array.isArray(value) || value.length > MAX_PENDING_CLAIMS) {
    return persistenceError("malformed", "The claim store cannot be safely reset for one wallet.");
  }
  const retained = value.filter((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return persistenceError("corrupt", "The claim store has an unowned record.");
    }
    const owner = (entry as { wallet?: unknown }).wallet;
    if (typeof owner !== "string" || !isAddress(owner)) {
      return persistenceError("corrupt", "The claim store has an unowned record.");
    }
    return owner.toLowerCase() !== wallet.toLowerCase();
  }) as PendingClaimIntent[];
  writeAll(storage, retained);
}

export function resetPendingClaimStore(storage: Storage) {
  try {
    storage.removeItem(PENDING_CLAIMS_STORAGE_KEY);
    if (storage.getItem(PENDING_CLAIMS_STORAGE_KEY) !== null) {
      return persistenceError("unreadable", "Pending claim storage could not be cleared.");
    }
  } catch (cause) {
    return persistenceError("unreadable", "Pending claim storage could not be cleared.", cause);
  }
}
