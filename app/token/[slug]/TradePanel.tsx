"use client";

import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";

import { useWallet } from "@/app/_components/WalletProvider";
import { readBrowserPublicLaunchDeployment } from "@/lib/web3/browser-deployment";
import {
  readPendingTrade,
  removePendingTrade,
  savePendingTrade,
  savePendingTradeHash,
  type PendingTradeIntent,
} from "@/lib/wallet/pending-trades";
import { ensureRobinhoodChain } from "@/lib/web3/launch-client";
import {
  encodeLaypipeTradeCall,
  createRobinhoodTradeConfirmationProvider,
  describeTradeError,
  isCanonicalTradeReverted,
  isTradeSubmissionIndeterminate,
  LaypipeTradeClient,
  resolveVerifiedTradePool,
  type TradePreflight,
  type TradeQuote,
  type TradeSide,
  type TradeTokenIdentity,
} from "@/lib/web3/trade-client";
import { explorerTransactionUrl } from "@/lib/web3/robinhood";
import type { Address, Hex } from "@/lib/web3/types";
import { formatUnits, parseUnits } from "@/lib/web3/units";
import styles from "./TradePanel.module.css";

type TradePhase =
  | "idle"
  | "preparing"
  | "approval-required"
  | "approval-pending"
  | "quote-ready"
  | "trade-pending"
  | "success"
  | "error"
  | "pending-unknown";

interface TradeResult {
  hash: Hex;
  inputSpent: bigint;
  outputReceived: bigint;
  allowanceCleared: boolean;
  side: TradeSide;
}

export interface TradePanelProps {
  enabled: boolean;
  symbol: string;
  token: TradeTokenIdentity | null;
}

