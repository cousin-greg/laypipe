"use client";

import Image from "next/image";
import type { CSSProperties } from "react";
import type {
  LaypipeProtocolSnapshot,
  LaypipeWalletSnapshot,
} from "../_data/laypipe";
import { useWallet } from "./WalletProvider";
import styles from "./laypipe-product.module.css";

type WalletPanelVariant = "embedded" | "collection" | "rewards";

const wholeNumber = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 0,
});

function shortAddress(address: string) {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function formatWhole(value: string) {
  return wholeNumber.format(BigInt(value));
}

function formatPipedog(value: string) {
  const [integer = "0", fraction = ""] = value.split(".");
  const formattedInteger = wholeNumber.format(BigInt(integer));
  const trimmedFraction = fraction.slice(0, 2).replace(/0+$/, "");
  return trimmedFraction
    ? `${formattedInteger}.${trimmedFraction}`
    : formattedInteger;
}

export function PipeDogWalletPanel({
  protocol,
  snapshot,
  variant = "embedded",
}: {
  protocol: LaypipeProtocolSnapshot;
  snapshot: LaypipeWalletSnapshot;
  variant?: WalletPanelVariant;
}) {
  const wallet = useWallet();
  const walletBusy = wallet.status === "connecting";
  const progressPercent = snapshot.progressBps / 100;
  const progressStyle = {
    "--pipe-progress": `${progressPercent}%`,
  } as CSSProperties;
  const showGallery = variant !== "rewards";

  const walletLabel = wallet.account
    ? shortAddress(wallet.account)
    : wallet.status === "connecting"
      ? "Connecting..."
      : wallet.status === "wrong-chain"
        ? "Switch chain"
        : "Connect wallet";

  return (
    <section
      id={variant === "embedded" ? "pipedogs" : undefined}
      className={`${styles.walletPanel} ${
        variant === "embedded" ? styles.walletPanelEmbedded : ""
      }`}
    >
      <div className={styles.walletHeader}>
        <div>
          <p className={styles.sectionEyebrow}>
            {variant === "rewards" ? "PIPEDOG rewards" : "Your automatic NFTs"}
          </p>
          <h2>
            {variant === "rewards" ? "Claim from the pipe." : "My Lay Pipedogs"}
          </h2>
          <p>
            Every complete {formatWhole(protocol.laypipePerPipeDog)}
            {" "}LAYPIPE balance creates one Lay Pipedog and one reward unit.
          </p>
        </div>
        <button
          className={styles.connectButton}
          type="button"
          onClick={() => void wallet.connect()}
          disabled={walletBusy}
        >
          {walletLabel}
        </button>
      </div>

      <div className={styles.adapterNotice}>
        <strong>Preview position</strong>
        <span>
          The singleton ownership and reward ABIs are not wired yet. These
          sample values demonstrate the final wallet layout and cannot trigger
          transactions.
        </span>
      </div>

      <div className={styles.walletMetrics}>
        <article>
          <span>LAYPIPE balance</span>
          <strong>{formatWhole(snapshot.balance)}</strong>
          <small>Preview balance</small>
        </article>
        <article>
          <span>Lay Pipedogs</span>
          <strong>{snapshot.pipeDogCount}</strong>
          <small>{snapshot.rewardUnits} reward units</small>
        </article>
        <article className={styles.claimMetric}>
          <span>Claimable PIPEDOG</span>
          <strong>{formatPipedog(snapshot.claimablePipedog)}</strong>
          <button type="button" disabled={!protocol.claimEnabled}>
            Claim PIPEDOG
          </button>
        </article>
      </div>

      <div className={styles.progressCard}>
        <div>
          <span>Next Lay Pipedog</span>
          <strong>
            {formatWhole(snapshot.tokensToNextPipeDog)} LAYPIPE to go
          </strong>
        </div>
        <div
          className={styles.progressTrack}
          role="progressbar"
          aria-label="Progress to next Lay Pipedog"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={progressPercent}
          style={progressStyle}
        >
          <span />
        </div>
        <p>
          {formatWhole(snapshot.remainder)} /{" "}
          {formatWhole(protocol.laypipePerPipeDog)} LAYPIPE
        </p>
      </div>

      {showGallery ? (
        <div className={styles.pipeDogGallery} aria-label="Preview Lay Pipedogs">
          {snapshot.pipeDogs.map((pipeDog) => (
            <article key={pipeDog.id} className={styles.pipeDogCard}>
              <div className={styles.pipeDogArt}>
                <Image
                  src={pipeDog.imagePath}
                  alt="The canonical PIPEDOG artwork"
                  width={386}
                  height={351}
                  sizes="(max-width: 700px) 80vw, 260px"
                />
              </div>
              <div>
                <span>{pipeDog.status}</span>
                <strong>{pipeDog.name}</strong>
                <small>Trait layers pending original artwork</small>
              </div>
            </article>
          ))}
        </div>
      ) : null}

      {wallet.error ? (
        <p className={styles.walletError} role="status">
          {wallet.error}
        </p>
      ) : null}
    </section>
  );
}
