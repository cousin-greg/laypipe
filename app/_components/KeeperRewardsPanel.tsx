"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  parseKeeperRewardsResponse,
  type KeeperRewardsResponse,
} from "@/lib/keeper/live";
import {
  keeperActionFromIntent,
  pendingKeeperRecoveryFromError,
  readPendingKeeperActionForWallet,
  removeExactPendingKeeperAction,
  removeExactUnsubmittedKeeperAction,
  resetPendingKeeperActionForWallet,
  savePendingKeeperAction,
  savePendingKeeperActionHash,
  type PendingKeeperActionIntent,
  type PendingKeeperActionState,
  type PendingKeeperRecoveryReason,
} from "@/lib/wallet/pending-keeper-actions";
import {
  withWalletMutationLock,
  withWalletRecoveryLocks,
  withWalletRecoveryStoreLock,
} from "@/lib/wallet/mutation-lock";
import {
  assertNoPendingWalletMutation,
  PENDING_WALLET_MUTATION_STORAGE_KEYS,
} from "@/lib/wallet/pending-wallet-mutations";
import { readBrowserPublicLaunchDeployment } from "@/lib/web3/browser-deployment";
import {
  CanonicalKeeperRevertedError,
  KeeperClient,
  isKeeperSubmissionIndeterminate,
  keeperActionCall,
  type KeeperAction,
  type KeeperJobState,
} from "@/lib/web3/keeper-client";
import { describeWalletError } from "@/lib/web3/launch-client";
import { explorerTransactionUrl } from "@/lib/web3/robinhood";
import { formatUnits } from "@/lib/web3/units";

import { useMarketData } from "./MarketDataProvider";
import { useWallet } from "./WalletProvider";

function amount(value: bigint | string, maximumFractionDigits = 4) {
  return formatUnits(BigInt(value), 18, maximumFractionDigits);
}

function actionKey(action: KeeperAction) {
  return action.kind === "sweep"
    ? `sweep:${action.poolId.toLowerCase()}`
    : action.kind;
}

function actionLabel(action: KeeperAction) {
  switch (action.kind) {
    case "sweep":
      return "Sweep pool fees";
    case "collect-platform":
      return "Collect deferred platform fees";
    case "sequester":
      return "Sequester PIPEDOG";
    case "route-treasury":
      return "Route treasury PIPEDOG";
  }
}

function recoveryMessage(reason: PendingKeeperRecoveryReason) {
  switch (reason) {
    case "unreadable":
      return "Browser storage could not be read or written.";
    case "malformed":
      return "The saved keeper safety record is malformed.";
    case "over-cap":
      return "The saved keeper safety record exceeded its strict size limit.";
    case "expired":
      return "An expired keeper record still represents ambiguous wallet activity.";
    case "corrupt":
      return "The saved keeper safety record failed its integrity checks.";
  }
}

