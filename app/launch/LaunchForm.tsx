"use client";

import {
  type ChangeEvent,
  type FormEvent,
  useEffect,
  useMemo,
  useReducer,
  useState,
} from "react";
import {
  artworkContentHash,
  validateArtworkFile,
  type ValidatedArtwork,
} from "@/lib/ipfs/artwork";
import {
  normalizeMetadataDraft,
  type LaunchFeeMode,
  type LaunchMetadataDraft,
} from "@/lib/ipfs/metadata";
import {
  pinLaunchAssets,
  type PinnedLaunchAssets,
} from "@/lib/ipfs/pin-client";
import type { FactoryTokenParams } from "@/lib/web3/abi";
import {
  assertLaunchPreflight,
  assertFirstBuyAmounts,
  connectInjectedWallet,
  describeWalletError,
  ensureRobinhoodChain,
  getInjectedProvider,
  LaypipeLaunchClient,
  subscribeToWalletContext,
  type ExactApprovalPlan,
  type FactoryPreflight,
  type LaunchCallInput,
} from "@/lib/web3/launch-client";
import {
  INITIAL_LAUNCH_STATE,
  reduceLaunchMachine,
} from "@/lib/web3/launch-machine";
import {
  explorerTokenUrl,
  explorerTransactionUrl,
  readPublicLaunchDeployment,
} from "@/lib/web3/robinhood";
import type { Address, Eip1193Provider, Hex } from "@/lib/web3/types";
import { formatUnits, parseUnits } from "@/lib/web3/units";
import styles from "./launch.module.css";

const PIPEDOG_DECIMALS = 18;
const LAUNCHED_TOKEN_DECIMALS = 18;
interface PreparedLaunch {
  assets: PinnedLaunchAssets;
  params: FactoryTokenParams;
  input: LaunchCallInput;
  preflight: FactoryPreflight;
  approvalPlan: ExactApprovalPlan;
  predictedToken: Address;
}

interface CompletedLaunch {
  token: Address;
  poolId: Hex;
  transactionHash: Hex;
  allowanceCleared: boolean | null;
}

interface PinnedCache {
  fingerprint: string;
  assets: PinnedLaunchAssets;
}

function shortAddress(address: Address) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

async function launchFingerprint(
  metadata: LaunchMetadataDraft,
  artwork: ValidatedArtwork,
) {
  return JSON.stringify({
    metadata,
    sha256: await artworkContentHash(artwork.file),
  });
}

