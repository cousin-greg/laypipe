import {
  keeperActionData,
  type KeeperAction,
} from "@/lib/web3/keeper-client";
import type { Address, Hex } from "@/lib/web3/types";
import {
  isAddress,
  isHexData,
  isTransactionHash,
} from "@/lib/web3/types";

export const PENDING_KEEPER_ACTIONS_STORAGE_KEY = "laypipe.pending-keeper-actions.v1";
const MAX_PENDING_KEEPER_ACTIONS = 20;
const MAX_PENDING_AGE_MS = 30 * 24 * 60 * 60 * 1_000;
const EXPECTED_INTENT_KEYS = [
  "action",
  "calldata",
  "chainId",
  "hash",
  "invokedAt",
  "poolId",
  "target",
  "wallet",
] as const;

export interface PendingKeeperActionIntent {
  chainId: 4663;
  wallet: Address;
  action: KeeperAction["kind"];
  poolId: Hex | null;
  target: Address;
  calldata: Hex;
  hash: Hex | null;
  invokedAt: number;
}

export type PendingKeeperRecoveryReason =
  | "unreadable"
  | "malformed"
  | "over-cap"
  | "expired"
  | "corrupt";

export type PendingKeeperActionState =
  | { status: "clear" }
  | { status: "pending"; intent: PendingKeeperActionIntent }
  | { status: "recovery-required"; reason: PendingKeeperRecoveryReason };

export class PendingKeeperPersistenceError extends Error {
  constructor(
    public readonly reason: PendingKeeperRecoveryReason,
    message: string,
    public readonly causeData?: unknown,
  ) {
    super(message);
    this.name = "PendingKeeperPersistenceError";
  }
}

function persistenceError(
  reason: PendingKeeperRecoveryReason,
  message: string,
  causeData?: unknown,
): never {
  throw new PendingKeeperPersistenceError(reason, message, causeData);
}

function isPoolId(value: unknown): value is Hex {
  return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);
}

export function keeperActionFromIntent(intent: PendingKeeperActionIntent): KeeperAction {
  if (intent.action === "sweep") {
    if (!intent.poolId) return persistenceError("corrupt", "A sweep intent omitted its pool ID.");
    return { kind: "sweep", poolId: intent.poolId };
  }
  if (intent.poolId !== null) {
    return persistenceError("corrupt", "A global keeper intent included an unexpected pool ID.");
  }
  if (
    intent.action !== "collect-platform" &&
    intent.action !== "sequester" &&
    intent.action !== "route-treasury"
  ) {
    return persistenceError("corrupt", "A keeper intent used an unsupported action.");
  }
  return { kind: intent.action };
}

function parseIntent(value: unknown, now: number): PendingKeeperActionIntent {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return persistenceError("corrupt", "A saved pending keeper action was not an object.");
  }
  const keys = Object.keys(value).sort();
  if (
    keys.length !== EXPECTED_INTENT_KEYS.length ||
    EXPECTED_INTENT_KEYS.some((key, index) => key !== keys[index])
  ) {
    return persistenceError("corrupt", "A saved pending keeper action had unexpected fields.");
  }
  const candidate = value as Partial<PendingKeeperActionIntent>;
  if (
    candidate.chainId !== 4663 ||
    typeof candidate.wallet !== "string" ||
    !isAddress(candidate.wallet) ||
    typeof candidate.target !== "string" ||
    !isAddress(candidate.target) ||
    BigInt(candidate.target) === BigInt(0) ||
    typeof candidate.calldata !== "string" ||
    !isHexData(candidate.calldata) ||
    (candidate.hash !== null &&
      (typeof candidate.hash !== "string" || !isTransactionHash(candidate.hash))) ||
    (candidate.poolId !== null && !isPoolId(candidate.poolId)) ||
    typeof candidate.invokedAt !== "number" ||
    !Number.isSafeInteger(candidate.invokedAt) ||
    candidate.invokedAt <= 0 ||
    candidate.invokedAt > now + 60_000
  ) {
    return persistenceError("corrupt", "A saved pending keeper action failed integrity checks.");
  }
  if (now - candidate.invokedAt > MAX_PENDING_AGE_MS) {
    return persistenceError("expired", "A saved pending keeper action exceeded the recovery window.");
  }
  const parsed = {
    chainId: 4663,
    wallet: candidate.wallet,
    action: candidate.action,
    poolId: candidate.poolId,
    target: candidate.target,
    calldata: candidate.calldata,
    hash: candidate.hash,
    invokedAt: candidate.invokedAt,
  } as PendingKeeperActionIntent;
  const action = keeperActionFromIntent(parsed);
  if (keeperActionData(action).toLowerCase() !== parsed.calldata.toLowerCase()) {
    return persistenceError("corrupt", "A saved keeper action calldata does not match its intent.");
  }
  return parsed;
}

