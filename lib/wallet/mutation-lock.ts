import type { Address } from "@/lib/web3/types";
import { isAddress } from "@/lib/web3/types";

const WALLET_LOCK_PREFIX = "laypipe:wallet-mutation:v1:4663";

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
