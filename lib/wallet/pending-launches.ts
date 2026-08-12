import type { FactoryTokenParams } from "../web3/abi";
import type { LaunchCallInput } from "../web3/launch-client";
import type { Address, Hex } from "../web3/types";
import {
  isAddress,
  isHexData,
  isTransactionHash,
} from "../web3/types";

const STORAGE_KEY = "laypipe.pending-launches.v1";
const MAX_PENDING_LAUNCHES = 20;

interface SerializedLaunchCallInput {
  params: FactoryTokenParams;
  configId: string;
  firstBuyIn: string;
  firstBuyMinOut: string;
  salt: Hex;
}

interface PendingLaunchBase {
  chainId: 4663;
  wallet: Address;
  predictedToken: Address;
  target: Address;
  calldata: Hex;
  hash: Hex | null;
  invokedAt: number;
}

export interface PendingApprovalIntent extends PendingLaunchBase {
  action: "approval";
  amount: string;
}

export interface PendingTokenLaunchIntent extends PendingLaunchBase {
  action: "launch";
  input: SerializedLaunchCallInput;
}

export type PendingLaunchIntent =
  | PendingApprovalIntent
  | PendingTokenLaunchIntent;

export class PendingLaunchStorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PendingLaunchStorageError";
  }
}

function decimalUint(value: unknown): value is string {
  return typeof value === "string" && /^(?:0|[1-9][0-9]{0,77})$/.test(value);
}

function boundedText(
  value: unknown,
  maximum: number,
  options: { required?: boolean } = {},
): value is string {
  return (
    typeof value === "string" &&
    value.length <= maximum &&
    (!options.required || value.length > 0)
  );
}

function parseParams(value: unknown): FactoryTokenParams | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const params = value as Partial<FactoryTokenParams>;
  const socials = params.socials;
  if (
    !boundedText(params.name, 64, { required: true }) ||
    !boundedText(params.symbol, 32, { required: true }) ||
    !boundedText(params.logo, 2_048, { required: true }) ||
    !boundedText(params.description, 1_024) ||
    !boundedText(params.metadataURI, 2_048, { required: true }) ||
    typeof params.creator !== "string" ||
    !isAddress(params.creator) ||
    !socials ||
    !boundedText(socials.telegram, 2_048) ||
    !boundedText(socials.twitter, 2_048) ||
    !boundedText(socials.discord, 2_048) ||
    !boundedText(socials.website, 2_048) ||
    !boundedText(socials.extra, 2_048)
  ) {
    return null;
  }
  return {
    name: params.name,
    symbol: params.symbol,
    logo: params.logo,
    description: params.description,
    metadataURI: params.metadataURI,
    creator: params.creator,
    socials: {
      telegram: socials.telegram,
      twitter: socials.twitter,
      discord: socials.discord,
      website: socials.website,
      extra: socials.extra,
    },
  };
}

function parseInput(value: unknown): SerializedLaunchCallInput | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Partial<SerializedLaunchCallInput>;
  const params = parseParams(input.params);
  if (
    !params ||
    !decimalUint(input.configId) ||
    !decimalUint(input.firstBuyIn) ||
    !decimalUint(input.firstBuyMinOut) ||
    typeof input.salt !== "string" ||
    !isTransactionHash(input.salt)
  ) {
    return null;
  }
  return {
    params,
    configId: input.configId,
    firstBuyIn: input.firstBuyIn,
    firstBuyMinOut: input.firstBuyMinOut,
    salt: input.salt,
  };
}

function parseIntent(value: unknown, now: number): PendingLaunchIntent | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Partial<PendingLaunchIntent> & {
    action?: unknown;
    amount?: unknown;
    input?: unknown;
  };
  if (
    candidate.chainId !== 4663 ||
    typeof candidate.wallet !== "string" ||
    !isAddress(candidate.wallet) ||
    typeof candidate.predictedToken !== "string" ||
    !isAddress(candidate.predictedToken) ||
    typeof candidate.target !== "string" ||
    !isAddress(candidate.target) ||
    typeof candidate.calldata !== "string" ||
    !isHexData(candidate.calldata) ||
    (candidate.hash !== null &&
      (typeof candidate.hash !== "string" ||
        !isTransactionHash(candidate.hash))) ||
    typeof candidate.invokedAt !== "number" ||
    !Number.isSafeInteger(candidate.invokedAt) ||
    candidate.invokedAt <= 0 ||
    candidate.invokedAt > now + 60_000
  ) {
    return null;
  }

  const base = {
    chainId: 4663 as const,
    wallet: candidate.wallet,
    predictedToken: candidate.predictedToken,
    target: candidate.target,
    calldata: candidate.calldata,
    hash: candidate.hash,
    invokedAt: candidate.invokedAt,
  };
  if (candidate.action === "approval" && decimalUint(candidate.amount)) {
    return { ...base, action: "approval", amount: candidate.amount };
  }
  if (candidate.action === "launch") {
    const input = parseInput(candidate.input);
    if (input) return { ...base, action: "launch", input };
  }
  return null;
}

