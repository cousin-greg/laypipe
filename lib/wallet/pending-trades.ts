import type { Address, Hex } from "@/lib/web3/types";
import {
  isAddress,
  isHexData,
  isTransactionHash,
} from "@/lib/web3/types";
import {
  TRADE_DEADLINE_BLOCK_BUDGET,
  TRADE_QUOTE_TTL_MS,
} from "@/lib/web3/trade-policy";

export const PENDING_TRADES_STORAGE_KEY = "laypipe.pending-trades.v1";
const MAX_PENDING_TRADES = 20;
const BASIS_POINTS = BigInt(10_000);
const ZERO_WORD = `0x${"00".repeat(32)}`;

interface PendingTradeBase {
  chainId: 4663;
  wallet: Address;
  tokenAddress: Address;
  poolId: Hex;
  target: Address;
  calldata: Hex;
  value: "0x0";
  hash: Hex | null;
  invokedAt: number;
}

export interface PendingTradeApprovalIntent extends PendingTradeBase {
  action: "approval";
  approval: {
    side: "buy" | "sell";
    token: Address;
    amount: string;
    kind: "reset" | "approve-exact";
  };
}

export interface PendingSwapIntent extends PendingTradeBase {
  action: "trade";
  trade: {
    side: "buy" | "sell";
    inputAmount: string;
    expectedOutput: string;
    minimumOutput: string;
    slippageBps: number;
    verifiedBlockNumber: string;
    deadlineBlock: string;
    createdAtMs: number;
    expiresAtMs: number;
  };
}

export type PendingTradeIntent =
  | PendingTradeApprovalIntent
  | PendingSwapIntent;

export class PendingTradeStorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PendingTradeStorageError";
  }
}

function bytes32(value: unknown): value is Hex {
  return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);
}

function decimalUint(value: unknown): value is string {
  return typeof value === "string" && /^(?:0|[1-9][0-9]{0,77})$/.test(value);
}

function timestamp(value: unknown, now: number) {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= now + 60_000
  );
}

function parseIntent(value: unknown, now: number): PendingTradeIntent | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Partial<PendingTradeIntent> & {
    approval?: unknown;
    trade?: unknown;
  };
  if (
    candidate.chainId !== 4663 ||
    typeof candidate.wallet !== "string" ||
    !isAddress(candidate.wallet) ||
    BigInt(candidate.wallet) === BigInt(0) ||
    typeof candidate.tokenAddress !== "string" ||
    !isAddress(candidate.tokenAddress) ||
    BigInt(candidate.tokenAddress) === BigInt(0) ||
    !bytes32(candidate.poolId) ||
    candidate.poolId.toLowerCase() === ZERO_WORD ||
    typeof candidate.target !== "string" ||
    !isAddress(candidate.target) ||
    BigInt(candidate.target) === BigInt(0) ||
    typeof candidate.calldata !== "string" ||
    !isHexData(candidate.calldata) ||
    candidate.calldata.length > 8_194 ||
    candidate.value !== "0x0" ||
    (candidate.hash !== null &&
      (typeof candidate.hash !== "string" ||
        !isTransactionHash(candidate.hash))) ||
    !timestamp(candidate.invokedAt, now)
  ) {
    return null;
  }
  const invokedAt = candidate.invokedAt as number;
  const base = {
    chainId: 4663 as const,
    wallet: candidate.wallet,
    tokenAddress: candidate.tokenAddress,
    poolId: candidate.poolId,
    target: candidate.target,
    calldata: candidate.calldata,
    value: "0x0" as const,
    hash: candidate.hash,
    invokedAt,
  };
  if (
    candidate.action === "approval" &&
    candidate.approval &&
    typeof candidate.approval === "object" &&
    !Array.isArray(candidate.approval)
  ) {
    const approval = candidate.approval as Partial<
      PendingTradeApprovalIntent["approval"]
    >;
    if (
      (approval.side === "buy" || approval.side === "sell") &&
      typeof approval.token === "string" &&
      isAddress(approval.token) &&
      approval.token.toLowerCase() === candidate.target.toLowerCase() &&
      decimalUint(approval.amount) &&
      (approval.kind === "reset" || approval.kind === "approve-exact") &&
      (approval.kind === "reset"
        ? BigInt(approval.amount) === BigInt(0)
        : BigInt(approval.amount) > BigInt(0)) &&
      /^0x095ea7b3[0-9a-fA-F]{128}$/.test(candidate.calldata)
    ) {
      return {
        ...base,
        action: "approval",
        approval: {
          side: approval.side,
          token: approval.token,
          amount: approval.amount,
          kind: approval.kind,
        },
      };
    }
  }
  if (
    candidate.action === "trade" &&
    candidate.trade &&
    typeof candidate.trade === "object" &&
    !Array.isArray(candidate.trade)
  ) {
    const trade = candidate.trade as Partial<PendingSwapIntent["trade"]>;
    if (
      (trade.side === "buy" || trade.side === "sell") &&
      decimalUint(trade.inputAmount) &&
      BigInt(trade.inputAmount) > BigInt(0) &&
      decimalUint(trade.expectedOutput) &&
      BigInt(trade.expectedOutput) > BigInt(0) &&
      decimalUint(trade.minimumOutput) &&
      BigInt(trade.minimumOutput) > BigInt(0) &&
      typeof trade.slippageBps === "number" &&
      Number.isInteger(trade.slippageBps) &&
      trade.slippageBps >= 50 &&
      trade.slippageBps <= 500 &&
      decimalUint(trade.verifiedBlockNumber) &&
      decimalUint(trade.deadlineBlock) &&
      timestamp(trade.createdAtMs, now) &&
      timestamp(trade.expiresAtMs, now) &&
      (trade.expiresAtMs as number) ===
        (trade.createdAtMs as number) + TRADE_QUOTE_TTL_MS &&
      BigInt(trade.deadlineBlock) ===
        BigInt(trade.verifiedBlockNumber) + TRADE_DEADLINE_BLOCK_BUDGET &&
      BigInt(trade.minimumOutput) ===
        (BigInt(trade.expectedOutput) *
          (BASIS_POINTS - BigInt(trade.slippageBps))) /
          BASIS_POINTS
    ) {
      return {
        ...base,
        action: "trade",
        trade: {
          side: trade.side,
          inputAmount: trade.inputAmount,
          expectedOutput: trade.expectedOutput,
          minimumOutput: trade.minimumOutput,
          slippageBps: trade.slippageBps,
          verifiedBlockNumber: trade.verifiedBlockNumber,
          deadlineBlock: trade.deadlineBlock,
          createdAtMs: trade.createdAtMs as number,
          expiresAtMs: trade.expiresAtMs as number,
        },
      };
    }
  }
  return null;
}