function shortAddress(address: Address) {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function safeAmount(value: string) {
  const parsed = parseUnits(value, 18);
  if (parsed <= BigInt(0)) throw new Error("Enter a trade amount greater than zero.");
  return parsed;
}

function pendingPhase(phase: TradePhase) {
  return phase === "approval-pending" || phase === "trade-pending";
}

export function TradePanel({ enabled, symbol, token }: TradePanelProps) {
  const wallet = useWallet();
  const deploymentResult = useMemo(
    () => (enabled ? readBrowserPublicLaunchDeployment() : null),
    [enabled],
  );
  const confirmationProvider = useMemo(
    () => (enabled ? createRobinhoodTradeConfirmationProvider() : null),
    [enabled],
  );
  const [side, setSide] = useState<TradeSide>("buy");
  const [amount, setAmount] = useState("");
  const [slippageBps, setSlippageBps] = useState(100);
  const [phase, setPhase] = useState<TradePhase>("idle");
  const [preflight, setPreflight] = useState<TradePreflight | null>(null);
  const [quote, setQuote] = useState<TradeQuote | null>(null);
  const [pendingHash, setPendingHash] = useState<Hex | null>(null);
  const [restoredIntent, setRestoredIntent] =
    useState<PendingTradeIntent | null>(null);
  const [pendingStoreReady, setPendingStoreReady] = useState(false);
  const [result, setResult] = useState<TradeResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [contextWarning, setContextWarning] = useState<string | null>(null);
  const [clock, setClock] = useState(0);
  const phaseRef = useRef(phase);
  const inFlightRef = useRef(false);
  const reconciliationRef = useRef(0);
  const reconciliationControllerRef = useRef<AbortController | null>(null);
  const walletRevisionRef = useRef(wallet.revision);
  const account = wallet.account;

  const liveConfigured = Boolean(
    enabled && token && deploymentResult?.configured,
  );
  const inputSymbol = side === "buy" ? "PIPEDOG" : symbol;
  const outputSymbol = side === "buy" ? symbol : "PIPEDOG";
  const quoteSeconds = quote
    ? Math.max(0, Math.ceil((quote.expiresAtMs - clock) / 1_000))
    : 0;
  const controlsLocked =
    !pendingStoreReady ||
    pendingPhase(phase) ||
    phase === "preparing" ||
    phase === "pending-unknown";

  function approvalIntent(options: {
    amount: bigint;
    kind: "reset" | "approve-exact";
    tokenAddress: Address;
    calldata: Hex;
  }): PendingTradeIntent {
    if (!account || !token) {
      throw new Error("A connected wallet and live token are required.");
    }
    if (
      options.kind === "reset" ? options.amount !== BigInt(0) : options.amount <= BigInt(0)
    ) {
      throw new Error("Approval kind does not match its exact amount.");
    }
    return {
      chainId: 4663,
      wallet: account,
      tokenAddress: token.tokenAddress,
      poolId: token.poolId,
      action: "approval",
      target: options.tokenAddress,
      calldata: options.calldata,
      value: "0x0",
      approval: {
        side,
        token: options.tokenAddress,
        amount: options.amount.toString(),
        kind: options.kind,
      },
      hash: null,
      invokedAt: Date.now(),
    };
  }

  function tradeIntent(currentQuote: TradeQuote): PendingTradeIntent {
    if (!account || !token || !deploymentResult?.configured) {
      throw new Error("A connected wallet and live token are required.");
    }
    const calldata = encodeLaypipeTradeCall({
      side: currentQuote.side,
      pool: resolveVerifiedTradePool(deploymentResult.deployment, token),
      inputAmount: currentQuote.inputAmount,
      minimumOutput: currentQuote.minimumOutput,
      recipient: currentQuote.owner,
      deadlineBlock: currentQuote.deadlineBlock,
    });
    return {
      chainId: 4663,
      wallet: account,
      tokenAddress: token.tokenAddress,
      poolId: token.poolId,
      action: "trade",
      target: deploymentResult.deployment.contracts.swapRouter.address,
      calldata,
      value: "0x0",
      trade: {
        side: currentQuote.side,
        inputAmount: currentQuote.inputAmount.toString(),
        expectedOutput: currentQuote.expectedOutput.toString(),
        minimumOutput: currentQuote.minimumOutput.toString(),
        slippageBps: currentQuote.slippageBps,
        verifiedBlockNumber: currentQuote.verifiedBlockNumber.toString(),
        deadlineBlock: currentQuote.deadlineBlock.toString(),
        createdAtMs: currentQuote.createdAtMs,
        expiresAtMs: currentQuote.expiresAtMs,
      },
      hash: null,
      invokedAt: Date.now(),
    };
  }

  function persistSubmission(intent: PendingTradeIntent, hash?: Hex) {
    if (hash) {
      setRestoredIntent({ ...intent, hash });
      setPendingHash(hash);
      savePendingTradeHash(window.localStorage, intent, hash);
      return;
    }
    savePendingTrade(window.localStorage, intent);
    setRestoredIntent(intent);
  }

  function clearPersistentSubmission() {
    if (!account || !token) return;
    removePendingTrade(
      window.localStorage,
      account,
      token.tokenAddress,
      token.poolId,
    );
    setRestoredIntent(null);
  }

  const reconcileRestoredTrade = useEffectEvent(
    (intent: PendingTradeIntent) => {
      void reconcilePendingTrade(intent);
    },
  );

  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  useEffect(() => {
    if (!quote) return;
    const timer = window.setInterval(() => setClock(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [quote]);

  useEffect(() => {
    if (!liveConfigured) return;
    if (walletRevisionRef.current === wallet.revision) return;
    walletRevisionRef.current = wallet.revision;
    if (pendingPhase(phaseRef.current) || phaseRef.current === "pending-unknown") {
      reconciliationRef.current += 1;
      reconciliationControllerRef.current?.abort();
      setContextWarning(
        "Wallet account or chain changed while a transaction may be pending. Check its explorer link before taking another action.",
      );
      return;
    }
    setPreflight(null);
    setQuote(null);
    setResult(null);
    setError(null);
    setPhase("idle");
    setContextWarning("Wallet context changed. Prepare the trade again.");
  }, [liveConfigured, wallet.revision]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      if (!liveConfigured || !account || !token) {
        setPendingStoreReady(true);
        setRestoredIntent(null);
        setPendingHash(null);
        return;
      }
      try {
        const restored = readPendingTrade(
          window.localStorage,
          account,
          token.tokenAddress,
          token.poolId,
        );
        setPendingStoreReady(true);
        setRestoredIntent(restored);
        if (!restored) {
          setPendingHash(null);
          if (phaseRef.current === "pending-unknown") {
            setError(null);
            setPhase("idle");
          }
          return;
        }
        setPendingHash(restored.hash);
        setError(
          restored.hash
            ? "A prior wallet submission was restored. Reconcile its canonical receipt before retrying."
            : "A prior wallet submission may have broadcast without returning a hash. Check wallet activity before retrying.",
        );
        setPhase("pending-unknown");
        if (restored.hash) reconcileRestoredTrade(restored);
      } catch (caught) {
        setPendingStoreReady(false);
        setRestoredIntent(null);
        setPendingHash(null);
        setError(describeTradeError(caught));
        setPhase("pending-unknown");
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [account, liveConfigured, token]);

  function invalidateTrade(nextPhase: TradePhase = "idle") {
    setPreflight(null);
    setQuote(null);
    setPendingHash(null);
    setResult(null);
    setError(null);
    setContextWarning(null);
    setPhase(nextPhase);
  }

  function client() {
    if (!liveConfigured || !token || !deploymentResult?.configured) {
      throw new Error("Trading is disabled until the audited production manifest is complete.");
    }
    const provider = wallet.provider;
    if (!provider) {
      throw new Error("Install an EVM wallet to trade on Robinhood Chain.");
    }
    return {
      provider,
      tradeClient: new LaypipeTradeClient(
        provider,
        deploymentResult.deployment,
        token,
        confirmationProvider ? { confirmationProvider } : {},
      ),
    };
  }

  async function connectedAccount() {
    const provider = wallet.provider;
    if (!provider) throw new Error("Install an EVM wallet to continue.");
    await ensureRobinhoodChain(provider);
    const connected = wallet.account ?? (await wallet.connect());
    if (!connected) {
      throw new Error(wallet.error ?? "Connect a wallet to continue.");
    }
    return connected;
  }

  async function prepareCurrentTrade() {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setPhase("preparing");
    setPreflight(null);
    setQuote(null);
    setError(null);
    setContextWarning(null);
    setResult(null);
    setPendingHash(null);
    try {
      const inputAmount = safeAmount(amount);
      const { tradeClient } = client();
      const owner = await connectedAccount();
      const nextPreflight = await tradeClient.readPreflight(
        owner,
        side,
        inputAmount,
      );
      setPreflight(nextPreflight);
      if (nextPreflight.inputBalance < inputAmount) {
        throw new Error(`You do not have enough ${inputSymbol} for this trade.`);
      }
      if (nextPreflight.approvalPlan.steps.length > 0) {
        setQuote(null);
        setPhase("approval-required");
        return;
      }
      const nextQuote = await tradeClient.prepareQuote({
        owner,
        side,
        inputAmount,
        slippageBps,
      });
      setQuote(nextQuote);
      setClock(Date.now());
      setContextWarning(null);
      setPhase("quote-ready");
    } catch (caught) {
      setError(describeTradeError(caught));
      setPhase("error");
    } finally {
      inFlightRef.current = false;
    }
  }

  async function approveNextStep() {
    if (!preflight || !account || inFlightRef.current) return;
    inFlightRef.current = true;
    setPhase("approval-pending");
    setError(null);
    setContextWarning(null);
    let submitted: Hex | null = null;
    let intent: PendingTradeIntent | null = null;
    try {
      const { provider, tradeClient } = client();
      await ensureRobinhoodChain(provider);
      const pending = await tradeClient.sendNextApproval(
        account,
        side,
        preflight.inputAmount,
        {
          onSubmissionInvoked: (submission) => {
            const nextIntent = approvalIntent({
              amount: submission.amount,
              kind: submission.kind,
              tokenAddress: submission.token,
              calldata: submission.calldata,
            });
            if (submission.target.toLowerCase() !== submission.token.toLowerCase()) {
              throw new Error("Approval submission target changed unexpectedly.");
            }
            persistSubmission(nextIntent);
            intent = nextIntent;
          },
          onSubmitted: (hash) => {
            submitted = hash;
            if (!intent) throw new Error("Approval recovery intent is missing.");
            persistSubmission(intent, hash);
          },
        },
      );
      const confirmation = await tradeClient.confirmApproval(pending, account);
      if (!confirmation.allowanceMatchesIntent) {
        throw new Error(
          "The confirmed approval allowance does not match the exact intended amount.",
        );
      }
      setPendingHash(null);
      clearPersistentSubmission();

      // Approval state is never assumed from a receipt. Re-run the complete
      // manifest, token, account, balance, and allowance preflight.
      const nextPreflight = await tradeClient.readPreflight(
        account,
        side,
        preflight.inputAmount,
      );
      setPreflight(nextPreflight);
      if (nextPreflight.approvalPlan.steps.length > 0) {
        setPhase("approval-required");
        return;
      }
      const nextQuote = await tradeClient.prepareQuote({
        owner: account,
        side,
        inputAmount: preflight.inputAmount,
        slippageBps,
      });
      setQuote(nextQuote);
      setClock(Date.now());
      setContextWarning(null);
      setPhase("quote-ready");
    } catch (caught) {
      const message = describeTradeError(caught);
      const canonicalRevert = isCanonicalTradeReverted(caught);
      setError(message);
      if (
        isTradeSubmissionIndeterminate(caught) ||
        (submitted && !canonicalRevert)
      ) {
        setPhase("pending-unknown");
      } else {
        if (intent) clearPersistentSubmission();
        setPhase("error");
      }
    } finally {
      inFlightRef.current = false;
    }
  }

  async function clearStaleAllowance() {
    if (!account || inFlightRef.current) return;
    inFlightRef.current = true;
    setPhase("approval-pending");
    setError(null);
    let submitted: Hex | null = null;
    let intent: PendingTradeIntent | null = null;
    try {
      const { provider, tradeClient } = client();
      await ensureRobinhoodChain(provider);
      const pending = await tradeClient.clearAllowance(account, side, {
        onSubmissionInvoked: (submission) => {
          const nextIntent = approvalIntent({
            amount: submission.amount,
            kind: submission.kind,
            tokenAddress: submission.token,
            calldata: submission.calldata,
          });
          if (submission.target.toLowerCase() !== submission.token.toLowerCase()) {
            throw new Error("Allowance-clear target changed unexpectedly.");
          }
          persistSubmission(nextIntent);
          intent = nextIntent;
        },
        onSubmitted: (hash) => {
          submitted = hash;
          if (!intent) throw new Error("Allowance-clear recovery intent is missing.");
          persistSubmission(intent, hash);
        },
      });
      if (!pending) {
        clearPersistentSubmission();
        invalidateTrade();
        return;
      }
      const confirmation = await tradeClient.confirmApproval(pending, account);
      if (!confirmation.allowanceMatchesIntent || confirmation.allowance !== BigInt(0)) {
        throw new Error(
          "The allowance-clear transaction was confirmed, but the allowance is not zero.",
        );
      }
      invalidateTrade();
      clearPersistentSubmission();
    } catch (caught) {
      const message = describeTradeError(caught);
      const canonicalRevert = isCanonicalTradeReverted(caught);
      setError(message);
      if (
        isTradeSubmissionIndeterminate(caught) ||
        (submitted && !canonicalRevert)
      ) {
        setPhase("pending-unknown");
      } else {
        if (intent) clearPersistentSubmission();
        setPhase("error");
      }
    } finally {
      inFlightRef.current = false;
    }
  }

  async function submitTrade() {
    if (!quote || !account || quoteSeconds <= 0) {
      await prepareCurrentTrade();
      return;
    }
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setPhase("trade-pending");
    setError(null);
    setContextWarning(null);
    let submitted: Hex | null = null;
    let intent: PendingTradeIntent | null = null;
    try {
      const { provider, tradeClient } = client();
      await ensureRobinhoodChain(provider);
      // sendTrade performs a new audited deployment/token/account/balance and
      // exact-allowance preflight, then simulates the protected calldata.
      const pending = await tradeClient.sendTrade(quote, {
        onSubmissionInvoked: (submission) => {
          const nextIntent = tradeIntent(submission.quote);
          if (
            nextIntent.target.toLowerCase() !== submission.target.toLowerCase() ||
            nextIntent.calldata.toLowerCase() !== submission.calldata.toLowerCase()
          ) {
            throw new Error("Trade submission calldata changed unexpectedly.");
          }
          persistSubmission(nextIntent);
          intent = nextIntent;
        },
        onSubmitted: (hash) => {
          submitted = hash;
          if (!intent) throw new Error("Trade recovery intent is missing.");
          persistSubmission(intent, hash);
        },
      });
      const confirmed = await tradeClient.confirmTrade(pending, quote);
      setResult({
        hash: pending.hash,
        inputSpent: confirmed.inputSpent,
        outputReceived: confirmed.outputReceived,
        allowanceCleared: confirmed.allowanceCleared,
        side,
      });
      setPendingHash(null);
      clearPersistentSubmission();
      setQuote(null);
      setPreflight(null);
      setPhase("success");
    } catch (caught) {
      const message = describeTradeError(caught);
      const canonicalRevert = isCanonicalTradeReverted(caught);
      setError(message);
      if (
        isTradeSubmissionIndeterminate(caught) ||
        (submitted && !canonicalRevert)
      ) {
        setPhase("pending-unknown");
      } else {
        if (intent) clearPersistentSubmission();
        setPhase("error");
      }
    } finally {
      inFlightRef.current = false;
    }
  }

  async function reconcilePendingTrade(
    intentOverride: PendingTradeIntent | null = restoredIntent,
  ) {
    const pending = intentOverride;
    if (
      !pending?.hash ||
      !account ||
      !token ||
      !deploymentResult?.configured ||
      inFlightRef.current
    ) {
      return;
    }
    inFlightRef.current = true;
    const operation = ++reconciliationRef.current;
    const controller = new AbortController();
    reconciliationControllerRef.current = controller;
    setError(null);
    try {
      const { tradeClient } = client();
      if (pending.action === "approval") {
        const amount = BigInt(pending.approval.amount);
        const expectedToken = pending.approval.side === "buy"
          ? deploymentResult.deployment.contracts.pipedog.address
          : token.tokenAddress;
        const expectedData = tradeClient.approvalCalldata(amount);
        if (
          pending.approval.token.toLowerCase() !==
            expectedToken.toLowerCase() ||
          pending.target.toLowerCase() !== expectedToken.toLowerCase() ||
          pending.calldata.toLowerCase() !== expectedData.toLowerCase() ||
          (pending.approval.kind === "reset") !== (amount === BigInt(0))
        ) {
          throw new Error(
            "Saved approval intent does not match this audited pool and cannot be reconciled automatically.",
          );
        }
        const confirmation = await tradeClient.confirmApproval(
          {
            hash: pending.hash,
            token: expectedToken,
            amount,
            kind: pending.approval.kind,
            inputSymbol:
              pending.approval.side === "buy" ? "PIPEDOG" : symbol,
          },
          account,
          { signal: controller.signal },
        );
        if (!confirmation.allowanceMatchesIntent) {
          throw new Error(
            "The canonical approval receipt does not produce its saved exact allowance.",
          );
        }
        if (operation !== reconciliationRef.current) return;
        clearPersistentSubmission();
        setPendingHash(null);
        setPreflight(null);
        setQuote(null);
        setContextWarning(
          "Approval canonically confirmed. Prepare a fresh quote before trading.",
        );
        setPhase("idle");
        return;
      }

      const restoredQuote: TradeQuote = {
        side: pending.trade.side,
        owner: account,
        tokenAddress: token.tokenAddress,
        poolId: token.poolId,
        inputAmount: BigInt(pending.trade.inputAmount),
        expectedOutput: BigInt(pending.trade.expectedOutput),
        minimumOutput: BigInt(pending.trade.minimumOutput),
        slippageBps: pending.trade.slippageBps,
        verifiedBlockNumber: BigInt(pending.trade.verifiedBlockNumber),
        deadlineBlock: BigInt(pending.trade.deadlineBlock),
        createdAtMs: pending.trade.createdAtMs,
        expiresAtMs: pending.trade.expiresAtMs,
      };
      const expectedData = encodeLaypipeTradeCall({
        side: restoredQuote.side,
        pool: resolveVerifiedTradePool(deploymentResult.deployment, token),
        inputAmount: restoredQuote.inputAmount,
        minimumOutput: restoredQuote.minimumOutput,
        recipient: account,
        deadlineBlock: restoredQuote.deadlineBlock,
      });
      if (
        pending.target.toLowerCase() !==
          deploymentResult.deployment.contracts.swapRouter.address.toLowerCase() ||
        pending.calldata.toLowerCase() !== expectedData.toLowerCase()
      ) {
        throw new Error(
          "Saved trade intent does not match this audited router call and cannot be reconciled automatically.",
        );
      }
      const confirmed = await tradeClient.confirmTrade(
        {
          hash: pending.hash,
          simulatedOutput: restoredQuote.expectedOutput,
        },
        restoredQuote,
        { signal: controller.signal },
      );
      if (operation !== reconciliationRef.current) return;
      setResult({
        hash: pending.hash,
        inputSpent: confirmed.inputSpent,
        outputReceived: confirmed.outputReceived,
        allowanceCleared: confirmed.allowanceCleared,
        side: restoredQuote.side,
      });
      clearPersistentSubmission();
      setPendingHash(null);
      setQuote(null);
      setPreflight(null);
      setPhase("success");
    } catch (caught) {
      if (operation !== reconciliationRef.current) return;
      if (isCanonicalTradeReverted(caught)) {
        clearPersistentSubmission();
        setPendingHash(null);
        setQuote(null);
        setPreflight(null);
        setContextWarning(
          "The saved transaction was canonically confirmed as reverted. Prepare again before retrying.",
        );
        setPhase("idle");
        return;
      }
      setError(describeTradeError(caught));
      setPhase("pending-unknown");
    } finally {
      if (reconciliationControllerRef.current === controller) {
        reconciliationControllerRef.current = null;
      }
      inFlightRef.current = false;
    }
  }

  function clearReconciledTradeLock() {
    if (restoredIntent?.hash || !pendingStoreReady) return;
    reconciliationRef.current += 1;
    clearPersistentSubmission();
    invalidateTrade();
  }

  function chooseSide(nextSide: TradeSide) {
    if (controlsLocked || nextSide === side) return;
    setSide(nextSide);
    setAmount("");
    invalidateTrade();
  }

  if (!enabled) {
    return (
      <aside className={`trade-panel ${styles.panel}`} data-trading-state="fixture-disabled">
        <div className="trade-tabs">
          <button type="button" aria-pressed="true" disabled>Buy</button>
          <button type="button" aria-pressed="false" disabled>Sell</button>
        </div>
        <p className={styles.disabledTitle}>Fixture pool</p>
        <button className="button button-disabled" type="button" disabled>
          Pool not deployed
        </button>
        <p>Fixture data never activates approval, trade, or router mutations.</p>
      </aside>
    );
  }

  if (!liveConfigured) {
    return (
      <aside className={`trade-panel ${styles.panel}`} data-trading-state="manifest-disabled">
        <div className="trade-tabs">
          <button type="button" aria-pressed="true" disabled>Buy</button>
          <button type="button" aria-pressed="false" disabled>Sell</button>
        </div>
        <p className={styles.disabledTitle}>Trading locked</p>
        <button className="button button-disabled" type="button" disabled>
          Audited deployment required
        </button>
        <p>
          {deploymentResult?.configured === false
            ? deploymentResult.reason
            : "This token is missing its canonical indexed pool identity."}
        </p>
      </aside>
    );
  }

  const approvalStep = preflight?.approvalPlan.steps[0] ?? null;
  const actionLabel =
    phase === "preparing"
      ? "Checking pool..."
      : phase === "approval-pending"
        ? "Waiting for approval..."
        : phase === "trade-pending"
          ? `${side === "buy" ? "Buying" : "Selling"}...`
          : phase === "pending-unknown"
            ? "Check pending transaction"
            : quote && quoteSeconds > 0
              ? `${side === "buy" ? "Buy" : "Sell"} ${symbol}`
              : quote && quoteSeconds <= 0
                ? "Refresh quote"
                : account
                  ? "Prepare trade"
                  : "Connect & prepare";

  return (
    <aside className={`trade-panel ${styles.panel}`} data-trading-state={phase}>
      <div className={`trade-tabs ${styles.tabs}`}>
        <button
          type="button"
          aria-pressed={side === "buy"}
          disabled={controlsLocked}
          onClick={() => chooseSide("buy")}
        >
          Buy
        </button>
        <button
          type="button"
          aria-pressed={side === "sell"}
          disabled={controlsLocked}
          onClick={() => chooseSide("sell")}
        >
          Sell
        </button>
      </div>

      <div className={styles.walletRow}>
        <span>{account ? shortAddress(account) : "Wallet not connected"}</span>
        <span>ETH pays gas only</span>
      </div>

      <label>
        <span>You pay</span>
        <div>
          <input
            value={amount}
            inputMode="decimal"
            autoComplete="off"
            placeholder="0.00"
            disabled={controlsLocked}
            aria-label={`${inputSymbol} trade amount`}
            onChange={(event) => {
              setAmount(event.target.value);
              invalidateTrade();
            }}
          />
          <strong>{inputSymbol}</strong>
        </div>
      </label>

      <label className={styles.slippage}>
        <span>Max slippage</span>
        <select
          value={slippageBps}
          disabled={controlsLocked}
          onChange={(event) => {
            setSlippageBps(Number(event.target.value));
            invalidateTrade();
          }}
        >
          <option value={50}>0.5%</option>
          <option value={100}>1%</option>
          <option value={200}>2%</option>
          <option value={500}>5%</option>
        </select>
      </label>

      <div className="trade-quote">
        <span>You receive</span>
        <strong>
          {quote
            ? `~ ${formatUnits(quote.expectedOutput, 18, 6)} ${outputSymbol}`
            : `- ${outputSymbol}`}
        </strong>
      </div>

      {quote ? (
        <dl className={styles.quoteDetails}>
          <div>
            <dt>Minimum received</dt>
            <dd>{formatUnits(quote.minimumOutput, 18, 6)} {outputSymbol}</dd>
          </div>
          <div>
            <dt>Submit window</dt>
            <dd>{quoteSeconds > 0 ? `${quoteSeconds}s left` : "Expired"}</dd>
          </div>
          <div>
            <dt>Router block cap</dt>
            <dd>L2 block {quote.deadlineBlock.toString()}</dd>
          </div>
        </dl>
      ) : null}

      {preflight ? (
        <p className={styles.balance}>
          Balance: {formatUnits(preflight.inputBalance, 18, 6)} {inputSymbol}
        </p>
      ) : null}

      {approvalStep ? (
        <button
          className="button button-accent"
          type="button"
          disabled={controlsLocked}
          onClick={approveNextStep}
        >
          {approvalStep.label}
        </button>
      ) : (
        <button
          className="button button-accent"
          type="button"
          disabled={controlsLocked}
          onClick={quote && quoteSeconds > 0 ? submitTrade : prepareCurrentTrade}
        >
          {actionLabel}
        </button>
      )}

      {((preflight?.allowance ?? BigInt(0)) > BigInt(0) ||
        result?.allowanceCleared === false) &&
      !controlsLocked ? (
        <button
          className={`button button-quiet ${styles.clearButton}`}
          type="button"
          disabled={controlsLocked}
          onClick={clearStaleAllowance}
        >
          Clear {inputSymbol} allowance
        </button>
      ) : null}

      {pendingHash ? (
        <p className={styles.lifecycle}>
          Transaction submitted. Do not retry while it is pending. {" "}
          <a href={explorerTransactionUrl(pendingHash)} target="_blank" rel="noreferrer">
            View transaction
          </a>
        </p>
      ) : null}

      {phase === "pending-unknown" && !pendingHash ? (
        <p className={styles.lifecycle}>
          The wallet did not return a trustworthy transaction hash. Check wallet
          Activity before doing anything else; this intent may already be on-chain,
          so retrying is blocked.
        </p>
      ) : null}

      {phase === "pending-unknown" ? (
        restoredIntent?.hash ? (
          <button
            className={`button button-quiet ${styles.clearButton}`}
            type="button"
            onClick={() => void reconcilePendingTrade()}
          >
            Recheck canonical receipt
          </button>
        ) : pendingStoreReady && restoredIntent ? (
          <button
            className={`button button-quiet ${styles.clearButton}`}
            type="button"
            onClick={clearReconciledTradeLock}
          >
            I checked wallet activity; clear lock
          </button>
        ) : null
      ) : null}

      {result ? (
        <div className={styles.success}>
          <strong>Trade confirmed</strong>
          <span>
            {formatUnits(result.inputSpent, 18, 6)} {result.side === "buy" ? "PIPEDOG" : symbol}
            {" -> "}
            {formatUnits(result.outputReceived, 18, 6)} {result.side === "buy" ? symbol : "PIPEDOG"}
          </span>
          <span>
            {result.allowanceCleared
              ? "Single-use allowance consumed."
              : "Allowance remains; clear it before leaving."}
          </span>
          <a href={explorerTransactionUrl(result.hash)} target="_blank" rel="noreferrer">
            View receipt
          </a>
        </div>
      ) : null}

      <div className={styles.message} aria-live="polite">
        {contextWarning ? <p>{contextWarning}</p> : null}
        {error ? <p className={styles.error}>{error}</p> : null}
      </div>

      <p>
        Quotes come from a fresh router simulation after an exact, single-use
        input-token approval. Indexed prices are display-only; native ETH is
        never the launch-pool quote asset.
      </p>
    </aside>
  );
}