function readAll(storage: Storage, now = Date.now()) {
  let raw: string | null;
  try {
    raw = storage.getItem(PENDING_KEEPER_ACTIONS_STORAGE_KEY);
  } catch (cause) {
    return persistenceError("unreadable", "Pending keeper storage could not be read.", cause);
  }
  if (raw === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    return persistenceError("malformed", "Pending keeper storage was not valid JSON.", cause);
  }
  if (!Array.isArray(parsed)) {
    return persistenceError("malformed", "Pending keeper storage was not a list.");
  }
  if (parsed.length > MAX_PENDING_KEEPER_ACTIONS) {
    return persistenceError("over-cap", "Pending keeper storage exceeded its safety bound.");
  }
  const intents = parsed.map((entry) => parseIntent(entry, now));
  const wallets = new Set<string>();
  for (const intent of intents) {
    const wallet = intent.wallet.toLowerCase();
    if (wallets.has(wallet)) {
      return persistenceError("corrupt", "Multiple pending keeper actions were saved for one wallet.");
    }
    wallets.add(wallet);
  }
  return intents;
}

function writeAll(storage: Storage, intents: PendingKeeperActionIntent[]) {
  if (intents.length > MAX_PENDING_KEEPER_ACTIONS) {
    return persistenceError("over-cap", "Pending keeper storage exceeded its safety bound.");
  }
  const serialized = JSON.stringify(intents);
  try {
    storage.setItem(PENDING_KEEPER_ACTIONS_STORAGE_KEY, serialized);
    if (storage.getItem(PENDING_KEEPER_ACTIONS_STORAGE_KEY) !== serialized) {
      return persistenceError("unreadable", "Pending keeper storage did not retain the write.");
    }
  } catch (cause) {
    return persistenceError("unreadable", "Pending keeper storage could not be written.", cause);
  }
}

function exactIntent(
  candidate: PendingKeeperActionIntent,
  expected: PendingKeeperActionIntent,
) {
  return (
    candidate.wallet.toLowerCase() === expected.wallet.toLowerCase() &&
    candidate.action === expected.action &&
    candidate.poolId?.toLowerCase() === expected.poolId?.toLowerCase() &&
    candidate.target.toLowerCase() === expected.target.toLowerCase() &&
    candidate.calldata.toLowerCase() === expected.calldata.toLowerCase() &&
    candidate.hash?.toLowerCase() === expected.hash?.toLowerCase() &&
    candidate.invokedAt === expected.invokedAt
  );
}

export function pendingKeeperRecoveryFromError(
  error: unknown,
): Extract<PendingKeeperActionState, { status: "recovery-required" }> {
  return {
    status: "recovery-required",
    reason:
      error instanceof PendingKeeperPersistenceError ? error.reason : "unreadable",
  };
}

export function readPendingKeeperActionForWallet(
  storage: Storage,
  wallet: Address,
  now = Date.now(),
): PendingKeeperActionState {
  try {
    const intent = readAll(storage, now).find(
      (candidate) => candidate.wallet.toLowerCase() === wallet.toLowerCase(),
    );
    return intent ? { status: "pending", intent } : { status: "clear" };
  } catch (error) {
    return pendingKeeperRecoveryFromError(error);
  }
}

export function savePendingKeeperAction(
  storage: Storage,
  intent: PendingKeeperActionIntent,
  now = Date.now(),
) {
  const validated = parseIntent(intent, now);
  const current = readAll(storage, now);
  if (current.some((entry) => entry.wallet.toLowerCase() === validated.wallet.toLowerCase())) {
    return persistenceError("corrupt", "This wallet already has an unresolved keeper action.");
  }
  current.push(validated);
  writeAll(storage, current);
}

