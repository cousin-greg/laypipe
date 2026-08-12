import { getAddress } from "viem";

import type { Address, Hex } from "@/lib/web3/types";
import {
  isAddress,
  isTransactionHash,
  sameAddress,
} from "@/lib/web3/types";

export const PENDING_CREATOR_UPDATES_STORAGE_KEY =
  "laypipe.pending-creator-updates.v1";
const MAX_PENDING_CREATOR_UPDATES = 20;
const MAX_PENDING_AGE_MS = 30 * 24 * 60 * 60 * 1_000;
const EXPECTED_INTENT_KEYS = [
  "chainId",
  "hash",
  "hook",
  "invokedAt",
  "newCreator",
  "oldCreator",
  "poolId",
  "wallet",
] as const;

export interface PendingCreatorUpdateIntent {
  chainId: 4663;
  wallet: Address;
  hook: Address;
  poolId: Hex;
  oldCreator: Address;
  newCreator: Address;
  hash: Hex | null;
  invokedAt: number;
}

export type PendingCreatorUpdateRecoveryReason =
  | "unreadable"
  | "malformed"
  | "over-cap"
  | "expired"
  | "corrupt";

export type PendingCreatorUpdateRecoveryState = {
  status: "recovery-required";
  reason: PendingCreatorUpdateRecoveryReason;
};

export type PendingCreatorUpdateState =
  | { status: "clear" }
  | { status: "pending"; intent: PendingCreatorUpdateIntent }
  | PendingCreatorUpdateRecoveryState;

export class PendingCreatorUpdatePersistenceError extends Error {
  constructor(
    public readonly reason: PendingCreatorUpdateRecoveryReason,
    message: string,
    public readonly causeData?: unknown,
  ) {
    super(message);
    this.name = "PendingCreatorUpdatePersistenceError";
  }
}

function persistenceError(
  reason: PendingCreatorUpdateRecoveryReason,
  message: string,
  causeData?: unknown,
): never {
  throw new PendingCreatorUpdatePersistenceError(reason, message, causeData);
}

function isPoolId(value: unknown): value is Hex {
  return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);
}

function isChecksummedAddress(value: string) {
  try {
    return getAddress(value) === value;
  } catch {
    return false;
  }
}

function parseIntent(
  value: unknown,
  now: number,
): PendingCreatorUpdateIntent {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return persistenceError(
      "corrupt",
      "A saved pending creator handoff was not an object.",
    );
  }
  const keys = Object.keys(value).sort();
  if (
    keys.length !== EXPECTED_INTENT_KEYS.length ||
    EXPECTED_INTENT_KEYS.some((key, index) => key !== keys[index])
  ) {
    return persistenceError(
      "corrupt",
      "A saved pending creator handoff had unexpected fields.",
    );
  }
  const candidate = value as Partial<PendingCreatorUpdateIntent>;
  if (
    candidate.chainId !== 4663 ||
    typeof candidate.wallet !== "string" ||
    !isAddress(candidate.wallet) ||
    typeof candidate.hook !== "string" ||
    !isAddress(candidate.hook) ||
    BigInt(candidate.hook) === BigInt(0) ||
    !isPoolId(candidate.poolId) ||
    typeof candidate.oldCreator !== "string" ||
    !isAddress(candidate.oldCreator) ||
    typeof candidate.newCreator !== "string" ||
    !isAddress(candidate.newCreator) ||
    !isChecksummedAddress(candidate.newCreator) ||
    BigInt(candidate.newCreator) === BigInt(0) ||
    !sameAddress(candidate.wallet, candidate.oldCreator) ||
    sameAddress(candidate.oldCreator, candidate.newCreator) ||
    (candidate.hash !== null &&
      (typeof candidate.hash !== "string" ||
        !isTransactionHash(candidate.hash))) ||
    typeof candidate.invokedAt !== "number" ||
    !Number.isSafeInteger(candidate.invokedAt) ||
    candidate.invokedAt <= 0 ||
    candidate.invokedAt > now + 60_000
  ) {
    return persistenceError(
      "corrupt",
      "A saved pending creator handoff failed integrity checks.",
    );
  }
  if (now - candidate.invokedAt > MAX_PENDING_AGE_MS) {
    return persistenceError(
      "expired",
      "A saved pending creator handoff exceeded the recovery window.",
    );
  }
  return {
    chainId: 4663,
    wallet: candidate.wallet,
    hook: candidate.hook,
    poolId: candidate.poolId,
    oldCreator: candidate.oldCreator,
    newCreator: candidate.newCreator,
    hash: candidate.hash,
    invokedAt: candidate.invokedAt,
  };
}

