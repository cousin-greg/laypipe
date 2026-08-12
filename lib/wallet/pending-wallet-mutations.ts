import type { Address } from "@/lib/web3/types";

import {
  PENDING_CREATOR_UPDATES_STORAGE_KEY,
  readPendingCreatorUpdateStateForWallet,
} from "./pending-creator-updates";
import {
  PENDING_KEEPER_ACTIONS_STORAGE_KEY,
  readPendingKeeperActionForWallet,
} from "./pending-keeper-actions";
import {
  PENDING_CLAIMS_STORAGE_KEY,
  readPendingClaimStateForWallet,
} from "./pending-claims";
import {
  PENDING_LAUNCHES_STORAGE_KEY,
  readPendingLaunchForWallet,
} from "./pending-launches";
import {
  PENDING_TRADES_STORAGE_KEY,
  readPendingTradeForWallet,
} from "./pending-trades";

export const PENDING_WALLET_MUTATION_STORAGE_KEYS = new Set([
  PENDING_CREATOR_UPDATES_STORAGE_KEY,
  PENDING_KEEPER_ACTIONS_STORAGE_KEY,
  PENDING_CLAIMS_STORAGE_KEY,
  PENDING_LAUNCHES_STORAGE_KEY,
  PENDING_TRADES_STORAGE_KEY,
]);
export const PENDING_WALLET_MUTATION_CHANGE_EVENT =
  "laypipe:wallet-mutation-change";

/** Notify other mutation surfaces in this tab after a safety record clears. */
export function notifyPendingWalletMutationCleared() {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(PENDING_WALLET_MUTATION_CHANGE_EVENT));
  }
}

export class PendingWalletMutationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PendingWalletMutationError";
  }
}

/**
 * Fail-closed cross-surface guard for every independent recovery store.
 * Call this only while holding the shared wallet mutation Web Lock so the
 * subsequent intent write and wallet prompt are atomic across tabs.
 */
export function assertNoPendingWalletMutation(
  storage: Storage,
  wallet: Address,
  now = Date.now(),
) {
  const launch = readPendingLaunchForWallet(storage, wallet);
  const trade = readPendingTradeForWallet(storage, wallet, now);
  const claim = readPendingClaimStateForWallet(storage, wallet, now);
  const creatorUpdate = readPendingCreatorUpdateStateForWallet(
    storage,
    wallet,
    now,
  );
  const keeperAction = readPendingKeeperActionForWallet(storage, wallet, now);

  if (
    claim.status === "recovery-required" ||
    creatorUpdate.status === "recovery-required" ||
    keeperAction.status === "recovery-required"
  ) {
    throw new PendingWalletMutationError(
      "A saved wallet-mutation safety record cannot be trusted. All wallet mutations are blocked until it is reconciled.",
    );
  }
  if (
    launch ||
    trade ||
    claim.status === "pending" ||
    creatorUpdate.status === "pending" ||
    keeperAction.status === "pending"
  ) {
    throw new PendingWalletMutationError(
      "This wallet already has an unresolved LayPipe action. Reconcile it before opening another wallet prompt.",
    );
  }
}