export function KeeperRewardsPanel() {
  const { marketMode } = useMarketData();
  const { account, provider, revision } = useWallet();
  const [payload, setPayload] = useState<KeeperRewardsResponse | null>(null);
  const [jobs, setJobs] = useState<KeeperJobState[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [verificationError, setVerificationError] = useState<string | null>(null);
  const [activeAction, setActiveAction] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<PendingKeeperActionIntent | null>(null);
  const [recovery, setRecovery] = useState<PendingKeeperRecoveryReason | null>(null);
  const [crossSurfacePending, setCrossSurfacePending] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState<{
    hash: `0x${string}`;
    message: string;
  } | null>(null);
  const [storageBinding, setStorageBinding] = useState<{
    wallet: string;
    revision: number;
  } | null>(null);
  const requestRef = useRef(0);
  const requestControllerRef = useRef<AbortController | null>(null);
  const actionRef = useRef(0);
  const storageReady =
    account !== null &&
    storageBinding?.wallet === account.toLowerCase() &&
    storageBinding.revision === revision;

  function withKeeperRecoveryStore<T>(operation: () => Promise<T> | T) {
    return withWalletRecoveryStoreLock(navigator.locks, operation);
  }

  const load = useCallback(async () => {
    if (marketMode !== "live" || !account || !provider) return;
    const requestId = ++requestRef.current;
    const requestedWallet = account;
    const requestedRevision = revision;
    requestControllerRef.current?.abort();
    const controller = new AbortController();
    requestControllerRef.current = controller;
    setLoading(true);
    setError(null);
    setVerificationError(null);
    try {
      const response = await fetch("/api/keeper", {
        method: "POST",
        credentials: "omit",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ wallet: requestedWallet }),
        cache: "no-store",
        signal: controller.signal,
      });
      const raw: unknown = await response.json();
      if (!response.ok) {
        const body = raw && typeof raw === "object"
          ? raw as { error?: { message?: unknown } }
          : {};
        throw new Error(
          typeof body.error?.message === "string"
            ? body.error.message
            : "Keeper data is unavailable.",
        );
      }
      const parsed = parseKeeperRewardsResponse(raw, requestedWallet);
      if (
        requestId !== requestRef.current ||
        requestedRevision !== revision ||
        controller.signal.aborted
      ) return;
      setPayload(parsed);
      const deployment = readBrowserPublicLaunchDeployment();
      if (!deployment.configured) {
        setJobs([]);
        setVerificationError(
          "The complete configured release manifest is unavailable. Keeper calls remain blocked.",
        );
        return;
      }
      try {
        const client = new KeeperClient(provider, deployment.deployment);
        const verified = await client.readJobs(
          requestedWallet,
          parsed.sweepCandidates.map((candidate) => candidate.poolId),
        );
        if (
          requestId !== requestRef.current ||
          requestedRevision !== revision ||
          controller.signal.aborted
        ) return;
        setJobs(verified.jobs);
      } catch (cause) {
        if (requestId !== requestRef.current || controller.signal.aborted) return;
        setJobs([]);
        setVerificationError(
          `Live eligibility could not be proven: ${describeWalletError(cause)}`,
        );
      }
    } catch (cause) {
      if (requestId !== requestRef.current || controller.signal.aborted) return;
      setPayload(null);
      setJobs([]);
      setError(cause instanceof Error ? cause.message : "Keeper data is unavailable.");
    } finally {
      if (requestId === requestRef.current) {
        setLoading(false);
        if (requestControllerRef.current === controller) {
          requestControllerRef.current = null;
        }
      }
    }
  }, [account, marketMode, provider, revision]);

  useEffect(() => {
    requestRef.current += 1;
    requestControllerRef.current?.abort();
    requestControllerRef.current = null;
    actionRef.current += 1;
    const frame = window.requestAnimationFrame(() => {
      setPayload(null);
      setJobs([]);
      setError(null);
      setVerificationError(null);
      setConfirmed(null);
      setCrossSurfacePending(null);
      let restored: PendingKeeperActionState = { status: "clear" };
      if (account) {
        restored = readPendingKeeperActionForWallet(window.localStorage, account);
        if (restored.status === "clear") {
          try {
            assertNoPendingWalletMutation(window.localStorage, account);
          } catch (cause) {
            setCrossSurfacePending(describeWalletError(cause));
          }
        }
      }
      const intent = restored.status === "pending" ? restored.intent : null;
      setPendingAction(intent);
      setRecovery(restored.status === "recovery-required" ? restored.reason : null);
      setActiveAction(intent ? actionKey(keeperActionFromIntent(intent)) : null);
      setStorageBinding(account ? { wallet: account.toLowerCase(), revision } : null);
      void load();
    });
    return () => {
      requestRef.current += 1;
      requestControllerRef.current?.abort();
      requestControllerRef.current = null;
      actionRef.current += 1;
      window.cancelAnimationFrame(frame);
    };
  }, [account, load, revision]);

  useEffect(() => {
    if (!account) return;
    const handleStorage = (event: StorageEvent) => {
      if (
        event.storageArea !== window.localStorage ||
        (event.key !== null && !PENDING_WALLET_MUTATION_STORAGE_KEYS.has(event.key))
      ) return;
      actionRef.current += 1;
      setActiveAction(null);
      const restored = readPendingKeeperActionForWallet(window.localStorage, account);
      if (restored.status === "pending") {
        setPendingAction(restored.intent);
        setRecovery(null);
        setCrossSurfacePending(null);
        setActiveAction(actionKey(keeperActionFromIntent(restored.intent)));
        return;
      }
      setPendingAction(null);
      if (restored.status === "recovery-required") {
        setRecovery(restored.reason);
        setCrossSurfacePending(null);
        return;
      }
      setRecovery(null);
      try {
        assertNoPendingWalletMutation(window.localStorage, account);
        setCrossSurfacePending(null);
      } catch (cause) {
        setCrossSurfacePending(describeWalletError(cause));
      }
    };
    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, [account]);

  const candidateByPool = useMemo(
    () => new Map(
      (payload?.sweepCandidates ?? []).map((candidate) => [
        candidate.poolId.toLowerCase(),
        candidate,
      ]),
    ),
    [payload],
  );

  async function submit(action: KeeperAction) {
    if (
      !account ||
      !provider ||
      !storageReady ||
      pendingAction ||
      recovery ||
      crossSurfacePending
    ) return;
    const operation = ++actionRef.current;
    const operationRevision = revision;
    const operationAccount = account;
    const key = actionKey(action);
    const deployment = readBrowserPublicLaunchDeployment();
    if (!deployment.configured) {
      setVerificationError("The complete configured release manifest is unavailable.");
      return;
    }
    setActiveAction(key);
    setError(null);
    setConfirmed(null);
    let submittedHash: `0x${string}` | null = null;
    const persisted = { intent: null as PendingKeeperActionIntent | null };
    let submissionInvoked = false;
    let keepLocked = false;
    try {
      const client = new KeeperClient(provider, deployment.deployment);
      const submitted = await withWalletMutationLock(
        navigator.locks,
        operationAccount,
        async () => {
          assertNoPendingWalletMutation(window.localStorage, operationAccount);
          return client.submitAction(operationAccount, action, {
            onSubmissionInvoked: async () => {
              const call = keeperActionCall(deployment.deployment, action);
              const intent: PendingKeeperActionIntent = {
                chainId: 4663,
                wallet: operationAccount,
                action: action.kind,
                poolId: action.kind === "sweep" ? action.poolId : null,
                target: call.target,
                calldata: call.data,
                hash: null,
                invokedAt: Date.now(),
              };
              try {
                await withKeeperRecoveryStore(() =>
                  savePendingKeeperAction(window.localStorage, intent),
                );
              } catch (cause) {
                setRecovery(pendingKeeperRecoveryFromError(cause).reason);
                throw cause;
              }
              submissionInvoked = true;
              persisted.intent = intent;
              setPendingAction(intent);
            },
            onSubmitted: async (hash) => {
              submittedHash = hash;
              if (!persisted.intent) {
                throw new Error("The pending keeper intent was not saved before submission.");
              }
              try {
                await withKeeperRecoveryStore(() =>
                  savePendingKeeperActionHash(window.localStorage, persisted.intent!, hash),
                );
              } catch (cause) {
                setRecovery(pendingKeeperRecoveryFromError(cause).reason);
                throw cause;
              }
              persisted.intent = { ...persisted.intent, hash };
              setPendingAction(persisted.intent);
            },
          });
        },
      );
      if (operation !== actionRef.current || operationRevision !== revision) return;
      submittedHash = submitted.hash;
      const result = await client.confirmAction(submitted.hash, {
        account: operationAccount,
        action,
      });
      if (operation !== actionRef.current || operationRevision !== revision) return;
      if (!persisted.intent?.hash) {
        throw new Error("Confirmed keeper action has no exact saved hash.");
      }
      await withKeeperRecoveryStore(() =>
        removeExactPendingKeeperAction(window.localStorage, persisted.intent!),
      );
      setPendingAction(null);
      setRecovery(null);
      setConfirmed({
        hash: submitted.hash,
        message: result.noOp
          ? "Keeper transaction confirmed as a no-op; another caller processed the state first. No reward is being reported."
          : result.bountyPipedog > BigInt(0)
            ? `Keeper transaction confirmed with ${amount(result.bountyPipedog)} PIPEDOG bounty.`
            : "Maintenance transaction confirmed. This action has no keeper bounty.",
      });
      setActiveAction(null);
      await load();
    } catch (cause) {
      if (operation !== actionRef.current) return;
      setError(describeWalletError(cause));
      const exact = persisted.intent;
      if (
        cause instanceof CanonicalKeeperRevertedError &&
        exact?.hash &&
        submittedHash &&
        exact.hash.toLowerCase() === submittedHash.toLowerCase()
      ) {
        try {
          await withKeeperRecoveryStore(() =>
            removeExactPendingKeeperAction(window.localStorage, exact),
          );
          setPendingAction(null);
          setError(
            "The keeper transaction was canonically confirmed as reverted. No reward occurred; refresh eligibility before retrying.",
          );
        } catch (storageCause) {
          keepLocked = true;
          setRecovery(pendingKeeperRecoveryFromError(storageCause).reason);
        }
        return;
      }
      keepLocked = isKeeperSubmissionIndeterminate(cause) || submittedHash !== null;
      if (!keepLocked && submissionInvoked && exact?.hash === null) {
        try {
          await withKeeperRecoveryStore(() =>
            removeExactUnsubmittedKeeperAction(window.localStorage, exact),
          );
          setPendingAction(null);
        } catch (storageCause) {
          keepLocked = true;
          setRecovery(pendingKeeperRecoveryFromError(storageCause).reason);
          setError(
            "The wallet request was rejected, but its exact local safety record could not be cleared. Keeper actions remain locked.",
          );
        }
      }
    } finally {
      if (operation === actionRef.current && !keepLocked) setActiveAction(null);
    }
  }

  async function reconcilePending() {
    if (!account || !provider || !pendingAction?.hash) return;
    const operation = ++actionRef.current;
    const deployment = readBrowserPublicLaunchDeployment();
    if (!deployment.configured) {
      setError("The complete configured release manifest is unavailable.");
      return;
    }
    const action = keeperActionFromIntent(pendingAction);
    const call = keeperActionCall(deployment.deployment, action);
    if (
      !sameIntentCall(pendingAction, call.target, call.data)
    ) {
      setRecovery("corrupt");
      setError("The saved keeper target or calldata does not match this release manifest.");
      return;
    }
    setActiveAction(actionKey(action));
    setError(null);
    try {
      const client = new KeeperClient(provider, deployment.deployment);
      const result = await client.confirmAction(pendingAction.hash, { account, action });
      if (operation !== actionRef.current) return;
      await withKeeperRecoveryStore(() =>
        removeExactPendingKeeperAction(window.localStorage, pendingAction),
      );
      setPendingAction(null);
      setRecovery(null);
      setActiveAction(null);
      setConfirmed({
        hash: pendingAction.hash,
        message: result.noOp
          ? "Keeper transaction confirmed as a no-op. No reward is being reported."
          : result.bountyPipedog > BigInt(0)
            ? `Keeper transaction confirmed with ${amount(result.bountyPipedog)} PIPEDOG bounty.`
            : "Maintenance transaction confirmed. This action has no keeper bounty.",
      });
      await load();
    } catch (cause) {
      if (operation !== actionRef.current) return;
      if (cause instanceof CanonicalKeeperRevertedError) {
        try {
          await withKeeperRecoveryStore(() =>
            removeExactPendingKeeperAction(window.localStorage, pendingAction),
          );
          setPendingAction(null);
          setActiveAction(null);
          setError("The keeper transaction canonically reverted. No reward occurred.");
        } catch (storageCause) {
          setRecovery(pendingKeeperRecoveryFromError(storageCause).reason);
        }
        return;
      }
      setError(describeWalletError(cause));
    }
  }

  async function clearHashlessIntent() {
    if (!account || !pendingAction || pendingAction.hash !== null) return;
    try {
      await withWalletRecoveryLocks(navigator.locks, account, () =>
        removeExactUnsubmittedKeeperAction(window.localStorage, pendingAction),
      );
      setPendingAction(null);
      setRecovery(null);
      setActiveAction(null);
      setError(null);
    } catch (cause) {
      setRecovery(pendingKeeperRecoveryFromError(cause).reason);
      setError("The local keeper safety record could not be cleared.");
    }
  }

  async function resetRecoveryLock() {
    if (!recovery || !account) return;
    try {
      await withWalletRecoveryLocks(navigator.locks, account, () =>
        resetPendingKeeperActionForWallet(window.localStorage, account),
      );
      setPendingAction(null);
      setRecovery(null);
      setActiveAction(null);
      setError(null);
    } catch (cause) {
      setRecovery(pendingKeeperRecoveryFromError(cause).reason);
      setError("Browser storage is still unavailable. Keeper actions remain locked.");
    }
  }

  if (marketMode !== "live") {
    return (
      <section className="wallet-empty-state wallet-live-state">
        <div>
          <span className="status-pill">Fixture-safe</span>
          <h2>Live keeper data is disabled.</h2>
          <p>No reward totals or executable jobs are substituted in fixture mode.</p>
        </div>
      </section>
    );
  }
  if (!account || !provider) {
    return (
      <section className="wallet-snapshot-note">
        Connect a wallet to load exact indexed keeper rewards and independently
        simulate current maintenance jobs.
      </section>
    );
  }

  const mutationsLocked =
    !storageReady ||
    activeAction !== null ||
    pendingAction !== null ||
    recovery !== null ||
    crossSurfacePending !== null;

  return (
    <section className="keeper-rewards-panel" aria-label="Permissionless keeper rewards">
      <div className="wallet-snapshot-note">
        Indexed through block {payload?.asOfBlock ?? "unavailable"}. Reward history
        comes only from canonical caller+bounty events. Job eligibility is separately
        re-read and simulated through the connected wallet.
      </div>

      {loading && !payload && <p className="wallet-loading">Loading keeper accounting...</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
      {payload && (
        <>
          <div className="keeper-reward-summary">
            <article className="wallet-position-card">
              <div>
                <span className="status-pill">Indexed rewards</span>
                <h3>{amount(payload.accounting.totalBountyPipedog)} PIPEDOG</h3>
                <p>Lifetime router bounties paid to this caller.</p>
              </div>
              <dl>
                <div><dt>Sequester</dt><dd>{amount(payload.accounting.sequesterBountyPipedog)} PIPEDOG</dd></div>
                <div><dt>Treasury route</dt><dd>{amount(payload.accounting.treasuryBountyPipedog)} PIPEDOG</dd></div>
                <div><dt>Zero-bounty sweeps</dt><dd>{payload.accounting.sweepCalls}</dd></div>
              </dl>
            </article>
          </div>

          <div className="keeper-job-list">
            <div className="section-heading compact-heading">
              <div>
                <p className="eyebrow">CURRENT CONTRACT STATE</p>
                <h2>Permissionless jobs</h2>
              </div>
              <button className="button button-quiet button-small" type="button" onClick={() => void load()} disabled={loading || activeAction !== null}>
                {loading ? "Verifying..." : "Refresh & simulate"}
              </button>
            </div>
            {verificationError && <p className="form-error" role="alert">{verificationError}</p>}
            {jobs.map((job) => {
              const key = actionKey(job.action);
              const candidate = job.action.kind === "sweep"
                ? candidateByPool.get(job.action.poolId.toLowerCase())
                : null;
              return (
                <article className="wallet-position-card" key={key}>
                  <div>
                    <span className="status-pill">{job.eligible ? "Simulation passed" : "Unavailable"}</span>
                    <h3>{actionLabel(job.action)}</h3>
                    <p>
                      {candidate
                        ? `${candidate.name ?? "Unnamed token"} ${candidate.symbol ? `$${candidate.symbol}` : ""}`
                        : job.action.kind === "collect-platform"
                          ? "Moves the hook's deferred platform tab to the configured release router."
                          : "Processes one capped PIPEDOG revenue lane."}
                    </p>
                  </div>
                  <dl>
                    <div><dt>Gross lane chunk</dt><dd>{amount(job.amountPipedog)} PIPEDOG</dd></div>
                    <div><dt>Routed after bounty</dt><dd>{amount(job.routedPipedog)} PIPEDOG</dd></div>
                    <div><dt>Estimated bounty</dt><dd>{amount(job.bountyPipedog)} PIPEDOG</dd></div>
                    <div><dt>Native gas</dt><dd>{job.gasEstimate === null ? "Not proven" : `${job.gasEstimate.toString()} gas`}</dd></div>
                  </dl>
                  {job.reason && <p className="wallet-snapshot-note">{job.reason}</p>}
                  <div className="wallet-position-actions">
                    <button
                      className="button button-accent button-small"
                      type="button"
                      disabled={!job.eligible || mutationsLocked}
                      onClick={() => void submit(job.action)}
                    >
                      {activeAction === key ? "Reconciling..." : "Verify & submit"}
                    </button>
                  </div>
                </article>
              );
            })}
            {!verificationError && !loading && jobs.length === 0 && (
              <p className="wallet-snapshot-note">No job has current wallet-verified eligibility.</p>
            )}
          </div>

          {payload.recentActions.length > 0 && (
            <div className="keeper-history">
              <h2>Recent indexed activity</h2>
              <ul>
                {payload.recentActions.map((action) => (
                  <li key={`${action.transactionHash}:${action.kind}`}>
                    <a href={explorerTransactionUrl(action.transactionHash)} target="_blank" rel="noreferrer">
                      {action.kind === "sweep" ? "Pool sweep" : action.kind === "sequester" ? "Sequester route" : "Treasury route"}
                    </a>{" "}
                    processed {amount(action.processedPipedog)} PIPEDOG
                    {action.kind !== "sweep"
                      ? ` (${amount(action.routedPipedog)} routed)`
                      : ""}
                    {BigInt(action.bountyPipedog) > BigInt(0)
                      ? ` and paid ${amount(action.bountyPipedog)} PIPEDOG bounty`
                      : "; no bounty"}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}

      {crossSurfacePending && (
        <div className="wallet-snapshot-note" role="alert">
          Keeper calls are locked because another LayPipe wallet action is unresolved. {crossSurfacePending}
        </div>
      )}
      {recovery && (
        <div className="wallet-snapshot-note" role="alert">
          <p>
            Keeper calls are locked. {recoveryMessage(recovery)} Check this wallet&apos;s
            recent activity before resetting its local keeper lock.
          </p>
          <button className="button button-quiet button-small" type="button" onClick={() => void resetRecoveryLock()}>
            I checked wallet activity; reset this wallet&apos;s keeper lock
          </button>
        </div>
      )}
      {pendingAction && (
        <div className="wallet-snapshot-note" role="status">
          <p>
            {pendingAction.hash
              ? "Keeper action submitted. Do not retry until its canonical receipt is reconciled."
              : "The wallet may have submitted this keeper action without returning a hash. Check wallet activity before another action."}
          </p>
          {pendingAction.hash && (
            <>
              <a href={explorerTransactionUrl(pendingAction.hash)} target="_blank" rel="noreferrer">View transaction</a>{" "}
              <button className="button button-quiet button-small" type="button" onClick={() => void reconcilePending()}>
                Recheck canonical receipt
              </button>
            </>
          )}
          {!pendingAction.hash && (
            <button className="button button-quiet button-small" type="button" onClick={() => void clearHashlessIntent()}>
              I checked wallet activity; clear hashless intent
            </button>
          )}
        </div>
      )}
      {confirmed && (
        <p className="form-success" role="status">
          {confirmed.message}{" "}
          <a href={explorerTransactionUrl(confirmed.hash)} target="_blank" rel="noreferrer">View receipt</a>
        </p>
      )}
      <p className="wallet-snapshot-note">
        ETH pays gas. Sweeps and platform collection pay no bounty; only successful
        sequester and treasury routes may pay the exact event-reported PIPEDOG bounty.
        A displayed estimate is not a profit guarantee. Self-burn jobs remain disabled. {" "}
        <Link href="/docs#keepers">Keeper details</Link>
      </p>
    </section>
  );
}

function sameIntentCall(intent: PendingKeeperActionIntent, target: string, data: string) {
  return (
    intent.target.toLowerCase() === target.toLowerCase() &&
    intent.calldata.toLowerCase() === data.toLowerCase()
  );
}