function readAll(storage: Storage, now = Date.now()) {
  let parsed: unknown;
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return [];
    parsed = JSON.parse(raw);
  } catch {
    throw new PendingLaunchStorageError(
      "Saved launch transaction state is unreadable. Wallet mutations are blocked until it is reconciled.",
    );
  }
  if (!Array.isArray(parsed) || parsed.length > MAX_PENDING_LAUNCHES) {
    throw new PendingLaunchStorageError(
      "Saved launch transaction state is malformed. Wallet mutations are blocked until it is reconciled.",
    );
  }
  const intents = parsed.map((value) => parseIntent(value, now));
  if (intents.some((intent) => intent === null)) {
    throw new PendingLaunchStorageError(
      "Saved launch transaction state failed validation. Wallet mutations are blocked until it is reconciled.",
    );
  }
  return intents as PendingLaunchIntent[];
}

function writeAll(storage: Storage, intents: PendingLaunchIntent[]) {
  storage.setItem(STORAGE_KEY, JSON.stringify(intents));
}

function sameIntent(
  left: PendingLaunchIntent,
  wallet: Address,
  action: PendingLaunchIntent["action"],
  predictedToken: Address,
) {
  return (
    left.wallet.toLowerCase() === wallet.toLowerCase() &&
    left.action === action &&
    left.predictedToken.toLowerCase() === predictedToken.toLowerCase()
  );
}

export function serializeLaunchInput(
  input: LaunchCallInput,
): SerializedLaunchCallInput {
  return {
    params: input.params,
    configId: input.configId.toString(),
    firstBuyIn: input.firstBuyIn.toString(),
    firstBuyMinOut: input.firstBuyMinOut.toString(),
    salt: input.salt,
  };
}

export function deserializeLaunchInput(
  input: SerializedLaunchCallInput,
): LaunchCallInput {
  return {
    params: input.params,
    configId: BigInt(input.configId),
    firstBuyIn: BigInt(input.firstBuyIn),
    firstBuyMinOut: BigInt(input.firstBuyMinOut),
    salt: input.salt,
  };
}

export function readPendingLaunchForWallet(
  storage: Storage,
  wallet: Address,
) {
  const matches = readAll(storage).filter(
    (intent) => intent.wallet.toLowerCase() === wallet.toLowerCase(),
  );
  if (matches.length > 1) {
    throw new PendingLaunchStorageError(
      "More than one pending launch action exists for this wallet. Reconcile them before another mutation.",
    );
  }
  return matches[0] ?? null;
}

export function savePendingLaunch(
  storage: Storage,
  intent: PendingLaunchIntent,
) {
  const parsed = parseIntent(intent, intent.invokedAt);
  if (!parsed) {
    throw new PendingLaunchStorageError(
      "Pending launch intent could not be validated before submission.",
    );
  }
  const current = readAll(storage, intent.invokedAt);
  const conflicting = current.some(
    (candidate) =>
      candidate.wallet.toLowerCase() === intent.wallet.toLowerCase() &&
      !sameIntent(
        candidate,
        intent.wallet,
        intent.action,
        intent.predictedToken,
      ),
  );
  if (conflicting) {
    throw new PendingLaunchStorageError(
      "This wallet already has a different pending launch action to reconcile.",
    );
  }
  writeAll(storage, [
    ...current.filter(
      (candidate) =>
        !sameIntent(
          candidate,
          intent.wallet,
          intent.action,
          intent.predictedToken,
        ),
    ),
    parsed,
  ]);
}

export function savePendingLaunchHash(
  storage: Storage,
  wallet: Address,
  action: PendingLaunchIntent["action"],
  predictedToken: Address,
  hash: Hex,
) {
  if (!isTransactionHash(hash)) {
    throw new PendingLaunchStorageError("Wallet returned an invalid transaction hash.");
  }
  const current = readAll(storage);
  const intent = current.find((candidate) =>
    sameIntent(candidate, wallet, action, predictedToken),
  );
  if (!intent) {
    throw new PendingLaunchStorageError(
      "The submitted transaction hash has no matching saved launch intent.",
    );
  }
  intent.hash = hash;
  writeAll(storage, current);
}

export function removePendingLaunch(
  storage: Storage,
  wallet: Address,
  action: PendingLaunchIntent["action"],
  predictedToken: Address,
) {
  writeAll(
    storage,
    readAll(storage).filter(
      (candidate) =>
        !sameIntent(candidate, wallet, action, predictedToken),
    ),
  );
}
