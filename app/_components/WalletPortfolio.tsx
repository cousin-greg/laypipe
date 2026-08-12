"use client";

import Link from "next/link";
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
  removePendingClaim,
  resetPendingClaimStore,
  savePendingClaim,
  savePendingClaimHash,
  type PendingClaimIntent,
  type PendingClaimRecoveryReason,
  type PendingClaimState,
} from "@/lib/wallet/pending-claims";
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
      let restored: PendingClaimState = { status: "clear" };
      if (account) {
        try {
          restored = readPendingClaimStateForWallet(window.localStorage, account);
        } catch (cause) {
          restored = pendingClaimRecoveryFromError(cause);
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

  function unlockCanonicallyRevertedClaim(intent: PendingClaimIntent) {
    try {
      removeExactPendingClaim(window.localStorage, intent);
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
    if (!account || !provider || !claimStorageReady || pendingClaim || claimRecovery) return;
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
      const submitted = await client.claim(claimAccount, position.poolId, {
        onSubmissionInvoked: () => {
          const intent: PendingClaimIntent = {
            chainId: 4663,
            wallet: claimAccount,
            poolId: position.poolId,
            hash: null,
            invokedAt: Date.now(),
          };
          try {
            savePendingClaim(window.localStorage, intent);
          } catch (cause) {
            setClaimRecovery(pendingClaimRecoveryFromError(cause).reason);
            throw cause;
          }
          submissionInvoked = true;
          persisted.intent = intent;
          setPendingClaim(intent);
        },
        onSubmitted: (hash) => {
          submittedHash = hash;
          if (!persisted.intent) {
            throw new Error("The pending claim intent was not saved before submission.");
          }
          try {
            savePendingClaimHash(
              window.localStorage,
              claimAccount,
              position.poolId,
              hash,
            );
          } catch (cause) {
            setClaimRecovery(pendingClaimRecoveryFromError(cause).reason);
            throw cause;
          }
          persisted.intent = { ...persisted.intent, hash };
          setPendingClaim(persisted.intent);
        },
      });
      if (claimId !== claimRef.current || claimRevision !== revision) return;
      submittedHash = submitted.hash;
      await client.confirmClaim(submitted.hash, { account: claimAccount, poolId: position.poolId });
      if (claimId !== claimRef.current || claimRevision !== revision) return;
      removePendingClaim(window.localStorage, claimAccount, position.poolId);
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
        keepLocked = !unlockCanonicallyRevertedClaim(revertedIntent);
        return;
      }
      keepLocked = isClaimSubmissionIndeterminate(cause) || submittedHash !== null;
      if (
        !keepLocked &&
        submittedHash === null
      ) {
        if (submissionInvoked) {
          try {
            removePendingClaim(
              window.localStorage,
              claimAccount,
              position.poolId,
            );
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
      removePendingClaim(window.localStorage, account, pendingClaim.poolId);
      setConfirmedHash(pendingClaim.hash);
      setPendingClaim(null);
      setClaimRecovery(null);
      setClaiming(null);
      await load(null);
    } catch (cause) {
      if (operation !== claimRef.current) return;
      if (isCanonicalClaimReverted(cause)) {
        unlockCanonicallyRevertedClaim(pendingClaim);
        return;
      }
      setClaimError(describeWalletError(cause));
    }
  }

  function clearReconciledClaimLock() {
    if (!account || !pendingClaim) return;
    try {
      removePendingClaim(window.localStorage, account, pendingClaim.poolId);
      setPendingClaim(null);
      setClaimRecovery(null);
      setClaiming(null);
      setClaimError(null);
    } catch (cause) {
      setClaimRecovery(pendingClaimRecoveryFromError(cause).reason);
      setClaimError("The local claim safety record could not be cleared. Claims remain locked.");
    }
  }

  function resetClaimSafetyLock() {
    if (!claimRecovery) return;
    try {
      resetPendingClaimStore(window.localStorage);
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
          </dl>
          <div className="wallet-position-actions">
            <a className="button button-quiet button-small" href={explorerTokenUrl(position.tokenAddress)} target="_blank" rel="noreferrer">Explorer</a>
            {position.feeMode === "creator" &&
              position.currentCreator.toLowerCase() === account.toLowerCase() && (
              <button className="button button-accent button-small" type="button" onClick={() => void claim(position)} disabled={!claimStorageReady || claiming !== null || pendingClaim !== null || claimRecovery !== null}>
                {claiming === position.poolId ? "Claiming..." : "Verify & claim"}
              </button>
            )}
          </div>
        </article>
      ))}
      {nextCursor && <button className="button button-quiet" type="button" disabled={loading} onClick={() => void load(nextCursor)}>{loading ? "Loading..." : "Load more"}</button>}
      {claimError && <p className="form-error" role="alert">{claimError}</p>}
      {claimRecovery && (
        <div className="wallet-snapshot-note" role="alert">
          <p>
            Claims are locked. {claimRecoveryMessage(claimRecovery)} A previous wallet request cannot be ruled out. Check recent claim activity for every wallet used in this browser before resetting all local claim locks.
          </p>
          <button className="button button-quiet button-small" type="button" onClick={resetClaimSafetyLock}>
            I checked wallet activity; reset all local claim locks
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
          <button className="button button-quiet button-small" type="button" onClick={clearReconciledClaimLock}>
            I checked wallet activity; clear lock
          </button>
        </div>
      )}
      {confirmedHash && <p className="form-success" role="status">Claim confirmed. <a href={explorerTransactionUrl(confirmedHash as `0x${string}`)} target="_blank" rel="noreferrer">View receipt</a></p>}
      {view === "rewards" && <p className="wallet-snapshot-note">Keeper jobs remain unavailable until their eligibility endpoints and per-wallet reward accounting are production-ready. No fake values are shown. <Link href="/docs#keepers">How keepers work</Link></p>}
    </section>
  );
}