function readAll(storage: Storage, now = Date.now()) {
  let raw: string | null;
  try {
    raw = storage.getItem(PENDING_CREATOR_UPDATES_STORAGE_KEY);
  } catch (cause) {
    return persistenceError(
      "unreadable",
      "Pending creator handoff storage could not be read.",
      cause,
    );
  }
  if (raw === null) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    return persistenceError(
      "malformed",
      "Pending creator handoff storage was not valid JSON.",
      cause,
    );
  }
  if (!Array.isArray(parsed)) {
    return persistenceError(
      "malformed",
      "Pending creator handoff storage was not a list.",
    );
  }
  if (parsed.length > MAX_PENDING_CREATOR_UPDATES) {
    return persistenceError(
      "over-cap",
      "Pending creator handoff storage exceeded its safety bound.",
    );
  }

  const intents = parsed.map((entry) => parseIntent(entry, now));
  const wallets = new Set<string>();
  for (const intent of intents) {
    const wallet = intent.wallet.toLowerCase();
    if (wallets.has(wallet)) {
      return persistenceError(
        "corrupt",
        "Multiple pending creator handoffs were saved for one wallet.",
      );
    }
    wallets.add(wallet);
  }
  return intents;
}

function writeAll(storage: Storage, intents: PendingCreatorUpdateIntent[]) {
  if (intents.length > MAX_PENDING_CREATOR_UPDATES) {
    return persistenceError(
      "over-cap",
      "Pending creator handoff storage exceeded its safety bound.",
    );
  }
  const serialized = JSON.stringify(intents);
  try {
    storage.setItem(PENDING_CREATOR_UPDATES_STORAGE_KEY, serialized);
    if (storage.getItem(PENDING_CREATOR_UPDATES_STORAGE_KEY) !== serialized) {
      return persistenceError(
        "unreadable",
        "Pending creator handoff storage did not retain the write.",
      );
    }
  } catch (cause) {
    return persistenceError(
      "unreadable",
      "Pending creator handoff storage could not be written.",
      cause,
    );
  }
}

function sameIntentIdentity(
  intent: PendingCreatorUpdateIntent,
  wallet: Address,
  poolId: Hex,
) {
  return (
    sameAddress(intent.wallet, wallet) &&
    intent.poolId.toLowerCase() === poolId.toLowerCase()
  );
}

function exactIntent(
  candidate: PendingCreatorUpdateIntent,
  expected: PendingCreatorUpdateIntent,
) {
  return (
    sameIntentIdentity(candidate, expected.wallet, expected.poolId) &&
    sameAddress(candidate.hook, expected.hook) &&
    sameAddress(candidate.oldCreator, expected.oldCreator) &&
    candidate.newCreator === expected.newCreator &&
    candidate.hash?.toLowerCase() === expected.hash?.toLowerCase() &&
    candidate.invokedAt === expected.invokedAt
  );
}

export function pendingCreatorUpdateRecoveryFromError(
  error: unknown,
): PendingCreatorUpdateRecoveryState {
  return {
    status: "recovery-required",
    reason:
      error instanceof PendingCreatorUpdatePersistenceError
        ? error.reason
        : "unreadable",
  };
}