function formatWholeTokens(value: bigint) {
  return formatUnits(value, 18, 0).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export default function LaunchForm() {
  const deploymentResult = useMemo(
    () =>
      readPublicLaunchDeployment({
        NEXT_PUBLIC_UNISWAP_V4_POOL_MANAGER_ADDRESS:
          process.env.NEXT_PUBLIC_UNISWAP_V4_POOL_MANAGER_ADDRESS,
        NEXT_PUBLIC_LAYPIPE_DEPLOYMENT_BLOCK:
          process.env.NEXT_PUBLIC_LAYPIPE_DEPLOYMENT_BLOCK,
        NEXT_PUBLIC_LAYPIPE_FACTORY_ADDRESS:
          process.env.NEXT_PUBLIC_LAYPIPE_FACTORY_ADDRESS,
        NEXT_PUBLIC_LAYPIPE_FACTORY_RUNTIME_CODEHASH:
          process.env.NEXT_PUBLIC_LAYPIPE_FACTORY_RUNTIME_CODEHASH,
        NEXT_PUBLIC_LAYPIPE_FACTORY_IMPLEMENTATION_ADDRESS:
          process.env.NEXT_PUBLIC_LAYPIPE_FACTORY_IMPLEMENTATION_ADDRESS,
        NEXT_PUBLIC_LAYPIPE_FACTORY_IMPLEMENTATION_RUNTIME_CODEHASH:
          process.env.NEXT_PUBLIC_LAYPIPE_FACTORY_IMPLEMENTATION_RUNTIME_CODEHASH,
        NEXT_PUBLIC_LAYPIPE_TOKEN_IMPLEMENTATION_ADDRESS:
          process.env.NEXT_PUBLIC_LAYPIPE_TOKEN_IMPLEMENTATION_ADDRESS,
        NEXT_PUBLIC_LAYPIPE_TOKEN_IMPLEMENTATION_RUNTIME_CODEHASH:
          process.env.NEXT_PUBLIC_LAYPIPE_TOKEN_IMPLEMENTATION_RUNTIME_CODEHASH,
        NEXT_PUBLIC_LAYPIPE_HOOK_ADDRESS:
          process.env.NEXT_PUBLIC_LAYPIPE_HOOK_ADDRESS,
        NEXT_PUBLIC_LAYPIPE_HOOK_RUNTIME_CODEHASH:
          process.env.NEXT_PUBLIC_LAYPIPE_HOOK_RUNTIME_CODEHASH,
        NEXT_PUBLIC_LAYPIPE_SWAP_ROUTER_ADDRESS:
          process.env.NEXT_PUBLIC_LAYPIPE_SWAP_ROUTER_ADDRESS,
        NEXT_PUBLIC_LAYPIPE_SWAP_ROUTER_RUNTIME_CODEHASH:
          process.env.NEXT_PUBLIC_LAYPIPE_SWAP_ROUTER_RUNTIME_CODEHASH,
        NEXT_PUBLIC_LAYPIPE_SELF_BURNER_ADDRESS:
          process.env.NEXT_PUBLIC_LAYPIPE_SELF_BURNER_ADDRESS,
        NEXT_PUBLIC_LAYPIPE_SELF_BURNER_RUNTIME_CODEHASH:
          process.env.NEXT_PUBLIC_LAYPIPE_SELF_BURNER_RUNTIME_CODEHASH,
        NEXT_PUBLIC_LAYPIPE_REVENUE_ROUTER_ADDRESS:
          process.env.NEXT_PUBLIC_LAYPIPE_REVENUE_ROUTER_ADDRESS,
        NEXT_PUBLIC_LAYPIPE_REVENUE_ROUTER_RUNTIME_CODEHASH:
          process.env.NEXT_PUBLIC_LAYPIPE_REVENUE_ROUTER_RUNTIME_CODEHASH,
        NEXT_PUBLIC_LAYPIPE_FINAL_OWNER_ADDRESS:
          process.env.NEXT_PUBLIC_LAYPIPE_FINAL_OWNER_ADDRESS,
        NEXT_PUBLIC_LAYPIPE_TREASURY_ADDRESS:
          process.env.NEXT_PUBLIC_LAYPIPE_TREASURY_ADDRESS,
        NEXT_PUBLIC_LAYPIPE_OPERATIONS_ADDRESS:
          process.env.NEXT_PUBLIC_LAYPIPE_OPERATIONS_ADDRESS,
        NEXT_PUBLIC_LAYPIPE_CREATOR_CONFIG_ID:
          process.env.NEXT_PUBLIC_LAYPIPE_CREATOR_CONFIG_ID,
        NEXT_PUBLIC_LAYPIPE_SELF_BURN_CONFIG_ID:
          process.env.NEXT_PUBLIC_LAYPIPE_SELF_BURN_CONFIG_ID,
        NEXT_PUBLIC_LAYPIPE_LAUNCH_FEE_WEI:
          process.env.NEXT_PUBLIC_LAYPIPE_LAUNCH_FEE_WEI,
        NEXT_PUBLIC_LAYPIPE_LAUNCH_SUPPLY_WEI:
          process.env.NEXT_PUBLIC_LAYPIPE_LAUNCH_SUPPLY_WEI,
        NEXT_PUBLIC_LAYPIPE_TICK_SPACING:
          process.env.NEXT_PUBLIC_LAYPIPE_TICK_SPACING,
        NEXT_PUBLIC_LAYPIPE_START_TICK:
          process.env.NEXT_PUBLIC_LAYPIPE_START_TICK,
        NEXT_PUBLIC_LAYPIPE_SELF_BURN_MAX_PER_CALL_WEI:
          process.env.NEXT_PUBLIC_LAYPIPE_SELF_BURN_MAX_PER_CALL_WEI,
        NEXT_PUBLIC_LAYPIPE_SELF_BURN_BOUNTY_BPS:
          process.env.NEXT_PUBLIC_LAYPIPE_SELF_BURN_BOUNTY_BPS,
        NEXT_PUBLIC_LAYPIPE_REVENUE_MAX_SEQUESTER_PER_CALL_WEI:
          process.env.NEXT_PUBLIC_LAYPIPE_REVENUE_MAX_SEQUESTER_PER_CALL_WEI,
        NEXT_PUBLIC_LAYPIPE_REVENUE_MAX_TREASURY_ROUTE_PER_CALL_WEI:
          process.env.NEXT_PUBLIC_LAYPIPE_REVENUE_MAX_TREASURY_ROUTE_PER_CALL_WEI,
        NEXT_PUBLIC_LAYPIPE_REVENUE_BOUNTY_BPS:
          process.env.NEXT_PUBLIC_LAYPIPE_REVENUE_BOUNTY_BPS,
        NEXT_PUBLIC_LAYPIPE_SOURCE_COMMIT:
          process.env.NEXT_PUBLIC_LAYPIPE_SOURCE_COMMIT,
        NEXT_PUBLIC_LAYPIPE_COMPILER_VERSION:
          process.env.NEXT_PUBLIC_LAYPIPE_COMPILER_VERSION,
        NEXT_PUBLIC_LAYPIPE_ABI_BUNDLE_SHA256:
          process.env.NEXT_PUBLIC_LAYPIPE_ABI_BUNDLE_SHA256,
        NEXT_PUBLIC_LAYPIPE_ARTIFACT_BUNDLE_SHA256:
          process.env.NEXT_PUBLIC_LAYPIPE_ARTIFACT_BUNDLE_SHA256,
      }),
    [],
  );
  const [machine, dispatch] = useReducer(
    reduceLaunchMachine,
    INITIAL_LAUNCH_STATE,
  );
  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [description, setDescription] = useState("");
  const [mode, setMode] = useState<LaunchFeeMode>("self-burn");
  const [firstBuy, setFirstBuy] = useState("0");
  const [firstBuyMinOut, setFirstBuyMinOut] = useState("");
  const [website, setWebsite] = useState("");
  const [twitter, setTwitter] = useState("");
  const [telegram, setTelegram] = useState("");
  const [discord, setDiscord] = useState("");
  const [artwork, setArtwork] = useState<ValidatedArtwork | null>(null);
  const [artworkError, setArtworkError] = useState("");
  const [provider, setProvider] = useState<Eip1193Provider | null>(null);
  const [account, setAccount] = useState<Address | null>(null);
  const [prepared, setPrepared] = useState<PreparedLaunch | null>(null);
  const [pinnedCache, setPinnedCache] = useState<PinnedCache | null>(null);
  const [pendingHash, setPendingHash] = useState<Hex | null>(null);
  const [completed, setCompleted] = useState<CompletedLaunch | null>(null);
  const [postLaunchWarning, setPostLaunchWarning] = useState("");
  const [revoking, setRevoking] = useState(false);
  const [walletNotice, setWalletNotice] = useState("");

  const locked = [
    "preparing",
    "approval-required",
    "approval-pending",
    "ready-to-launch",
    "launch-pending",
    "succeeded",
  ].includes(machine.phase);
  const tokenLabel = `${name || "Your coin"} ${symbol ? `$${symbol}` : ""}`;
  const firstBuyLooksZero = /^0*(?:\.0*)?$/.test(firstBuy.trim());

  useEffect(() => {
    if (!provider) return;
    const invalidateWalletState = () => {
      if (
        pendingHash ||
        machine.phase === "approval-pending" ||
        machine.phase === "launch-pending"
      ) {
        setPostLaunchWarning(
          "Wallet account or network changed while a transaction is pending. Keep the receipt hash and verify it in the explorer before any retry.",
        );
        return;
      }
      setProvider(null);
      setAccount(null);
      setPrepared(null);
      setPendingHash(null);
      setCompleted(null);
      setPostLaunchWarning("");
      setWalletNotice("");
      dispatch({ type: "REVIEW" });
    };
    return subscribeToWalletContext(provider, invalidateWalletState);
  }, [machine.phase, pendingHash, provider]);

  function edit<T>(setter: (value: T) => void, value: T) {
    if (locked) return;
    setter(value);
    setPrepared(null);
    setCompleted(null);
    setPendingHash(null);
    dispatch({ type: "EDIT" });
  }

  async function chooseArtwork(event: ChangeEvent<HTMLInputElement>) {
    if (locked) return;
    const file = event.target.files?.[0];
    setArtwork(null);
    setArtworkError("");
    setPrepared(null);
    setPinnedCache(null);
    dispatch({ type: "EDIT" });
    if (!file) return;

    try {
      setArtwork(await validateArtworkFile(file));
    } catch (error) {
      setArtworkError(
        error instanceof Error ? error.message : "Artwork could not be validated.",
      );
      event.target.value = "";
    }
  }

  function currentMetadata() {
    return normalizeMetadataDraft({
      name,
      symbol,
      description,
      feeMode: mode,
      website,
      twitter,
      telegram,
      discord,
    });
  }

  function changeFirstBuy(value: string) {
    edit(setFirstBuy, value);
    if (/^0*(?:\.0*)?$/.test(value.trim())) setFirstBuyMinOut("");
  }

  function currentAmounts() {
    const firstBuyIn = parseUnits(firstBuy || "0", PIPEDOG_DECIMALS);
    const minimumOut = firstBuyMinOut
      ? parseUnits(firstBuyMinOut, LAUNCHED_TOKEN_DECIMALS)
      : BigInt(0);
    assertFirstBuyAmounts(firstBuyIn, minimumOut);
    if (firstBuyIn !== BigInt(0)) {
      throw new Error(
        "Optional first buys stay disabled until LayPipe has a trusted quote flow.",
      );
    }
    return { firstBuyIn, firstBuyMinOut: minimumOut };
  }

  function review(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      currentMetadata();
      currentAmounts();
      if (!artwork) throw new Error("Choose and validate square coin artwork.");
      dispatch({ type: "REVIEW" });
    } catch (error) {
      dispatch({
        type: "FAIL",
        message: error instanceof Error ? error.message : "Review failed.",
        recoverTo: "draft",
      });
    }
  }

  async function connectWallet() {
    dispatch({ type: "CONNECT" });
    try {
      const injected = getInjectedProvider();
      if (!injected) {
        throw new Error("No EVM browser wallet was detected.");
      }
      const connected = await connectInjectedWallet(injected);
      await ensureRobinhoodChain(injected);
      setProvider(injected);
      setAccount(connected);
      dispatch({ type: "CONNECTED" });
    } catch (error) {
      dispatch({
        type: "FAIL",
        message: describeWalletError(error),
        recoverTo: "reviewed",
      });
    }
  }

  async function prepareLaunch() {
    if (!provider || !account || !artwork || !deploymentResult.configured) {
      dispatch({
        type: "FAIL",
        message: deploymentResult.configured
          ? "Connect a wallet and validate the artwork first."
          : deploymentResult.reason,
        recoverTo: account ? "wallet-ready" : "reviewed",
      });
      return;
    }

    dispatch({ type: "PREPARE" });
    try {
      await ensureRobinhoodChain(provider);
      const metadata = currentMetadata();
      const amounts = currentAmounts();
      const configId =
        mode === "self-burn"
          ? deploymentResult.deployment.selfBurnConfigId
          : deploymentResult.deployment.creatorConfigId;
      const client = new LaypipeLaunchClient(
        provider,
        deploymentResult.deployment,
      );

      const firstPreflight = await client.readPreflight(account, configId);
      assertLaunchPreflight({
        preflight: firstPreflight,
        expectedSelfBurn: mode === "self-burn",
        firstBuyIn: amounts.firstBuyIn,
      });

      const fingerprint = await launchFingerprint(metadata, artwork);
      const assets =
        pinnedCache?.fingerprint === fingerprint
          ? pinnedCache.assets
          : await pinLaunchAssets({
              file: artwork.file,
              metadata,
              wallet: account,
              provider,
              browserOrigin: window.location.origin,
            });
      if (pinnedCache?.fingerprint !== fingerprint) {
        setPinnedCache({ fingerprint, assets });
      }

      const params: FactoryTokenParams = {
        name: metadata.name,
        symbol: metadata.symbol,
        logo: assets.image.uri,
        description: metadata.description,
        metadataURI: assets.metadata.uri,
        socials: {
          telegram: metadata.telegram ?? "",
          twitter: metadata.twitter ?? "",
          discord: metadata.discord ?? "",
          website: metadata.website ?? "",
          extra: metadata.extra ?? "",
        },
        creator: account,
      };
      const mined = await client.mineVanitySalt({
        params,
        configId,
        sender: account,
      });
      const freshPreflight = await client.readPreflight(account, configId);
      const safety = assertLaunchPreflight({
        preflight: freshPreflight,
        expectedSelfBurn: mode === "self-burn",
        firstBuyIn: amounts.firstBuyIn,
      });
      const input: LaunchCallInput = {
        params,
        configId,
        ...amounts,
        salt: mined.salt,
      };
      setPrepared({
        assets,
        params,
        input,
        preflight: freshPreflight,
        approvalPlan: safety.approvalPlan,
        predictedToken: mined.token,
      });
      dispatch({
        type: "PREPARED",
        needsApproval: safety.approvalPlan.steps.length > 0,
      });
    } catch (error) {
      dispatch({
        type: "FAIL",
        message: describeWalletError(error),
        recoverTo: "wallet-ready",
      });
    }
  }

  async function submitNextApproval() {
    if (
      !provider ||
      !account ||
      !prepared ||
      !deploymentResult.configured ||
      prepared.approvalPlan.steps.length === 0
    ) {
      return;
    }

    const nextStep = prepared.approvalPlan.steps[0];
    dispatch({ type: "APPROVAL_SUBMITTED" });
    setPendingHash(null);
    try {
      await ensureRobinhoodChain(provider);
      const client = new LaypipeLaunchClient(
        provider,
        deploymentResult.deployment,
      );
      const hash = await client.sendApproval(account, nextStep.amount);
      setPendingHash(hash);
      await client.confirmApproval(hash, account);
      setPendingHash(null);
      const preflight = await client.readPreflight(
        account,
        prepared.input.configId,
      );
      const safety = assertLaunchPreflight({
        preflight,
        expectedSelfBurn: mode === "self-burn",
        firstBuyIn: prepared.input.firstBuyIn,
      });
      setPrepared({
        ...prepared,
        preflight,
        approvalPlan: safety.approvalPlan,
      });
      setPendingHash(null);
      dispatch({
        type: "APPROVAL_CONFIRMED",
        needsAnotherApproval: safety.approvalPlan.steps.length > 0,
      });
    } catch (error) {
      dispatch({
        type: "FAIL",
        message: describeWalletError(error),
        recoverTo: "approval-required",
      });
    }
  }

  async function submitLaunch() {
    if (!provider || !account || !prepared || !deploymentResult.configured) {
      return;
    }

    setPendingHash(null);
    setPostLaunchWarning("");
    try {
      await ensureRobinhoodChain(provider);
      const client = new LaypipeLaunchClient(
        provider,
        deploymentResult.deployment,
      );
      const preflight = await client.readPreflight(
        account,
        prepared.input.configId,
      );
      const safety = assertLaunchPreflight({
        preflight,
        expectedSelfBurn: mode === "self-burn",
        firstBuyIn: prepared.input.firstBuyIn,
      });
      if (safety.approvalPlan.steps.length > 0) {
        setPrepared({ ...prepared, preflight, approvalPlan: safety.approvalPlan });
        dispatch({ type: "PREPARED", needsApproval: true });
        return;
      }

      dispatch({ type: "LAUNCH_SUBMITTED" });
      const hash = await client.sendLaunch(account, prepared.input);
      setPendingHash(hash);
      const confirmed = await client.confirmLaunch(hash, {
        creator: account,
        predictedToken: prepared.predictedToken,
      });
      let allowanceCleared: boolean | null = null;
      try {
        const after = await client.readPreflight(account, prepared.input.configId);
        allowanceCleared = after.allowance === BigInt(0);
        if (!allowanceCleared) {
          setPostLaunchWarning(
            "Launch succeeded, but the remaining allowance could not be verified as zero. Revoke it before another action.",
          );
        }
      } catch {
        setPostLaunchWarning(
          "Launch succeeded, but the post-launch zero-allowance check could not be completed.",
        );
      }
      setCompleted({
        token: confirmed.token,
        poolId: confirmed.poolId,
        transactionHash: hash,
        allowanceCleared,
      });
      setPendingHash(null);
      dispatch({ type: "LAUNCH_CONFIRMED" });
    } catch (error) {
      dispatch({
        type: "FAIL",
        message: describeWalletError(error),
        recoverTo: "ready-to-launch",
      });
    }
  }

  async function revokeFactoryAllowance() {
    if (
      pendingHash ||
      !provider ||
      !account ||
      !deploymentResult.configured
    ) {
      return;
    }

    setRevoking(true);
    try {
      await ensureRobinhoodChain(provider);
      const client = new LaypipeLaunchClient(
        provider,
        deploymentResult.deployment,
      );
      const before = await client.readCanonicalPipedogAllowance(account);
      if (before !== BigInt(0)) {
        const hash = await client.sendApproval(account, BigInt(0));
        setPendingHash(hash);
        await client.confirmApproval(hash, account);
        setPendingHash(null);
      }
      const after = await client.readCanonicalPipedogAllowance(account);
      if (after !== BigInt(0)) {
        throw new Error("The factory allowance is still non-zero after revocation.");
      }
      setPrepared(null);
      setPendingHash(null);
      setWalletNotice("Factory allowance confirmed at zero.");
      dispatch({ type: "CONNECTED" });
    } catch (error) {
      dispatch({
        type: "FAIL",
        message: describeWalletError(error),
        recoverTo: machine.recoverTo,
      });
    } finally {
      setRevoking(false);
    }
  }

  const nextApproval = prepared?.approvalPlan.steps[0];
  const amountRequired = prepared?.approvalPlan.requiredAllowance;

  return (
    <>
      <aside className="readiness-banner" role="status">
        <span>{deploymentResult.configured ? "Launch checks" : "Deployment setup"}</span>
        <div>
          <strong>
            {deploymentResult.configured
              ? "Wallet simulation, exact approvals, and receipt checks are enabled."
              : "The audited production factory is not configured yet."}
          </strong>
          <p>
            {deploymentResult.configured
              ? "Artwork and metadata pin through LayPipe before the wallet requests an exact PIPEDOG approval."
              : `${deploymentResult.reason} The form remains usable for launch review, but cannot request funds.`}
          </p>
        </div>
      </aside>

      <div className="launch-workspace">
        <form className="product-form" onSubmit={review}>
          <fieldset className={styles.formReset} disabled={locked}>
            <div className="form-section">
              <div className="form-section-title">
                <span>01</span>
                <div>
                  <h2>Coin details</h2>
                  <p>The facts traders will see on the board and IPFS.</p>
                </div>
              </div>

              <div className="form-grid">
                <label>
                  <span>Coin name</span>
                  <input
                    value={name}
                    onChange={(event) => edit(setName, event.target.value)}
                    placeholder="Very Pipe Coin"
                    maxLength={32}
                    required
                  />
                </label>
                <label>
                  <span>Ticker</span>
                  <div className="affixed-input">
                    <i>$</i>
                    <input
                      value={symbol}
                      onChange={(event) =>
                        edit(
                          setSymbol,
                          event.target.value
                            .toUpperCase()
                            .replace(/[^A-Z0-9]/g, ""),
                        )
                      }
                      placeholder="PIPE"
                      maxLength={10}
                      required
                    />
                  </div>
                </label>
              </div>

              <label>
                <span>Description</span>
                <textarea
                  value={description}
                  onChange={(event) => edit(setDescription, event.target.value)}
                  placeholder="What escaped from this pipe?"
                  maxLength={240}
                  rows={4}
                  required
                />
                <small>{description.length}/240</small>
              </label>

              <label className="file-field">
                <span>Coin artwork</span>
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  onChange={chooseArtwork}
                  required={!artwork}
                />
                <span className="file-drop">
                  <strong>{artwork?.file.name ?? "Choose PNG, JPG, or WEBP"}</strong>
                  <small>
                    {artwork
                      ? `${artwork.width} × ${artwork.height}px · validated`
                      : "Square · 256–4096px · 5 MB maximum"}
                  </small>
                </span>
              </label>
              {artworkError && (
                <p className={styles.fieldError} role="alert">
                  {artworkError}
                </p>
              )}
            </div>

            <div className="form-section">
              <div className="form-section-title">
                <span>02</span>
                <div>
                  <h2>Social links</h2>
                  <p>Optional HTTPS links included in immutable token metadata.</p>
                </div>
              </div>
              <div className="form-grid">
                <label>
                  <span>Website</span>
                  <input
                    type="url"
                    inputMode="url"
                    value={website}
                    onChange={(event) => edit(setWebsite, event.target.value)}
                    placeholder="https://example.com"
                  />
                </label>
                <label>
                  <span>X / Twitter</span>
                  <input
                    type="url"
                    inputMode="url"
                    value={twitter}
                    onChange={(event) => edit(setTwitter, event.target.value)}
                    placeholder="https://x.com/yourcoin"
                  />
                </label>
                <label>
                  <span>Telegram</span>
                  <input
                    type="url"
                    inputMode="url"
                    value={telegram}
                    onChange={(event) => edit(setTelegram, event.target.value)}
                    placeholder="https://t.me/yourcoin"
                  />
                </label>
                <label>
                  <span>Discord</span>
                  <input
                    type="url"
                    inputMode="url"
                    value={discord}
                    onChange={(event) => edit(setDiscord, event.target.value)}
                    placeholder="https://discord.gg/invite"
                  />
                </label>
              </div>
            </div>

            <div className="form-section">
              <div className="form-section-title">
                <span>03</span>
                <div>
                  <h2>Route the creator lane</h2>
                  <p>The 0.3% protocol lane is routed directly in PIPEDOG.</p>
                </div>
              </div>

              <div className="mode-picker" role="group" aria-label="Fee mode">
                <button
                  type="button"
                  aria-pressed={mode === "creator"}
                  onClick={() => edit(setMode, "creator")}
                >
                  <i aria-hidden="true">↗</i>
                  <strong>Creator fees</strong>
                  <span>0.7% of every trade becomes claimable PIPEDOG.</span>
                </button>
                <button
                  type="button"
                  aria-pressed={mode === "self-burn"}
                  onClick={() => edit(setMode, "self-burn")}
                >
                  <i aria-hidden="true">↓</i>
                  <strong>Self-burn</strong>
                  <span>
                    0.7% uses PIPEDOG to buy and permanently burn your own coin.
                  </span>
                </button>
              </div>
            </div>

            <div className="form-section">
              <div className="form-section-title">
                <span>04</span>
                <div>
                  <h2>Optional first buy</h2>
                  <p>Protected by a user-set minimum output in the launch transaction.</p>
                </div>
              </div>

              <div className="form-grid">
                <label>
                  <span>First buy</span>
                  <div className="affixed-input suffix">
                    <input
                      type="text"
                      inputMode="decimal"
                      value={firstBuy}
                      onChange={(event) => changeFirstBuy(event.target.value)}
                      disabled
                      required
                    />
                    <i>PIPEDOG</i>
                  </div>
                </label>
                <label>
                  <span>Minimum launched tokens out</span>
                  <input
                    type="text"
                    inputMode="decimal"
                    value={firstBuyMinOut}
                    onChange={(event) => edit(setFirstBuyMinOut, event.target.value)}
                    placeholder={firstBuyLooksZero ? "Not needed for zero buy" : "Required"}
                    disabled
                  />
                </label>
              </div>
              <p className={styles.safetyCopy}>
                First buys are disabled until LayPipe exposes a trusted quote and
                slippage flow. The production launch path currently uses zero.
              </p>
            </div>
          </fieldset>

          {machine.phase === "draft" || machine.phase === "failed" ? (
            <button className="button button-accent review-launch" type="submit">
              Review launch
            </button>
          ) : (
            <button className="button button-disabled review-launch" type="button" disabled>
              Launch details locked for this attempt
            </button>
          )}
          <p className="form-disclaimer">
            IPFS pinning happens before wallet transactions. Native ETH is used
            only for Robinhood Chain gas; launches are paid in PIPEDOG.
          </p>
        </form>

        <aside className="launch-receipt" aria-live="polite">
          <div className="receipt-top">
            <span>Launch receipt</span>
            <span className="preview-tag">{machine.phase.replaceAll("-", " ")}</span>
          </div>
          <div className="receipt-coin">
            <div aria-hidden="true">{symbol.slice(0, 2) || "?"}</div>
            <h2>{tokenLabel}</h2>
            <p>{description || "Your launch summary will appear here."}</p>
          </div>
          <dl>
            <div>
              <dt>Total supply</dt>
              <dd>
                {prepared
                  ? formatWholeTokens(prepared.preflight.launchConfig.supply)
                  : "Configured at preflight"}
              </dd>
            </div>
            <div>
              <dt>Trading fee</dt>
              <dd>1.0%</dd>
            </div>
            <div>
              <dt>Creator lane</dt>
              <dd>{mode === "self-burn" ? "0.7% self-burn" : "0.7% creator"}</dd>
            </div>
            <div>
              <dt>Protocol lane</dt>
              <dd>0.3% PIPEDOG → router</dd>
            </div>
            <div>
              <dt>First buy</dt>
              <dd>{firstBuy || "0"} PIPEDOG</dd>
            </div>
            <div>
              <dt>Wallet</dt>
              <dd>{account ? shortAddress(account) : "Not connected"}</dd>
            </div>
            {prepared && (
              <>
                <div>
                  <dt>Launch fee</dt>
                  <dd>{formatUnits(prepared.preflight.launchFee, 18)} PIPEDOG</dd>
                </div>
                <div>
                  <dt>Exact approval</dt>
                  <dd>{formatUnits(amountRequired ?? BigInt(0), 18)} PIPEDOG</dd>
                </div>
                <div>
                  <dt>Predicted token</dt>
                  <dd>{shortAddress(prepared.predictedToken)}</dd>
                </div>
              </>
            )}
          </dl>
          <div className="locked-liquidity">
            <i aria-hidden="true">×</i>
            <div>
              <strong>Liquidity cannot be removed</strong>
              <span>The v4 hook rejects removal forever.</span>
            </div>
          </div>

          <div className="review-complete">
            {machine.phase === "draft" && (
              <>
                <strong>Complete the launch details.</strong>
                <p>Artwork is inspected locally before any upload is allowed.</p>
              </>
            )}
            {machine.phase === "reviewed" && (
              <>
                <strong>Details reviewed.</strong>
                <p>Connect an EVM wallet and switch to Robinhood Chain.</p>
                <button className="button button-accent" type="button" onClick={connectWallet}>
                  Connect wallet
                </button>
              </>
            )}
            {machine.phase === "connecting" && (
              <>
                <strong>Waiting for your wallet.</strong>
                <p>Approve the connection and Robinhood Chain network switch.</p>
                <button className="button button-disabled" type="button" disabled>
                  Connecting…
                </button>
              </>
            )}
            {machine.phase === "wallet-ready" && (
              <>
                <strong>Wallet ready.</strong>
                <p>
                  Preflight the factory, pin the image and metadata, then mine the
                  deterministic token address. Pinning itself is not reversible.
                </p>
                <button
                  className={
                    deploymentResult.configured
                      ? "button button-accent"
                      : "button button-disabled"
                  }
                  type="button"
                  onClick={prepareLaunch}
                  disabled={!deploymentResult.configured}
                >
                  Pin metadata &amp; prepare
                </button>
                <button
                  className="button"
                  type="button"
                  onClick={revokeFactoryAllowance}
                  disabled={revoking}
                >
                  {revoking ? "Checking allowance…" : "Clear stale factory allowance"}
                </button>
                {walletNotice && <p>{walletNotice}</p>}
              </>
            )}
            {machine.phase === "preparing" && (
              <>
                <strong>Preparing the launch.</strong>
                <p>Checking the factory, pinning both CIDs, and mining the token address.</p>
                <button className="button button-disabled" type="button" disabled>
                  Preparing…
                </button>
              </>
            )}
            {machine.phase === "approval-required" && prepared && nextApproval && (
              <>
                <strong>{nextApproval.label}.</strong>
                <p>
                  {nextApproval.kind === "reset"
                    ? "A previous non-zero allowance must be reset before the exact approval."
                    : `Approve exactly ${formatUnits(nextApproval.amount, 18)} PIPEDOG. No unlimited approval.`}
                </p>
                <button
                  className="button button-accent"
                  type="button"
                  onClick={submitNextApproval}
                >
                  {nextApproval.kind === "reset" ? "Reset allowance to zero" : "Approve exact amount"}
                </button>
              </>
            )}
            {machine.phase === "approval-pending" && (
              <>
                <strong>Approval submitted.</strong>
                <p>Waiting for an on-chain receipt before continuing.</p>
                {pendingHash && (
                  <a
                    className={styles.receiptLink}
                    href={explorerTransactionUrl(pendingHash)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    View approval ↗
                  </a>
                )}
                {postLaunchWarning && (
                  <p className={styles.warning} role="alert">
                    {postLaunchWarning}
                  </p>
                )}
              </>
            )}
            {machine.phase === "ready-to-launch" && prepared && (
              <>
                <strong>Exact allowance confirmed.</strong>
                <p>
                  The wallet will simulate the nonpayable launch before asking
                  you to sign. A failed launch leaves the exact allowance in place.
                </p>
                <button className="button button-accent" type="button" onClick={submitLaunch}>
                  Launch {prepared.params.symbol}
                </button>
              </>
            )}
            {machine.phase === "launch-pending" && (
              <>
                <strong>{pendingHash ? "Launch submitted." : "Confirm the launch in your wallet."}</strong>
                <p>
                  {pendingHash
                    ? "Waiting for the TokenLaunched receipt. Do not submit it again."
                    : "The transaction was simulated before this wallet prompt."}
                </p>
                {pendingHash && (
                  <a
                    className={styles.receiptLink}
                    href={explorerTransactionUrl(pendingHash)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    View pending launch ↗
                  </a>
                )}
                {postLaunchWarning && (
                  <p className={styles.warning} role="alert">
                    {postLaunchWarning}
                  </p>
                )}
              </>
            )}
            {machine.phase === "succeeded" && completed && (
              <div className={styles.successState}>
                <strong>Token launched.</strong>
                <p>
                  {completed.allowanceCleared === true
                    ? "The exact factory allowance was consumed back to zero."
                    : "The launch receipt is confirmed."}
                </p>
                <div className={styles.resultLinks}>
                  <a
                    href={explorerTokenUrl(completed.token)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    View token ↗
                  </a>
                  <a
                    href={explorerTransactionUrl(completed.transactionHash)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    View transaction ↗
                  </a>
                </div>
                {postLaunchWarning && (
                  <p className={styles.warning} role="alert">
                    {postLaunchWarning}
                  </p>
                )}
              </div>
            )}
            {machine.phase === "failed" && (
              <div className={styles.errorState} role="alert">
                <strong>This step did not complete.</strong>
                <p>{machine.message}</p>
                {pendingHash && (
                  <a
                    className={styles.receiptLink}
                    href={explorerTransactionUrl(pendingHash)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Check the transaction before retrying ↗
                  </a>
                )}
                {pendingHash ? (
                  <p className={styles.warning}>
                    Do not retry or revoke yet. Resolve the pending transaction
                    in the explorer first, then reload and run a fresh preflight.
                  </p>
                ) : (
                  <>
                    <button
                      className="button"
                      type="button"
                      onClick={() => dispatch({ type: "RECOVER" })}
                    >
                      Return to the previous step
                    </button>
                    {prepared &&
                      ["approval-required", "ready-to-launch"].includes(
                        machine.recoverTo,
                      ) && (
                        <button
                          className="button"
                          type="button"
                          onClick={revokeFactoryAllowance}
                          disabled={revoking}
                        >
                          {revoking
                            ? "Revoking…"
                            : "Revoke factory allowance & edit"}
                        </button>
                      )}
                  </>
                )}
              </div>
            )}
          </div>
        </aside>
      </div>
    </>
  );
}
