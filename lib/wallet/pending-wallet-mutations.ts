import type { Address } from "@/lib/web3/types";

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
  PENDING_CLAIMS_STORAGE_KEY,
  PENDING_LAUNCHES_STORAGE_KEY,
  PENDING_TRADES_STORAGE_KEY,
]);

export class PendingWalletMutationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PendingWalletMutationError";
  }
}

/**
 * Fail-closed cross-surface guard for the three independent recovery stores.
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

  if (claim.status === "recovery-required") {
    throw new PendingWalletMutationError(
      "A saved claim safety record cannot be trusted. All wallet mutations are blocked until it is reconciled.",
    );
  }
  if (launch || trade || claim.status === "pending") {
    throw new PendingWalletMutationError(
      "This wallet already has an unresolved LayPipe action. Reconcile it before opening another wallet prompt.",
    );
  }
}