export function readPendingCreatorUpdateStateForWallet(
  storage: Storage,
  wallet: Address,
  now = Date.now(),
): PendingCreatorUpdateState {
  try {
    const intent = readAll(storage, now).find((candidate) =>
      sameAddress(candidate.wallet, wallet),
    );
    return intent ? { status: "pending", intent } : { status: "clear" };
  } catch (error) {
    return pendingCreatorUpdateRecoveryFromError(error);
  }
}

export function savePendingCreatorUpdate(
  storage: Storage,
  intent: PendingCreatorUpdateIntent,
  now = Date.now(),
) {
  const validated = parseIntent(intent, now);
  const current = readAll(storage, now);
  if (current.some((candidate) => sameAddress(candidate.wallet, validated.wallet))) {
    return persistenceError(
      "corrupt",
      "This wallet already has an unresolved creator handoff.",
    );
  }
  current.push(validated);
  writeAll(storage, current);
}

export function savePendingCreatorUpdateHash(
  storage: Storage,
  wallet: Address,
  poolId: Hex,
  hash: Hex,
  invokedAt = Date.now(),
) {
  const now = Date.now();
  const current = readAll(storage, now);
  const intent = current.find((candidate) =>
    sameIntentIdentity(candidate, wallet, poolId),
  );
  if (!intent) {
    return persistenceError(
      "corrupt",
      "The creator handoff hash has no matching durable intent.",
    );
  }
  if (intent.invokedAt !== invokedAt) {
    return persistenceError(
      "corrupt",
      "The creator handoff hash does not match the saved invocation.",
    );
  }
  intent.hash = hash;
  parseIntent(intent, now);
  writeAll(storage, current);
}

export function removeExactUnsubmittedPendingCreatorUpdate(
  storage: Storage,
  expected: PendingCreatorUpdateIntent,
  now = Date.now(),
) {
  const validated = parseIntent(expected, now);
  if (validated.hash !== null) {
    return persistenceError(
      "corrupt",
      "A submitted creator handoff can only be cleared by canonical reconciliation.",
    );
  }
  const current = readAll(storage, now);
  const walletIndex = current.findIndex((candidate) =>
    sameAddress(candidate.wallet, validated.wallet),
  );
  if (walletIndex < 0 || !exactIntent(current[walletIndex]!, validated)) {
    return persistenceError(
      "corrupt",
      "The unsubmitted creator handoff does not match the saved exact intent.",
    );
  }
  current.splice(walletIndex, 1);
  writeAll(storage, current);
}

export function removeExactPendingCreatorUpdate(
  storage: Storage,
  expected: PendingCreatorUpdateIntent,
  now = Date.now(),
) {
  const validated = parseIntent(expected, now);
  if (validated.hash === null) {
    return persistenceError(
      "corrupt",
      "A canonically resolved creator handoff must include its exact transaction hash.",
    );
  }
  const current = readAll(storage, now);
  const walletIndex = current.findIndex((candidate) =>
    sameAddress(candidate.wallet, validated.wallet),
  );
  if (walletIndex < 0 || !exactIntent(current[walletIndex]!, validated)) {
    return persistenceError(
      "corrupt",
      "The canonically resolved creator handoff does not match the saved exact intent.",
    );
  }
  current.splice(walletIndex, 1);
  writeAll(storage, current);
}

export function resetPendingCreatorUpdateStore(storage: Storage) {
  try {
    storage.removeItem(PENDING_CREATOR_UPDATES_STORAGE_KEY);
    if (storage.getItem(PENDING_CREATOR_UPDATES_STORAGE_KEY) !== null) {
      return persistenceError(
        "unreadable",
        "Pending creator handoff storage could not be cleared.",
      );
    }
  } catch (cause) {
    return persistenceError(
      "unreadable",
      "Pending creator handoff storage could not be cleared.",
      cause,
    );
  }
}