function readAll(storage: Storage, now = Date.now()) {
  let parsed: unknown;
  try {
    const raw = storage.getItem(PENDING_TRADES_STORAGE_KEY);
    if (!raw) return [];
    parsed = JSON.parse(raw);
  } catch {
    throw new PendingTradeStorageError(
      "Saved trade transaction state is unreadable. Trading is blocked until it is reconciled.",
    );
  }
  if (!Array.isArray(parsed) || parsed.length > MAX_PENDING_TRADES) {
    throw new PendingTradeStorageError(
      "Saved trade transaction state is malformed or over capacity. Trading is blocked until it is reconciled.",
    );
  }
  const intents = parsed.map((entry) => parseIntent(entry, now));
  if (intents.some((intent) => intent === null)) {
    throw new PendingTradeStorageError(
      "Saved trade transaction state failed validation. Trading is blocked until it is reconciled.",
    );
  }
  return intents as PendingTradeIntent[];
}

function writeAll(storage: Storage, intents: PendingTradeIntent[]) {
  storage.setItem(PENDING_TRADES_STORAGE_KEY, JSON.stringify(intents));
}

function samePool(
  intent: PendingTradeIntent,
  wallet: Address,
  tokenAddress: Address,
  poolId: Hex,
) {
  return (
    intent.wallet.toLowerCase() === wallet.toLowerCase() &&
    intent.tokenAddress.toLowerCase() === tokenAddress.toLowerCase() &&
    intent.poolId.toLowerCase() === poolId.toLowerCase()
  );
}

function exactIntent(left: PendingTradeIntent, right: PendingTradeIntent) {
  return (
    samePool(left, right.wallet, right.tokenAddress, right.poolId) &&
    left.action === right.action &&
    left.target.toLowerCase() === right.target.toLowerCase() &&
    left.calldata.toLowerCase() === right.calldata.toLowerCase() &&
    left.value === right.value &&
    left.hash?.toLowerCase() === right.hash?.toLowerCase() &&
    left.invokedAt === right.invokedAt &&
    JSON.stringify(left.action === "approval" ? left.approval : left.trade) ===
      JSON.stringify(right.action === "approval" ? right.approval : right.trade)
  );
}

export function readPendingTrade(
  storage: Storage,
  wallet: Address,
  tokenAddress: Address,
  poolId: Hex,
  now = Date.now(),
) {
  const pending = readPendingTradeForWallet(storage, wallet, now);
  return pending && samePool(pending, wallet, tokenAddress, poolId)
    ? pending
    : null;
}

