import Image from "next/image";
import Link from "next/link";
import type { LaypipePageData } from "../_data/laypipe";
import { LaypipeTradePanel } from "./LaypipeTradePanel";
import { PipeDogWalletPanel } from "./PipeDogWalletPanel";
import styles from "./laypipe-product.module.css";

const wholeNumber = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 0,
});

export function LaypipeProduct({ data }: { data: LaypipePageData }) {
  const { protocol, wallet } = data;
  const feePercent = protocol.tradeFeeBps / 100;

  return (
    <main className={styles.productPage}>
      <section className={`${styles.hero} content-width`}>
        <div className={styles.heroCopy}>
          <p className={styles.sectionEyebrow}>One coin. One pipe.</p>
          <h1>LayPipe.</h1>
          <p className={styles.heroLead}>
            Buy LAYPIPE with PIPEDOG. Every complete{" "}
            {wholeNumber.format(BigInt(protocol.laypipePerPipeDog))} LAYPIPE
            automatically becomes a PipeDog. Every PipeDog counts as one share
            of the PIPEDOG flowing from trades.
          </p>
          <div className={styles.heroActions}>
            <a className={styles.primaryAction} href="#trade">
              Enter the pipe
            </a>
            <a className={styles.secondaryAction} href="#pipedogs">
              See My PipeDogs
            </a>
          </div>
          <dl className={styles.heroStats}>
            <div>
              <dt>Fixed supply</dt>
              <dd>1,000,000,000</dd>
              <small>LAYPIPE</small>
            </div>
            <div>
              <dt>Max PipeDogs</dt>
              <dd>{wholeNumber.format(protocol.maxPipeDogs)}</dd>
              <small>Automatic NFTs</small>
            </div>
            <div>
              <dt>Trading fee</dt>
              <dd>{feePercent}%</dd>
              <small>All to NFT holders</small>
            </div>
          </dl>
        </div>

        <div
          className={styles.heroArt}
          role="img"
          aria-label="Canonical PIPEDOG in the LayPipe"
        >
          <span className={styles.heroStatus}>{protocol.statusLabel}</span>
          <div className={styles.pipeHalo} aria-hidden="true" />
          <Image
            className={styles.heroDog}
            src="/brand/pipedog.png"
            alt="The canonical PIPEDOG artwork"
            width={386}
            height={351}
            priority
            loading="eager"
            sizes="(max-width: 900px) 72vw, 560px"
          />
          <div className={styles.thresholdTicket}>
            <span>Automatic threshold</span>
            <strong>
              {wholeNumber.format(BigInt(protocol.laypipePerPipeDog))} LAYPIPE
            </strong>
            <small>= 1 PipeDog</small>
          </div>
        </div>
      </section>

      <section id="trade" className={styles.tradeSection}>
        <div className={`${styles.twoColumn} content-width`}>
          <div className={styles.tradeCopy}>
            <p className={styles.sectionEyebrow}>The only market</p>
            <h2>LAYPIPE trades against PIPEDOG.</h2>
            <p>
              One permanent, one-sided Uniswap v4 bonding pool. No public token
              launcher, no leaderboard, and no second quote asset.
            </p>
            <div className={styles.mechanicList}>
              <article>
                <span>01</span>
                <div>
                  <strong>Buy or sell on the curve</strong>
                  <p>PIPEDOG is the payment, paired asset, and fee asset.</p>
                </div>
              </article>
              <article>
                <span>02</span>
                <div>
                  <strong>Cross a 100,000-token threshold</strong>
                  <p>The NFT mirror updates automatically with whole units.</p>
                </div>
              </article>
              <article>
                <span>03</span>
                <div>
                  <strong>Claim PIPEDOG by NFT count</strong>
                  <p>Less than one complete unit receives no fee allocation.</p>
                </div>
              </article>
            </div>
          </div>
          <LaypipeTradePanel protocol={protocol} />
        </div>
      </section>

      <section className={`${styles.feeSection} content-width`}>
        <div className={styles.feeHeading}>
          <p className={styles.sectionEyebrow}>Every official-pool trade fills the pipe</p>
          <h2>One clean percent.</h2>
          <p>
            The official pool&apos;s v4 hook collects {feePercent}% in PIPEDOG. The
            reward accumulator divides it by the active PipeDog count. Your
            share is based only on how many whole PipeDogs your wallet holds.
          </p>
        </div>
        <div className={styles.feeFlow} aria-label="PIPEDOG fee flow">
          <article>
            <span>Buy or sell</span>
            <strong>{feePercent}% PIPEDOG</strong>
          </article>
          <i aria-hidden="true" />
          <article>
            <span>Reward accumulator</span>
            <strong>No holder loop</strong>
          </article>
          <i aria-hidden="true" />
          <article>
            <span>Your claim</span>
            <strong>PipeDogs x share</strong>
          </article>
        </div>
      </section>

      <div className={`${styles.walletWrap} content-width`}>
        <PipeDogWalletPanel protocol={protocol} snapshot={wallet} />
      </div>

      <section className={`${styles.finalCallout} content-width`}>
        <Image
          src="/brand/pipedog-pipe-mark.png"
          alt=""
          width={512}
          height={512}
          sizes="96px"
        />
        <div>
          <p className={styles.sectionEyebrow}>The full loop</p>
          <h2>LayPipe. Get PipeDog. Claim PIPEDOG.</h2>
        </div>
        <Link href="/tokenomics">See the mechanics</Link>
      </section>
    </main>
  );
}