export function savePendingKeeperActionHash(
  storage: Storage,
  expected: PendingKeeperActionIntent,
  hash: Hex,
) {
  const now = Date.now();
  const current = readAll(storage, now);
  const index = current.findIndex(
    (entry) => entry.wallet.toLowerCase() === expected.wallet.toLowerCase(),
  );
  if (index < 0 || !exactIntent(current[index]!, expected)) {
    return persistenceError("corrupt", "The submitted keeper hash does not match its saved intent.");
  }
  current[index] = parseIntent({ ...expected, hash }, now);
  writeAll(storage, current);
}

export function removeExactPendingKeeperAction(
  storage: Storage,
  expected: PendingKeeperActionIntent,
  now = Date.now(),
) {
  const validated = parseIntent(expected, now);
  if (validated.hash === null) {
    return persistenceError(
      "corrupt",
      "A canonically resolved keeper action must include its exact transaction hash.",
    );
  }
  const current = readAll(storage, now);
  const index = current.findIndex(
    (entry) => entry.wallet.toLowerCase() === validated.wallet.toLowerCase(),
  );
  if (index < 0 || !exactIntent(current[index]!, validated)) {
    return persistenceError(
      "corrupt",
      "The canonically resolved keeper action does not match the saved exact intent.",
    );
  }
  current.splice(index, 1);
  writeAll(storage, current);
}

export function removeExactUnsubmittedKeeperAction(
  storage: Storage,
  expected: PendingKeeperActionIntent,
  now = Date.now(),
) {
  const validated = parseIntent(expected, now);
  if (validated.hash !== null) {
    return persistenceError(
      "corrupt",
      "A submitted keeper action cannot be cleared as an unsubmitted request.",
    );
  }
  const current = readAll(storage, now);
  const index = current.findIndex(
    (entry) => entry.wallet.toLowerCase() === validated.wallet.toLowerCase(),
  );
  if (index < 0 || !exactIntent(current[index]!, validated)) {
    return persistenceError(
      "corrupt",
      "The rejected keeper request does not match the saved exact intent.",
    );
  }
  current.splice(index, 1);
  writeAll(storage, current);
}

export function removePendingKeeperActionForWallet(
  storage: Storage,
  wallet: Address,
) {
  writeAll(
    storage,
    readAll(storage).filter(
      (entry) => entry.wallet.toLowerCase() !== wallet.toLowerCase(),
    ),
  );
}

export function resetPendingKeeperActionStore(storage: Storage) {
  try {
    storage.removeItem(PENDING_KEEPER_ACTIONS_STORAGE_KEY);
    if (storage.getItem(PENDING_KEEPER_ACTIONS_STORAGE_KEY) !== null) {
      return persistenceError("unreadable", "Pending keeper storage could not be cleared.");
    }
  } catch (cause) {
    return persistenceError("unreadable", "Pending keeper storage could not be cleared.", cause);
  }
}

export function resetPendingKeeperActionForWallet(
  storage: Storage,
  wallet: Address,
) {
  let value: unknown;
  try {
    const raw = storage.getItem(PENDING_KEEPER_ACTIONS_STORAGE_KEY);
    if (raw === null) return;
    value = JSON.parse(raw);
  } catch (cause) {
    return persistenceError(
      "unreadable",
      "The keeper store cannot be safely reset for one wallet.",
      cause,
    );
  }
  if (!Array.isArray(value) || value.length > MAX_PENDING_KEEPER_ACTIONS) {
    return persistenceError("malformed", "The keeper store cannot be safely reset for one wallet.");
  }
  const retained = value.filter((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return persistenceError("corrupt", "The keeper store has an unowned record.");
    }
    const owner = (entry as { wallet?: unknown }).wallet;
    if (typeof owner !== "string" || !isAddress(owner)) {
      return persistenceError("corrupt", "The keeper store has an unowned record.");
    }
    return owner.toLowerCase() !== wallet.toLowerCase();
  }) as PendingKeeperActionIntent[];
  writeAll(storage, retained);
}
