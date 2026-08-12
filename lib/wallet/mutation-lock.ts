import type { Address } from "@/lib/web3/types";
import { isAddress } from "@/lib/web3/types";

const WALLET_LOCK_PREFIX = "laypipe:wallet-mutation:v1:4663";
const WALLET_RECOVERY_STORE_LOCK =
  "laypipe:wallet-recovery-store:v1:4663";
const CREATOR_HANDOFF_STORE_LOCK =
  "laypipe:creator-handoff-store:v1:4663";

export class WalletMutationLockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WalletMutationLockError";
  }
}

export function walletMutationLockName(wallet: Address) {
  if (!isAddress(wallet) || BigInt(wallet) === BigInt(0)) {
    throw new WalletMutationLockError(
      "Cross-tab mutation locking requires a valid nonzero wallet address.",
    );
  }
  return `${WALLET_LOCK_PREFIX}:${wallet.toLowerCase()}`;
}

/**
 * Serializes wallet prompts across same-origin tabs. The non-waiting request
 * deliberately fails closed: a second tab must never queue a stale mutation
 * that opens after the first tab releases.
 */
export async function withWalletMutationLock<T>(
  locks: Pick<LockManager, "request"> | null | undefined,
  wallet: Address,
  operation: () => Promise<T> | T,
): Promise<T> {
  if (!locks || typeof locks.request !== "function") {
    throw new WalletMutationLockError(
      "This browser cannot provide the required cross-tab wallet lock. Wallet mutations are blocked.",
    );
  }

  const name = walletMutationLockName(wallet);
  let callbackInvoked = false;
  try {
    return await locks.request(
      name,
      { mode: "exclusive", ifAvailable: true },
      async (lock) => {
        callbackInvoked = true;
        if (!lock) {
          throw new WalletMutationLockError(
            "Another tab is already submitting a transaction for this wallet. Wallet mutations are blocked until it finishes.",
          );
        }
        return operation();
      },
    );
  } catch (error) {
    if (callbackInvoked) throw error;
    throw new WalletMutationLockError(
      "The browser cross-tab wallet lock could not be acquired. Wallet mutations are blocked.",
    );
  }
}

/**
 * Serializes the short read/modify/write sections used by every bounded wallet
 * recovery array. Unlike wallet prompts this lock is queued: callers already
 * hold the relevant non-waiting wallet lock, and queuing only the synchronous
 * storage mutation prevents different wallets from losing each other's rows.
 */
export async function withWalletRecoveryStoreLock<T>(
  locks: Pick<LockManager, "request"> | null | undefined,
  operation: () => Promise<T> | T,
): Promise<T> {
  if (!locks || typeof locks.request !== "function") {
    throw new WalletMutationLockError(
      "This browser cannot provide the required wallet recovery storage lock. Wallet mutations are blocked.",
    );
  }

  let callbackInvoked = false;
  try {
    return await locks.request(
      WALLET_RECOVERY_STORE_LOCK,
      { mode: "exclusive" },
      async (lock) => {
        callbackInvoked = true;
        if (!lock) {
          throw new WalletMutationLockError(
            "The wallet recovery storage lock could not be acquired.",
          );
        }
        return operation();
      },
    );
  } catch (error) {
    if (callbackInvoked) throw error;
    throw new WalletMutationLockError(
      "The wallet recovery storage lock could not be acquired. Wallet mutations are blocked.",
    );
  }
}

/**
 * Manual recovery always takes the non-waiting per-wallet mutation lock first,
 * then the queued global recovery-store lock. Submission paths use the same
 * order and hold the wallet lock across the entire wallet request.
 */
export function withWalletRecoveryLocks<T>(
  locks: Pick<LockManager, "request"> | null | undefined,
  wallet: Address,
  operation: () => Promise<T> | T,
) {
  return withWalletMutationLock(locks, wallet, () =>
    withWalletRecoveryStoreLock(locks, operation),
  );
}

/**
 * Serializes the shared creator-handoff recovery store across every wallet.
 * The store currently uses one bounded record set, so a per-wallet lock alone
 * cannot make its read/modify/write cycle atomic for two different wallets.
 */
export async function withCreatorHandoffStoreLock<T>(
  locks: Pick<LockManager, "request"> | null | undefined,
  operation: () => Promise<T> | T,
): Promise<T> {
  if (!locks || typeof locks.request !== "function") {
    throw new WalletMutationLockError(
      "This browser cannot provide the required creator-handoff storage lock. Wallet mutations are blocked.",
    );
  }

  let callbackInvoked = false;
  try {
    return await locks.request(
      CREATOR_HANDOFF_STORE_LOCK,
      { mode: "exclusive", ifAvailable: true },
      async (lock) => {
        callbackInvoked = true;
        if (!lock) {
          throw new WalletMutationLockError(
            "Another creator handoff or recovery action is active. Wallet mutations are blocked until it finishes.",
          );
        }
        return operation();
      },
    );
  } catch (error) {
    if (callbackInvoked) throw error;
    throw new WalletMutationLockError(
      "The creator-handoff storage lock could not be acquired. Wallet mutations are blocked.",
    );
  }
}

/**
 * Always takes the global creator store lock before the per-wallet mutation
 * lock. Keeping one lock order avoids deadlocks between submission and manual
 * recovery, while the non-waiting policy prevents a stale action from queuing.
 */
export function withCreatorHandoffMutationLocks<T>(
  locks: Pick<LockManager, "request"> | null | undefined,
  wallet: Address,
  operation: () => Promise<T> | T,
) {
  return withCreatorHandoffStoreLock(locks, () =>
    withWalletMutationLock(locks, wallet, operation),
  );
}
