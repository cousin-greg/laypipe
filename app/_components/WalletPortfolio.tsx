"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  parseWalletPortfolioResponse,
  type WalletPortfolioResponse,
  type WalletTokenPosition,
} from "@/lib/wallet/live";
import {
  pendingClaimRecoveryFromError,
  readPendingClaimStateForWallet,
  removeExactPendingClaim,
  removeExactUnsubmittedPendingClaim,
  resetPendingClaimForWallet,
  savePendingClaim,
  savePendingClaimHash,
  type PendingClaimIntent,
  type PendingClaimRecoveryReason,
  type PendingClaimState,
} from "@/lib/wallet/pending-claims";
import {
  withWalletMutationLock,
  withWalletRecoveryLocks,
  withWalletRecoveryStoreLock,
} from "@/lib/wallet/mutation-lock";
import {
  assertNoPendingWalletMutation,
  notifyPendingWalletMutationCleared,
  PENDING_WALLET_MUTATION_CHANGE_EVENT,
  PENDING_WALLET_MUTATION_STORAGE_KEYS,
} from "@/lib/wallet/pending-wallet-mutations";
import { readBrowserPublicLaunchDeployment } from "@/lib/web3/browser-deployment";
import {
  CreatorClaimClient,
  isCanonicalClaimReverted,
  isClaimSubmissionIndeterminate,
} from "@/lib/web3/creator-claim-client";
import { describeWalletError } from "@/lib/web3/launch-client";
import { explorerTokenUrl, explorerTransactionUrl } from "@/lib/web3/robinhood";
import { formatUnits } from "@/lib/web3/units";

import { useMarketData } from "./MarketDataProvider";
import {
  creatorHandoffRecoveryMessage,
  useCreatorHandoff,
} from "./useCreatorHandoff";
import { useWallet } from "./WalletProvider";

type View = "tokens" | "rewards";

function amount(value: string, maximumFractionDigits = 4) {
  return formatUnits(BigInt(value), 18, maximumFractionDigits);
}

function claimRecoveryMessage(reason: PendingClaimRecoveryReason) {
  switch (reason) {
    case "unreadable":
      return "Browser storage could not be read or written.";
    case "malformed":
      return "The saved claim safety record is malformed.";
    case "over-cap":
      return "The saved claim safety record exceeded its strict size limit.";
    case "expired":
      return "An expired claim safety record still represents ambiguous wallet activity.";
    case "corrupt":
      return "The saved claim safety record failed its integrity checks.";
  }
}

