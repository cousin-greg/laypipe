import type { Metadata } from "next";
import Image from "next/image";

const PIPEDOG_CA = "0x5Cb6F181081301b44905F3ae15419112ecaBd8A6";

export const metadata: Metadata = {
  title: "Mechanics | laypipe.fun",
  description:
    "One billion LAYPIPE, 10,000 automatic Lay Pipedogs, and a 1% ETH-side fee funding periodic PIPEDOG rewards.",
};

export default function TokenomicsPage() {
  return (
    <main className="inner-page content-width">
      <section className="page-heading tokenomics-heading">
        <div>
          <p className="eyebrow">ONE COIN. ONE CLEAN PERCENT.</p>
          <h1>Every official-pool trade funds the PIPEDOG reward cycle.</h1>
          <p>
            LAYPIPE has a fixed one-billion-token supply and a maximum of 10,000
            automatic Lay Pipedog NFTs. Every complete 100,000 LAYPIPE balance is
            one NFT and one unit of the periodic PIPEDOG reward allocation.
          </p>
        </div>
        <Image
          src="/brand/pipedog.png"
          alt="The canonical PIPEDOG artwork"
          width={386}
          height={351}
          sizes="(max-width: 800px) 60vw, 360px"
        />
      </section>

      <section className="fee-diagram" aria-label="ETH fee to PIPEDOG reward flow">
        <div className="fee-source">
          <span>Every official-pool buy + sell</span>
          <strong>1.00%</strong>
          <small>Accrued on the native ETH side by the Uniswap v4 hook</small>
        </div>
        <div className="fee-pipe" aria-hidden="true">
          <i />
        </div>
        <div className="fee-branches">
          <article>
            <span>Lay Pipedog holder lane</span>
            <strong>100%</strong>
            <p>
              Periodic, trustless execution uses the accrued ETH to buy PIPEDOG.
              The purchased PIPEDOG is allocated by whole Lay Pipedog count.
            </p>
            <div className="branch-choice">
              <span>1 NFT = 1 unit</span>
              <span>0 NFTs = 0 share</span>
            </div>
          </article>
          <article className="protocol-branch">
            <span>Claim model</span>
            <strong>Pull</strong>
            <p>
              Purchased PIPEDOG accrues to a per-NFT index. Holder accounting is
              deterministic, and trades never loop over every wallet.
            </p>
            <div className="branch-choice">
              <span>No developer cut</span>
              <span>No holder loop</span>
            </div>
          </article>
        </div>
      </section>

      <section className="tokenomics-notes">
        <article>
          <span>Fixed supply</span>
          <h2>1,000,000,000 LAYPIPE.</h2>
          <p>
            Ten thousand equal NFT units fit exactly into the full token supply.
          </p>
        </article>
        <article>
          <span>Automatic threshold</span>
          <h2>100,000 per Lay Pipedog.</h2>
          <p>
            The mirror count follows the whole-unit portion of a wallet balance.
          </p>
        </article>
        <article>
          <span>Single market</span>
          <h2>ETH / LAYPIPE.</h2>
          <p>
            A permanent one-sided v4 bonding pool is the only intended trading
            route exposed by the website.
          </p>
        </article>
      </section>

      <section className="contract-callout">
        <div>
          <span>Canonical PIPEDOG</span>
          <strong>{PIPEDOG_CA}</strong>
        </div>
        <a
          className="button button-quiet"
          href={`https://robinhoodchain.blockscout.com/token/${PIPEDOG_CA}`}
          target="_blank"
          rel="noreferrer"
        >
          Verify token
        </a>
      </section>

      <aside className="readiness-banner">
        <span>Contract preview</span>
        <div>
          <strong>The singleton ABIs and addresses are not wired yet.</strong>
          <p>
            The website keeps buy, sell, mirror, reward-cycle, and claim
            mutations disabled until the reviewed singleton deployment is
            configured.
          </p>
        </div>
      </aside>
    </main>
  );
}
