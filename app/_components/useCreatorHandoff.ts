import { useCallback, useEffect, useRef, useState } from "react";

import type { WalletTokenPosition } from "@/lib/wallet/live";
import { withCreatorHandoffMutationLocks } from "@/lib/wallet/mutation-lock";
import {
  pendingCreatorUpdateRecoveryFromError,
  readPendingCreatorUpdateStateForWallet,
  removeExactPendingCreatorUpdate,
  removeExactUnsubmittedPendingCreatorUpdate,
  resetPendingCreatorUpdateStore,
  savePendingCreatorUpdate,
  savePendingCreatorUpdateHash,
  type PendingCreatorUpdateIntent,
  type PendingCreatorUpdateRecoveryReason,
} from "@/lib/wallet/pending-creator-updates";
import {
  assertNoPendingWalletMutation,
  notifyPendingWalletMutationCleared,
  PENDING_WALLET_MUTATION_CHANGE_EVENT,
  PENDING_WALLET_MUTATION_STORAGE_KEYS,
} from "@/lib/wallet/pending-wallet-mutations";
import { readBrowserPublicLaunchDeployment } from "@/lib/web3/browser-deployment";
import {
  CreatorHandoffClient,
  isCanonicalCreatorHandoffReverted,
  isCreatorHandoffSubmissionIndeterminate,
  parseChecksummedCreatorAddress,
} from "@/lib/web3/creator-handoff-client";
import { describeWalletError } from "@/lib/web3/launch-client";
import type { Address, Eip1193Provider, Hex } from "@/lib/web3/types";
import { sameAddress } from "@/lib/web3/types";

export interface CreatorHandoffDraft {
  poolId: Hex;
  destination: string;
  acknowledged: boolean;
}

interface UseCreatorHandoffOptions {
  account: Address | null;
  provider: Eip1193Provider | null;
  revision: number;
  reload: () => Promise<void>;
}

export function creatorHandoffRecoveryMessage(
  reason: PendingCreatorUpdateRecoveryReason,
) {
  switch (reason) {
    case "unreadable":
      return "Browser storage could not be read or written.";
    case "malformed":
      return "The saved creator-handoff safety record is malformed.";
    case "over-cap":
      return "The saved creator-handoff safety record exceeded its strict size limit.";
    case "expired":
      return "An expired creator-handoff record still represents ambiguous wallet activity.";
    case "corrupt":
      return "The saved creator-handoff record failed its integrity checks.";
  }
}