export function WalletPortfolio({ view }: { view: View }) {
  const { marketMode } = useMarketData();
  const { account, provider, status, error: walletError, revision, connect } = useWallet();
  const [payload, setPayload] = useState<WalletPortfolioResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [claiming, setClaiming] = useState<string | null>(null);
  const [claimError, setClaimError] = useState<string | null>(null);
  const [confirmedHash, setConfirmedHash] = useState<string | null>(null);
  const [pendingClaim, setPendingClaim] = useState<PendingClaimIntent | null>(null);
  const [claimRecovery, setClaimRecovery] = useState<PendingClaimRecoveryReason | null>(null);
  const [crossSurfacePending, setCrossSurfacePending] = useState<string | null>(null);
  const [claimStateBinding, setClaimStateBinding] = useState<{
    wallet: string;
    revision: number;
  } | null>(null);
  const requestRef = useRef(0);
  const requestControllerRef = useRef<AbortController | null>(null);
  const claimRef = useRef(0);
  const claimStorageReady =
    account !== null &&
    claimStateBinding?.wallet === account.toLowerCase() &&
    claimStateBinding.revision === revision;

  const load = useCallback(
    async (cursor?: string | null) => {
      if (marketMode !== "live" || !account) return;
      const requestId = ++requestRef.current;
      const requestedWallet = account;
      requestControllerRef.current?.abort();
      const controller = new AbortController();
      requestControllerRef.current = controller;
      setLoading(true);
      setError(null);
      try {
        const response = await fetch("/api/holdings", {
          method: "POST",
          credentials: "omit",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ wallet: requestedWallet, limit: 12, cursor }),
          cache: "no-store",
          signal: controller.signal,
        });
        const raw: unknown = await response.json();
        if (!response.ok) {
          const body = raw && typeof raw === "object" ? raw as { error?: { message?: unknown } } : {};
          const message = body.error?.message;
          throw new Error(typeof message === "string" ? message : "Wallet data is unavailable.");
        }
        const body = parseWalletPortfolioResponse(raw, requestedWallet);
        if (requestId !== requestRef.current) return;
        setPayload((current) =>
          cursor && current
            ? { ...body, positions: [...current.positions, ...body.positions] }
            : body,
        );
        setNextCursor(body.page.nextCursor);
      } catch (cause) {
        if (requestId !== requestRef.current || controller.signal.aborted) return;
        setError(cause instanceof Error ? cause.message : "Wallet data is unavailable.");
      } finally {
        if (requestId === requestRef.current) {
          setLoading(false);
          if (requestControllerRef.current === controller) {
            requestControllerRef.current = null;
          }
        }
      }
    },
    [account, marketMode],
  );
  const reload = useCallback(() => load(null), [load]);
  const creatorHandoff = useCreatorHandoff({
    account,
    provider,
    revision,
    reload,
  });

  function withClaimRecoveryStore<T>(operation: () => Promise<T> | T) {
    return withWalletRecoveryStoreLock(navigator.locks, operation);
  }

  useEffect(() => {
    requestRef.current += 1;
    requestControllerRef.current?.abort();
    requestControllerRef.current = null;
    claimRef.current += 1;
    const frame = window.requestAnimationFrame(() => {
      setPayload(null);
      setNextCursor(null);
      setClaimError(null);
      setConfirmedHash(null);
      setCrossSurfacePending(null);
      let restored: PendingClaimState = { status: "clear" };
      if (account) {
        try {
          restored = readPendingClaimStateForWallet(window.localStorage, account);
          if (restored.status === "clear") {
            assertNoPendingWalletMutation(window.localStorage, account);
          }
        } catch (cause) {
          const claimState = readPendingClaimStateForWallet(window.localStorage, account);
          if (claimState.status === "recovery-required") {
            restored = claimState;
          } else {
            setCrossSurfacePending(describeWalletError(cause));
          }
        }
      }
      const intent = restored.status === "pending" ? restored.intent : null;
      setPendingClaim(intent);
      setClaimRecovery(restored.status === "recovery-required" ? restored.reason : null);
      setClaimStateBinding(
        account ? { wallet: account.toLowerCase(), revision } : null,
      );
      setClaiming(intent?.poolId ?? null);
      void load(null);
    });
    return () => {
      requestRef.current += 1;
      requestControllerRef.current?.abort();
      requestControllerRef.current = null;
      claimRef.current += 1;
      window.cancelAnimationFrame(frame);
    };
  }, [account, load, revision]);

  useEffect(() => {
    if (!account) return;
    const restoreMutationState = () => {
      claimRef.current += 1;
      setClaiming(null);
      try {
        assertNoPendingWalletMutation(window.localStorage, account);
        setPendingClaim(null);
        setClaimRecovery(null);
        setCrossSurfacePending(null);
        setClaimError(null);
      } catch (cause) {
        const restored = readPendingClaimStateForWallet(window.localStorage, account);
        if (restored.status === "pending") {
          setPendingClaim(restored.intent);
          setClaimRecovery(null);
          setCrossSurfacePending(null);
          setClaiming(restored.intent.poolId);
          setClaimError(null);
          return;
        }
        setPendingClaim(null);
        if (restored.status === "recovery-required") {
          setClaimRecovery(restored.reason);
          setCrossSurfacePending(null);
        } else {
          setClaimRecovery(null);
          setCrossSurfacePending(describeWalletError(cause));
        }
        setClaimError(null);
      }
    };
    const handleStorage = (event: StorageEvent) => {
      if (
        event.storageArea !== window.localStorage ||
        (event.key !== null && !PENDING_WALLET_MUTATION_STORAGE_KEYS.has(event.key))
      ) {
        return;
      }
      restoreMutationState();
    };
    window.addEventListener("storage", handleStorage);
    window.addEventListener(
      PENDING_WALLET_MUTATION_CHANGE_EVENT,
      restoreMutationState,
    );
    return () => {
      window.removeEventListener("storage", handleStorage);
      window.removeEventListener(
        PENDING_WALLET_MUTATION_CHANGE_EVENT,
        restoreMutationState,
      );
    };
  }, [account]);

  const visible = useMemo(
    () =>
      (payload?.positions ?? []).filter((position) =>
        view === "tokens"
          ? BigInt(position.balance) > BigInt(0) ||
            position.launchedByWallet ||
            position.currentCreator.toLowerCase() === account?.toLowerCase()
          : position.feeMode === "creator" &&
            (position.launchedByWallet || position.currentCreator.toLowerCase() === account?.toLowerCase()),
      ),
    [account, payload, view],
  );

  async function unlockCanonicallyRevertedClaim(intent: PendingClaimIntent) {
    try {
      await withClaimRecoveryStore(() =>
        removeExactPendingClaim(window.localStorage, intent),
      );
      notifyPendingWalletMutationCleared();
      setPendingClaim(null);
      setClaimRecovery(null);
      setClaiming(null);
      setConfirmedHash(null);
      setClaimError(
        "The claim was canonically confirmed as reverted. No payout occurred; refresh the claimable balance and retry.",
      );
      return true;
    } catch (cause) {
      setClaimRecovery(pendingClaimRecoveryFromError(cause).reason);
      setClaimError(
        "The claim reverted, but its exact local safety record could not be cleared. Claims remain locked.",
      );
      return false;
    }
  }

  async function claim(position: WalletTokenPosition) {
    if (
      !account ||
      !provider ||
      !claimStorageReady ||
      pendingClaim ||
      claimRecovery ||
      crossSurfacePending ||
      creatorHandoff.blocked
    ) return;
    const claimId = ++claimRef.current;
    const claimAccount = account;
    const claimRevision = revision;
    const deployment = readBrowserPublicLaunchDeployment();
    if (!deployment.configured) {
      setClaimError("The complete configured release manifest is not configured.");
      return;
    }
    setClaiming(position.poolId);
    setClaimError(null);
    setConfirmedHash(null);
    let submittedHash: `0x${string}` | null = null;
    const persisted = { intent: null as PendingClaimIntent | null };
    let submissionInvoked = false;
    let keepLocked = false;
    try {
      const client = new CreatorClaimClient(provider, deployment.deployment);
      const submitted = await withWalletMutationLock(
        navigator.locks,
        claimAccount,
        async () => {
          assertNoPendingWalletMutation(window.localStorage, claimAccount);
          return client.claim(claimAccount, position.poolId, {
            onSubmissionInvoked: async () => {
              const intent: PendingClaimIntent = {
                chainId: 4663,
                wallet: claimAccount,
                poolId: position.poolId,
                hash: null,
                invokedAt: Date.now(),
              };
              try {
                await withClaimRecoveryStore(() =>
                  savePendingClaim(window.localStorage, intent),
                );
              } catch (cause) {
                setClaimRecovery(pendingClaimRecoveryFromError(cause).reason);
                throw cause;
              }
              submissionInvoked = true;
              persisted.intent = intent;
              setPendingClaim(intent);
            },
            onSubmitted: async (hash) => {
              submittedHash = hash;
              if (!persisted.intent) {
                throw new Error("The pending claim intent was not saved before submission.");
              }
              try {
                await withClaimRecoveryStore(() =>
                  savePendingClaimHash(
                    window.localStorage,
                    claimAccount,
                    position.poolId,
                    hash,
                    persisted.intent!.invokedAt,
                  ),
                );
              } catch (cause) {
                setClaimRecovery(pendingClaimRecoveryFromError(cause).reason);
                throw cause;
              }
              persisted.intent = { ...persisted.intent, hash };
              setPendingClaim(persisted.intent);
            },
          });
        },
      );
      if (claimId !== claimRef.current || claimRevision !== revision) return;
      submittedHash = submitted.hash;
      await client.confirmClaim(submitted.hash, { account: claimAccount, poolId: position.poolId });
      if (claimId !== claimRef.current || claimRevision !== revision) return;
      if (!persisted.intent?.hash) {
        throw new Error("Confirmed claim has no exact saved recovery hash.");
      }
      await withClaimRecoveryStore(() =>
        removeExactPendingClaim(window.localStorage, persisted.intent!),
      );
      notifyPendingWalletMutationCleared();
      setConfirmedHash(submitted.hash);
      setPendingClaim(null);
      setClaimRecovery(null);
      setClaiming(null);
      await load(null);
    } catch (cause) {
      if (claimId !== claimRef.current) return;
      setClaimError(describeWalletError(cause));
      const revertedIntent = persisted.intent;
      if (
        isCanonicalClaimReverted(cause) &&
        revertedIntent?.hash &&
        submittedHash &&
        revertedIntent.hash.toLowerCase() === submittedHash.toLowerCase()
      ) {
        keepLocked = !(await unlockCanonicallyRevertedClaim(revertedIntent));
        return;
      }
      keepLocked = isClaimSubmissionIndeterminate(cause) || submittedHash !== null;
      if (
        !keepLocked &&
        submittedHash === null
      ) {
        if (submissionInvoked) {
          try {
            await withClaimRecoveryStore(() =>
              removeExactUnsubmittedPendingClaim(window.localStorage, revertedIntent!),
            );
            notifyPendingWalletMutationCleared();
          } catch (storageCause) {
            keepLocked = true;
            setClaimRecovery(pendingClaimRecoveryFromError(storageCause).reason);
            setClaimError(
              "The wallet request was not submitted, but its local safety record could not be cleared. Claims remain locked.",
            );
          }
        }
        if (!keepLocked) setPendingClaim(null);
      }
    } finally {
      if (claimId === claimRef.current && !keepLocked) setClaiming(null);
    }
  }

  async function reconcilePendingClaim() {
    if (!account || !provider || !pendingClaim?.hash) return;
    const operation = ++claimRef.current;
    const deployment = readBrowserPublicLaunchDeployment();
    if (!deployment.configured) {
      setClaimError("The complete configured release manifest is not configured.");
      return;
    }
    setClaiming(pendingClaim.poolId);
    setClaimError(null);
    try {
      const client = new CreatorClaimClient(provider, deployment.deployment);
      await client.confirmClaim(pendingClaim.hash, {
        account,
        poolId: pendingClaim.poolId,
      });
      if (operation !== claimRef.current) return;
      await withClaimRecoveryStore(() =>
        removeExactPendingClaim(window.localStorage, pendingClaim),
      );
      notifyPendingWalletMutationCleared();
      setConfirmedHash(pendingClaim.hash);
      setPendingClaim(null);
      setClaimRecovery(null);
      setClaiming(null);
      await load(null);
    } catch (cause) {
      if (operation !== claimRef.current) return;
      if (isCanonicalClaimReverted(cause)) {
        await unlockCanonicallyRevertedClaim(pendingClaim);
        return;
      }
      setClaimError(describeWalletError(cause));
    }
  }

  async function clearReconciledClaimLock() {
    if (!account || !pendingClaim || pendingClaim.hash !== null) return;
    try {
      await withWalletRecoveryLocks(navigator.locks, account, () =>
        removeExactUnsubmittedPendingClaim(window.localStorage, pendingClaim),
      );
      notifyPendingWalletMutationCleared();
      setPendingClaim(null);
      setClaimRecovery(null);
      setClaiming(null);
      setClaimError(null);
    } catch (cause) {
      setClaimRecovery(pendingClaimRecoveryFromError(cause).reason);
      setClaimError("The local claim safety record could not be cleared. Claims remain locked.");
    }
  }

  async function resetClaimSafetyLock() {
    if (!claimRecovery || !account) return;
    try {
      await withWalletRecoveryLocks(navigator.locks, account, () =>
        resetPendingClaimForWallet(window.localStorage, account),
      );
      notifyPendingWalletMutationCleared();
      setPendingClaim(null);
      setClaimRecovery(null);
      setClaiming(null);
      setClaimError(null);
    } catch (cause) {
      setClaimRecovery(pendingClaimRecoveryFromError(cause).reason);
      setClaimError("Browser storage is still unavailable. The claim safety lock remains active.");
    }
  }

  if (marketMode !== "live") {
    return (
      <section className="wallet-empty-state wallet-live-state">
        <div>
          <span className="status-pill">Fixture-safe</span>
          <h2>Live wallet data is disabled.</h2>
          <p>No balances or reward values are being substituted while fixture mode is active.</p>
        </div>
      </section>
    );
  }
  if (!account) {
    return (
      <section className="wallet-empty-state wallet-live-state">
        <div>
          <span className="status-pill">Wallet required</span>
          <h2>Connect to inspect your pipes.</h2>
          <p>Balances come from the fresh Neon index. Claims are re-verified through your wallet against the configured release hook before submission.</p>
          <button className="button button-accent" type="button" onClick={() => void connect()} disabled={status === "connecting"}>
            {status === "connecting" ? "Connecting..." : "Connect wallet"}
          </button>
          {walletError && <p className="form-error" role="alert">{walletError}</p>}
        </div>
      </section>
    );
  }
  if (loading && !payload) return <p className="wallet-loading">Loading indexed wallet positions...</p>;
  if (error) return <p className="form-error" role="alert">{error}</p>;

  return (
    <section className="wallet-position-list" aria-label={view === "tokens" ? "Wallet tokens" : "Creator rewards"}>
      <div className="wallet-snapshot-note">
        Indexed through block {payload?.asOfBlock ?? "unavailable"}. Claimable values appear only after a fresh wallet preflight.
      </div>
      {visible.length === 0 ? (
        <div className="wallet-empty-state wallet-live-state"><div><h2>No indexed positions yet.</h2><p>Launch or acquire a LayPipe token and it will appear after the finalized index catches up.</p></div></div>
      ) : visible.map((position) => (
        <article className="wallet-position-card" key={position.poolId}>
          <div>
            <span className="status-pill">{position.feeMode === "creator" ? "Creator fees" : "Self-burn"}</span>
            <h3>{position.name ?? "Unnamed token"} <small>${position.symbol ?? "—"}</small></h3>
            <p>{amount(position.balance)} tokens indexed in this wallet</p>
          </div>
          <dl>
            <div><dt>Lifetime claimed</dt><dd>{amount(position.lifetimeCreatorClaimedPipedog)} PIPEDOG</dd></div>
            <div><dt>Tokens burned</dt><dd>{amount(position.lifetimeSelfBurnedTokens)} tokens</dd></div>
            <div><dt>Claimable</dt><dd>Verify in wallet</dd></div>
            {view === "tokens" && position.feeMode === "creator" && (
              <>
                <div className="wallet-creator-address"><dt>Original creator</dt><dd><code>{position.originalCreator}</code></dd></div>
                <div className="wallet-creator-address"><dt>Current creator</dt><dd><code>{position.currentCreator}</code></dd></div>
              </>
            )}
          </dl>
          <div className="wallet-position-actions">
            <a className="button button-quiet button-small" href={explorerTokenUrl(position.tokenAddress)} target="_blank" rel="noreferrer">Explorer</a>
            {position.feeMode === "creator" &&
              position.currentCreator.toLowerCase() === account.toLowerCase() && (
              <button className="button button-accent button-small" type="button" onClick={() => void claim(position)} disabled={!claimStorageReady || claiming !== null || pendingClaim !== null || claimRecovery !== null || crossSurfacePending !== null || creatorHandoff.blocked}>
                {claiming === position.poolId ? "Claiming..." : "Verify & claim"}
              </button>
            )}
            {view === "tokens" &&
              position.feeMode === "creator" &&
              position.isCurrentCreator &&
              position.currentCreator.toLowerCase() === account.toLowerCase() &&
              creatorHandoff.draft?.poolId.toLowerCase() !== position.poolId.toLowerCase() && (
                <button
                  className="button button-quiet button-small"
                  type="button"
                  onClick={() => creatorHandoff.open(position)}
                  disabled={
                    creatorHandoff.blocked ||
                    claiming !== null ||
                    pendingClaim !== null ||
                    claimRecovery !== null ||
                    crossSurfacePending !== null
                  }
                >
                  Hand off creator
                </button>
              )}
          </div>
          {view === "tokens" &&
            creatorHandoff.draft?.poolId.toLowerCase() === position.poolId.toLowerCase() && (
              <form
                className="creator-handoff-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  void creatorHandoff.submit(position);
                }}
              >
                <div>
                  <h4>Hand off the creator lane</h4>
                  <p id={`creator-handoff-warning-${position.poolId}`}>
                    This is irreversible from the old wallet. The new wallet or Safe immediately becomes the only address that can claim this pool&apos;s current and future creator PIPEDOG.
                  </p>
                </div>
                <label htmlFor={`creator-handoff-address-${position.poolId}`}>
                  New creator / Safe address
                  <input
                    id={`creator-handoff-address-${position.poolId}`}
                    name="newCreator"
                    type="text"
                    inputMode="text"
                    autoComplete="off"
                    autoCapitalize="none"
                    spellCheck={false}
                    value={creatorHandoff.draft.destination}
                    aria-describedby={`creator-handoff-warning-${position.poolId}`}
                    onChange={(event) => creatorHandoff.setDestination(event.target.value)}
                    disabled={creatorHandoff.blocked}
                    placeholder="0x... (exact checksum required)"
                  />
                </label>
                <label className="creator-handoff-acknowledgement">
                  <input
                    type="checkbox"
                    checked={creatorHandoff.draft.acknowledged}
                    onChange={(event) => creatorHandoff.setAcknowledged(event.target.checked)}
                    disabled={creatorHandoff.blocked}
                  />
                  <span>I verified that I control this exact destination and understand the old creator loses claim rights immediately.</span>
                </label>
                <div className="creator-handoff-actions">
                  <button
                    className="button button-accent button-small"
                    type="submit"
                    disabled={
                      creatorHandoff.blocked ||
                      !creatorHandoff.draft.destination ||
                      !creatorHandoff.draft.acknowledged ||
                      claiming !== null ||
                      pendingClaim !== null ||
                      claimRecovery !== null ||
                      crossSurfacePending !== null
                    }
                  >
                    {creatorHandoff.submittingPoolId === position.poolId
                      ? "Confirming handoff..."
                      : "Verify & hand off permanently"}
                  </button>
                  <button
                    className="button button-quiet button-small"
                    type="button"
                    onClick={creatorHandoff.close}
                    disabled={creatorHandoff.submittingPoolId !== null}
                  >
                    Cancel
                  </button>
                </div>
              </form>
            )}
        </article>
      ))}
      {nextCursor && <button className="button button-quiet" type="button" disabled={loading} onClick={() => void load(nextCursor)}>{loading ? "Loading..." : "Load more"}</button>}
      {claimError && <p className="form-error" role="alert">{claimError}</p>}
      {crossSurfacePending && (
        <div className="wallet-snapshot-note" role="alert">
          <p>
            Claims are locked because another LayPipe wallet action is unresolved. {crossSurfacePending}
          </p>
        </div>
      )}
      {claimRecovery && (
        <div className="wallet-snapshot-note" role="alert">
          <p>
            Claims are locked. {claimRecoveryMessage(claimRecovery)} A previous wallet request cannot be ruled out. Check this wallet&apos;s recent claim activity before resetting its local lock.
          </p>
          <button className="button button-quiet button-small" type="button" onClick={() => void resetClaimSafetyLock()}>
            I checked wallet activity; reset this wallet&apos;s claim lock
          </button>
        </div>
      )}
      {pendingClaim && (
        <div className="wallet-snapshot-note" role="status">
          <p>
            {pendingClaim.hash
              ? "Claim submitted. Do not retry until its canonical receipt is reconciled."
              : "The wallet may have submitted this claim without returning a hash. Check wallet activity before taking another claim action."}
          </p>
          {pendingClaim.hash && (
            <>
              <a href={explorerTransactionUrl(pendingClaim.hash)} target="_blank" rel="noreferrer">View transaction</a>{" "}
              <button className="button button-quiet button-small" type="button" onClick={() => void reconcilePendingClaim()}>Recheck canonical receipt</button>
            </>
          )}
          {!pendingClaim.hash && (
            <button className="button button-quiet button-small" type="button" onClick={() => void clearReconciledClaimLock()}>
              I checked wallet activity; clear hashless lock
            </button>
          )}
        </div>
      )}
      {confirmedHash && <p className="form-success" role="status">Claim confirmed. <a href={explorerTransactionUrl(confirmedHash as `0x${string}`)} target="_blank" rel="noreferrer">View receipt</a></p>}
      {view === "tokens" && creatorHandoff.error && (
        <p className="form-error" role="alert">{creatorHandoff.error}</p>
      )}
      {view === "tokens" && creatorHandoff.crossSurfacePending && (
        <div className="wallet-snapshot-note" role="alert">
          <p>
            Creator handoffs are locked because another LayPipe wallet action is unresolved. {creatorHandoff.crossSurfacePending}
          </p>
        </div>
      )}
      {view === "tokens" && creatorHandoff.recovery && (
        <div className="wallet-snapshot-note" role="alert">
          <p>
            Creator handoffs are locked. {creatorHandoffRecoveryMessage(creatorHandoff.recovery)} A previous wallet request cannot be ruled out. Check creator-update activity for every wallet used in this browser before resetting these local locks.
          </p>
          <button
            className="button button-quiet button-small"
            type="button"
            onClick={() => void creatorHandoff.resetSafetyLock()}
            disabled={creatorHandoff.liveOperation || creatorHandoff.recoveryBusy}
          >
            I checked wallet activity; reset creator-handoff locks
          </button>
        </div>
      )}
      {view === "tokens" && creatorHandoff.pending && (
        <div className="wallet-snapshot-note" role="status">
          <p>
            {creatorHandoff.pending.hash
              ? `Creator handoff to ${creatorHandoff.pending.newCreator} was submitted. Do not retry until its canonical receipt is reconciled.`
              : "The wallet may have submitted this creator handoff without returning a hash. Check wallet activity before any other LayPipe transaction."}
          </p>
          {creatorHandoff.pending.hash && (
            <>
              <a href={explorerTransactionUrl(creatorHandoff.pending.hash)} target="_blank" rel="noreferrer">View transaction</a>{" "}
              <button
                className="button button-quiet button-small"
                type="button"
                onClick={() => void creatorHandoff.reconcile()}
                disabled={creatorHandoff.liveOperation || creatorHandoff.recoveryBusy}
              >
                Recheck canonical receipt
              </button>
            </>
          )}
          {!creatorHandoff.pending.hash && (
            <button
              className="button button-quiet button-small"
              type="button"
              onClick={() => void creatorHandoff.clearCheckedLock()}
              disabled={creatorHandoff.liveOperation || creatorHandoff.recoveryBusy}
            >
              I checked wallet activity; clear unresolved lock
            </button>
          )}
        </div>
      )}
      {view === "tokens" && creatorHandoff.confirmed && (
        <p className="form-success" role="status">
          Creator handoff to {creatorHandoff.confirmed.newCreator} confirmed. <a href={explorerTransactionUrl(creatorHandoff.confirmed.hash)} target="_blank" rel="noreferrer">View receipt</a>
        </p>
      )}
    </section>
  );
}