export function readPendingTradeForWallet(
  storage: Storage,
  wallet: Address,
  now = Date.now(),
) {
  const matches = readAll(storage, now).filter(
    (intent) => intent.wallet.toLowerCase() === wallet.toLowerCase(),
  );
  if (matches.length > 1) {
    throw new PendingTradeStorageError(
      "More than one saved trade action exists for this wallet. Trading is blocked until they are reconciled.",
    );
  }
  return matches[0] ?? null;
}

export function savePendingTrade(
  storage: Storage,
  intent: PendingTradeIntent,
) {
  const parsed = parseIntent(intent, intent.invokedAt);
  if (!parsed) {
    throw new PendingTradeStorageError(
      "Pending trade intent could not be validated before wallet submission.",
    );
  }
  const current = readAll(storage, intent.invokedAt);
  if (current.length >= MAX_PENDING_TRADES) {
    throw new PendingTradeStorageError(
      "Saved trade transaction state is at capacity. Trading is blocked until pending actions are reconciled.",
    );
  }
  const existingForWallet = current.some(
    (candidate) =>
      candidate.wallet.toLowerCase() === intent.wallet.toLowerCase(),
  );
  if (existingForWallet) {
    throw new PendingTradeStorageError(
      "This wallet already has a pending trade action to reconcile.",
    );
  }
  writeAll(storage, [...current, parsed]);
}

export function savePendingTradeHash(
  storage: Storage,
  identity: PendingTradeIntent,
  hash: Hex,
) {
  if (!isTransactionHash(hash)) {
    throw new PendingTradeStorageError(
      "Wallet returned an invalid trade transaction hash.",
    );
  }
  const parsed = parseIntent(identity, Date.now());
  if (!parsed) {
    throw new PendingTradeStorageError(
      "Submitted trade hash has no valid pending intent.",
    );
  }
  const current = readAll(storage);
  const walletMatches = current.filter(
    (candidate) =>
      candidate.wallet.toLowerCase() === identity.wallet.toLowerCase(),
  );
  if (
    walletMatches.length !== 1 ||
    !samePool(
      walletMatches[0]!,
      identity.wallet,
      identity.tokenAddress,
      identity.poolId,
    )
  ) {
    throw new PendingTradeStorageError(
      "Submitted trade hash has no saved pending intent.",
    );
  }
  const index = current.indexOf(walletMatches[0]!);
  const saved = current[index];
  if (
    saved.action !== parsed.action ||
    saved.target.toLowerCase() !== parsed.target.toLowerCase() ||
    saved.calldata.toLowerCase() !== parsed.calldata.toLowerCase() ||
    saved.invokedAt !== parsed.invokedAt ||
    JSON.stringify(saved.action === "approval" ? saved.approval : saved.trade) !==
      JSON.stringify(parsed.action === "approval" ? parsed.approval : parsed.trade)
  ) {
    throw new PendingTradeStorageError(
      "Submitted trade hash does not match the saved exact intent.",
    );
  }
  current[index] = { ...saved, hash } as PendingTradeIntent;
  writeAll(storage, current);
}

export function removeExactPendingTrade(
  storage: Storage,
  expected: PendingTradeIntent,
) {
  const validated = parseIntent(expected, Date.now());
  if (!validated || validated.hash === null) {
    throw new PendingTradeStorageError(
      "A canonically resolved trade intent must include its exact transaction hash.",
    );
  }
  const current = readAll(storage);
  const index = current.findIndex(
    (candidate) =>
      candidate.wallet.toLowerCase() === validated.wallet.toLowerCase(),
  );
  if (index < 0 || !exactIntent(current[index]!, validated)) {
    throw new PendingTradeStorageError(
      "The canonically resolved trade intent does not match the saved exact record.",
    );
  }
  current.splice(index, 1);
  writeAll(storage, current);
}

export function removeExactUnsubmittedPendingTrade(
  storage: Storage,
  expected: PendingTradeIntent,
) {
  const validated = parseIntent(expected, Date.now());
  if (!validated || validated.hash !== null) {
    throw new PendingTradeStorageError(
      "Only an exact hashless trade intent can be cleared manually.",
    );
  }
  const current = readAll(storage);
  const index = current.findIndex(
    (candidate) => candidate.wallet.toLowerCase() === validated.wallet.toLowerCase(),
  );
  if (index < 0 || !exactIntent(current[index]!, validated)) {
    throw new PendingTradeStorageError(
      "The hashless trade intent no longer matches the saved exact record.",
    );
  }
  current.splice(index, 1);
  writeAll(storage, current);
}