export function useCreatorHandoff({
  account,
  provider,
  revision,
  reload,
}: UseCreatorHandoffOptions) {
  const [draft, setDraft] = useState<CreatorHandoffDraft | null>(null);
  const [submittingPoolId, setSubmittingPoolId] = useState<Hex | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState<{
    hash: Hex;
    newCreator: Address;
  } | null>(null);
  const [pending, setPending] =
    useState<PendingCreatorUpdateIntent | null>(null);
  const [recovery, setRecovery] =
    useState<PendingCreatorUpdateRecoveryReason | null>(null);
  const [crossSurfacePending, setCrossSurfacePending] =
    useState<string | null>(null);
  const [liveOperation, setLiveOperation] = useState(false);
  const [recoveryBusy, setRecoveryBusy] = useState(false);
  const [stateBinding, setStateBinding] = useState<{
    wallet: string;
    revision: number;
  } | null>(null);
  const operationRef = useRef(0);
  const storageReady =
    account !== null &&
    stateBinding?.wallet === account.toLowerCase() &&
    stateBinding.revision === revision;

  const restore = useCallback(
    (wallet: Address) => {
      const restored = readPendingCreatorUpdateStateForWallet(
        window.localStorage,
        wallet,
      );
      if (restored.status === "pending") {
        setPending(restored.intent);
        setRecovery(null);
        setCrossSurfacePending(null);
        setSubmittingPoolId(restored.intent.poolId);
        return;
      }
      setPending(null);
      setSubmittingPoolId(null);
      if (restored.status === "recovery-required") {
        setRecovery(restored.reason);
        setCrossSurfacePending(null);
        return;
      }
      setRecovery(null);
      try {
        assertNoPendingWalletMutation(window.localStorage, wallet);
        setCrossSurfacePending(null);
      } catch (cause) {
        setCrossSurfacePending(describeWalletError(cause));
      }
    },
    [],
  );

  useEffect(() => {
    operationRef.current += 1;
    const frame = window.requestAnimationFrame(() => {
      setDraft(null);
      setError(null);
      setConfirmed(null);
      setPending(null);
      setRecovery(null);
      setCrossSurfacePending(null);
      setSubmittingPoolId(null);
      setLiveOperation(false);
      setRecoveryBusy(false);
      if (account) restore(account);
      setStateBinding(
        account ? { wallet: account.toLowerCase(), revision } : null,
      );
    });
    return () => {
      operationRef.current += 1;
      window.cancelAnimationFrame(frame);
    };
  }, [account, restore, revision]);

  useEffect(() => {
    if (!account) return;
    const handleStorage = (event: StorageEvent) => {
      if (
        event.storageArea !== window.localStorage ||
        (event.key !== null &&
          !PENDING_WALLET_MUTATION_STORAGE_KEYS.has(event.key))
      ) {
        return;
      }
      operationRef.current += 1;
      setError(null);
      restore(account);
    };
    const handleSameTabClear = () => {
      operationRef.current += 1;
      setError(null);
      restore(account);
    };
    window.addEventListener("storage", handleStorage);
    window.addEventListener(
      PENDING_WALLET_MUTATION_CHANGE_EVENT,
      handleSameTabClear,
    );
    return () => {
      window.removeEventListener("storage", handleStorage);
      window.removeEventListener(
        PENDING_WALLET_MUTATION_CHANGE_EVENT,
        handleSameTabClear,
      );
    };
  }, [account, restore]);

  const open = useCallback((position: WalletTokenPosition) => {
    setDraft({
      poolId: position.poolId,
      destination: "",
      acknowledged: false,
    });
    setError(null);
    setConfirmed(null);
  }, []);

  const close = useCallback(() => {
    setDraft(null);
    setError(null);
  }, []);

  const setDestination = useCallback((destination: string) => {
    setDraft((current) =>
      current ? { ...current, destination, acknowledged: false } : current,
    );
    setError(null);
  }, []);

  const setAcknowledged = useCallback((acknowledged: boolean) => {
    setDraft((current) =>
      current ? { ...current, acknowledged } : current,
    );
  }, []);

  const unlockCanonicallyReverted = useCallback(async (
    intent: PendingCreatorUpdateIntent,
  ) => {
    try {
      await withCreatorHandoffMutationLocks(
        navigator.locks,
        intent.wallet,
        () => removeExactPendingCreatorUpdate(window.localStorage, intent),
      );
      notifyPendingWalletMutationCleared();
      setPending(null);
      setRecovery(null);
      setSubmittingPoolId(null);
      setConfirmed(null);
      setError(
        "The creator handoff was canonically confirmed as reverted. Creator rights did not move; refresh the indexed position before retrying.",
      );
      return true;
    } catch (cause) {
      setRecovery(pendingCreatorUpdateRecoveryFromError(cause).reason);
      setError(
        "The creator handoff reverted, but its exact local safety record could not be cleared. Wallet mutations remain locked.",
      );
      return false;
    }
  }, []);

  const submit = useCallback(
    async (position: WalletTokenPosition) => {
      if (
        !account ||
        !provider ||
        !storageReady ||
        !draft ||
        draft.poolId.toLowerCase() !== position.poolId.toLowerCase() ||
        !draft.acknowledged ||
        pending ||
        recovery ||
        crossSurfacePending ||
        submittingPoolId
      ) {
        return;
      }
      if (
        position.feeMode !== "creator" ||
        !position.isCurrentCreator ||
        !sameAddress(position.currentCreator, account)
      ) {
        setError(
          "Only the freshly indexed current creator can hand off this creator-fee pool.",
        );
        return;
      }
      let newCreator: Address;
      try {
        newCreator = parseChecksummedCreatorAddress(
          draft.destination,
          position.currentCreator,
        );
      } catch (cause) {
        setError(describeWalletError(cause));
        return;
      }
      const deployment = readBrowserPublicLaunchDeployment();
      if (!deployment.configured) {
        setError("The complete configured release manifest is not configured.");
        return;
      }
      const operation = ++operationRef.current;
      const operationAccount = account;
      const operationRevision = revision;
      setSubmittingPoolId(position.poolId);
      setLiveOperation(true);
      setError(null);
      setConfirmed(null);
      let submittedHash: Hex | null = null;
      let submissionInvoked = false;
      let keepLocked = false;
      const persisted = {
        intent: null as PendingCreatorUpdateIntent | null,
      };
      try {
        const client = new CreatorHandoffClient(
          provider,
          deployment.deployment,
        );
        const submitted = await withCreatorHandoffMutationLocks(
          navigator.locks,
          operationAccount,
          async () => {
            assertNoPendingWalletMutation(
              window.localStorage,
              operationAccount,
            );
            return client.updateCreator(
              operationAccount,
              position.poolId,
              position.currentCreator,
              newCreator,
              {
                onSubmissionInvoked: () => {
                  const intent: PendingCreatorUpdateIntent = {
                    chainId: 4663,
                    wallet: operationAccount,
                    hook: deployment.deployment.contracts.hook.address,
                    poolId: position.poolId,
                    oldCreator: position.currentCreator,
                    newCreator,
                    hash: null,
                    invokedAt: Date.now(),
                  };
                  try {
                    savePendingCreatorUpdate(window.localStorage, intent);
                  } catch (cause) {
                    setRecovery(
                      pendingCreatorUpdateRecoveryFromError(cause).reason,
                    );
                    throw cause;
                  }
                  submissionInvoked = true;
                  persisted.intent = intent;
                  setPending(intent);
                },
                onSubmitted: (hash) => {
                  submittedHash = hash;
                  if (!persisted.intent) {
                    throw new Error(
                      "The pending creator handoff was not saved before submission.",
                    );
                  }
                  try {
                    savePendingCreatorUpdateHash(
                      window.localStorage,
                      operationAccount,
                      position.poolId,
                      hash,
                      persisted.intent.invokedAt,
                    );
                  } catch (cause) {
                    setRecovery(
                      pendingCreatorUpdateRecoveryFromError(cause).reason,
                    );
                    throw cause;
                  }
                  persisted.intent = { ...persisted.intent, hash };
                  setPending(persisted.intent);
                },
              },
            );
          },
        );
        if (
          operation !== operationRef.current ||
          operationRevision !== revision
        ) {
          return;
        }
        submittedHash = submitted.hash;
        await client.confirmCreatorHandoff(submitted.hash, {
          account: operationAccount,
          poolId: position.poolId,
          oldCreator: position.currentCreator,
          newCreator,
        });
        if (
          operation !== operationRef.current ||
          operationRevision !== revision
        ) {
          return;
        }
        if (!persisted.intent?.hash) {
          throw new Error(
            "The confirmed creator handoff does not have an exact saved intent.",
          );
        }
        await withCreatorHandoffMutationLocks(
          navigator.locks,
          operationAccount,
          () =>
            removeExactPendingCreatorUpdate(
              window.localStorage,
              persisted.intent!,
            ),
        );
        notifyPendingWalletMutationCleared();
        setConfirmed({ hash: submitted.hash, newCreator });
        setPending(null);
        setRecovery(null);
        setSubmittingPoolId(null);
        setDraft(null);
        await reload();
      } catch (cause) {
        if (operation !== operationRef.current) return;
        setError(describeWalletError(cause));
        const revertedIntent = persisted.intent;
        if (
          isCanonicalCreatorHandoffReverted(cause) &&
          revertedIntent?.hash &&
          submittedHash &&
          revertedIntent.hash.toLowerCase() === submittedHash.toLowerCase()
        ) {
          keepLocked = !(await unlockCanonicallyReverted(revertedIntent));
          return;
        }
        keepLocked =
          isCreatorHandoffSubmissionIndeterminate(cause) ||
          submittedHash !== null;
        if (!keepLocked && submittedHash === null && submissionInvoked) {
          try {
            if (!persisted.intent) {
              throw new Error(
                "The rejected creator handoff has no exact saved intent.",
              );
            }
            await withCreatorHandoffMutationLocks(
              navigator.locks,
              operationAccount,
              () =>
                removeExactUnsubmittedPendingCreatorUpdate(
                  window.localStorage,
                  persisted.intent!,
                ),
            );
            notifyPendingWalletMutationCleared();
          } catch (storageCause) {
            keepLocked = true;
            setRecovery(
              pendingCreatorUpdateRecoveryFromError(storageCause).reason,
            );
            setError(
              "The wallet request was not submitted, but its local safety record could not be cleared. Wallet mutations remain locked.",
            );
          }
          if (!keepLocked) setPending(null);
        }
      } finally {
        if (operation === operationRef.current) {
          setLiveOperation(false);
          if (!keepLocked) setSubmittingPoolId(null);
        }
      }
    },
    [
      account,
      crossSurfacePending,
      draft,
      pending,
      provider,
      recovery,
      reload,
      revision,
      storageReady,
      submittingPoolId,
      unlockCanonicallyReverted,
    ],
  );

  const reconcile = useCallback(async () => {
    if (!account || !provider || !pending?.hash) return;
    const deployment = readBrowserPublicLaunchDeployment();
    if (!deployment.configured) {
      setError("The complete configured release manifest is not configured.");
      return;
    }
    if (!sameAddress(pending.hook, deployment.deployment.contracts.hook.address)) {
      setError(
        "The saved creator handoff targets a different hook than the configured release. It remains locked.",
      );
      return;
    }
    const operation = ++operationRef.current;
    setSubmittingPoolId(pending.poolId);
    setLiveOperation(true);
    setError(null);
    try {
      const client = new CreatorHandoffClient(
        provider,
        deployment.deployment,
      );
      await client.confirmCreatorHandoff(pending.hash, {
        account: pending.wallet,
        poolId: pending.poolId,
        oldCreator: pending.oldCreator,
        newCreator: pending.newCreator,
      });
      if (operation !== operationRef.current) return;
      await withCreatorHandoffMutationLocks(
        navigator.locks,
        pending.wallet,
        () => removeExactPendingCreatorUpdate(window.localStorage, pending),
      );
      notifyPendingWalletMutationCleared();
      setConfirmed({ hash: pending.hash, newCreator: pending.newCreator });
      setPending(null);
      setRecovery(null);
      setSubmittingPoolId(null);
      setDraft(null);
      await reload();
    } catch (cause) {
      if (operation !== operationRef.current) return;
      if (isCanonicalCreatorHandoffReverted(cause)) {
        await unlockCanonicallyReverted(pending);
        return;
      }
      setError(describeWalletError(cause));
    } finally {
      if (operation === operationRef.current) setLiveOperation(false);
    }
  }, [account, pending, provider, reload, unlockCanonicallyReverted]);

  const clearCheckedLock = useCallback(async () => {
    if (
      !account ||
      !pending ||
      pending.hash !== null ||
      liveOperation ||
      recoveryBusy
    ) return;
    const operation = ++operationRef.current;
    const exactPending = pending;
    setRecoveryBusy(true);
    try {
      await withCreatorHandoffMutationLocks(
        navigator.locks,
        account,
        () =>
          removeExactUnsubmittedPendingCreatorUpdate(
            window.localStorage,
            exactPending,
          ),
      );
      if (operation !== operationRef.current) return;
      notifyPendingWalletMutationCleared();
      setPending(null);
      setRecovery(null);
      setSubmittingPoolId(null);
      setError(null);
    } catch (cause) {
      setRecovery(pendingCreatorUpdateRecoveryFromError(cause).reason);
      setError(
        "The local creator-handoff safety record could not be cleared. Wallet mutations remain locked.",
      );
    } finally {
      if (operation === operationRef.current) setRecoveryBusy(false);
    }
  }, [account, liveOperation, pending, recoveryBusy]);

  const resetSafetyLock = useCallback(async () => {
    if (!account || !recovery || liveOperation || recoveryBusy) return;
    const operation = ++operationRef.current;
    setRecoveryBusy(true);
    try {
      await withCreatorHandoffMutationLocks(
        navigator.locks,
        account,
        () => resetPendingCreatorUpdateStore(window.localStorage),
      );
      if (operation !== operationRef.current) return;
      notifyPendingWalletMutationCleared();
      setPending(null);
      setRecovery(null);
      setSubmittingPoolId(null);
      setError(null);
    } catch (cause) {
      setRecovery(pendingCreatorUpdateRecoveryFromError(cause).reason);
      setError(
        "Browser storage is still unavailable. The creator-handoff safety lock remains active.",
      );
    } finally {
      if (operation === operationRef.current) setRecoveryBusy(false);
    }
  }, [account, liveOperation, recovery, recoveryBusy]);

  return {
    draft,
    open,
    close,
    setDestination,
    setAcknowledged,
    submit,
    submittingPoolId,
    error,
    pending,
    recovery,
    crossSurfacePending,
    storageReady,
    confirmed,
    liveOperation,
    recoveryBusy,
    reconcile,
    clearCheckedLock,
    resetSafetyLock,
    blocked:
      !storageReady ||
      liveOperation ||
      recoveryBusy ||
      submittingPoolId !== null ||
      pending !== null ||
      recovery !== null ||
      crossSurfacePending !== null,
  };
}
