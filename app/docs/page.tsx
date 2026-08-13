import type { Metadata } from "next";
import Link from "next/link";

const PIPEDOG_CA = "0x5Cb6F181081301b44905F3ae15419112ecaBd8A6";

const readiness = [
  { system: "Singleton product UI", status: "Contract preview" },
  { system: "LAYPIPE token + NFT mirror", status: "ABI pending" },
  { system: "PIPEDOG v4 fee hook", status: "ABI pending" },
  { system: "PipeDog reward accumulator", status: "ABI pending" },
  { system: "Robinhood deployment", status: "Not configured" },
];

export const metadata: Metadata = {
  title: "Docs | laypipe.fun",
  description:
    "The single-coin LayPipe lifecycle, automatic PipeDogs, PIPEDOG fee flow, and interface status.",
};

export default function DocsPage() {
  return (
    <main className="inner-page content-width docs-page">
      <section className="page-heading compact">
        <div>
          <p className="eyebrow">OPEN THE PIPEWORKS</p>
          <h1>Docs</h1>
          <p>
            The intended lifecycle for one LAYPIPE token, one PIPEDOG bonding
            pool, automatic PipeDogs, and holder claims.
          </p>
        </div>
      </section>

      <div className="docs-layout">
        <aside className="docs-nav">
          <strong>On this page</strong>
          <a href="#overview">Overview</a>
          <a href="#trade">Trading</a>
          <a href="#pipedogs">Automatic NFTs</a>
          <a href="#rewards">Rewards</a>
          <a href="#readiness">Readiness</a>
          <a href="#contracts">Contracts</a>
        </aside>

        <article className="docs-content">
          <section id="overview">
            <span className="docs-number">01</span>
            <h2>One product</h2>
            <p>
              LayPipe is no longer a public token launcher. The website is a
              single market for LAYPIPE, quoted only in PIPEDOG on Robinhood
              Chain. Total supply is fixed at 1,000,000,000 LAYPIPE.
            </p>
            <div className="docs-note">
              <strong>Current interface state</strong>
              <p>
                The product adapter is intentionally in contract-preview mode.
                It exposes representative wallet data while every mutation
                remains disabled.
              </p>
            </div>
          </section>

          <section id="trade">
            <span className="docs-number">02</span>
            <h2>PIPEDOG / LAYPIPE</h2>
            <p>
              The intended market is one permanent one-sided Uniswap v4 bonding
              pool. PIPEDOG is the payment asset, paired asset, and fee asset.
              Native ETH pays chain gas only.
            </p>
            <ol>
              <li>Choose buy or sell and request a fresh curve quote.</li>
              <li>
                For buys, approve only the exact PIPEDOG amount required by the
                submitted transaction.
              </li>
              <li>Submit a slippage-bounded swap through the singleton router.</li>
              <li>
                Very large buys may need to be split. A single buy, sell, or
                transfer may cross at most 20 automatic NFT thresholds
                (2,000,000 LAYPIPE).
              </li>
            </ol>
          </section>

          <section id="pipedogs">
            <span className="docs-number">03</span>
            <h2>Automatic PipeDogs</h2>
            <p>
              Every whole 100,000 LAYPIPE held by a wallet maps to one PipeDog
              NFT. A 99,999 balance maps to zero; 248,250 maps to two with 48,250
              progress toward the third. The maximum mirror supply is 10,000.
            </p>
            <div className="docs-columns">
              <div>
                <strong>Whole units count</strong>
                <p>Only complete 100,000-token units create NFTs.</p>
              </div>
              <div>
                <strong>Contracts are excluded</strong>
                <p>
                  Pool, router, hook, and reward-vault balances do not create
                  user-facing PipeDogs.
                </p>
              </div>
            </div>
          </section>

          <section id="rewards">
            <span className="docs-number">04</span>
            <h2>One percent to holders</h2>
            <p>
              The v4 hook collects a clean 1% fee in PIPEDOG on each buy and
              sell through the official pool. The full fee enters a cumulative
              per-NFT reward index. One PipeDog is one reward unit; wallets
              below the NFT threshold have zero reward units.
            </p>
            <div className="docs-note">
              <strong>Pull-based claims</strong>
              <p>
                Trades update one accumulator instead of transferring to every
                holder. Each wallet settles and claims its own PIPEDOG.
              </p>
            </div>
          </section>

          <section id="readiness">
            <span className="docs-number">05</span>
            <h2>Adapter status</h2>
            <p>
              Contract-preview mode cannot request approvals, trade, mint, or
              claim. Live mode should only be selectable after all singleton
              addresses and ABIs match the configured deployment.
            </p>
            <div className="readiness-table">
              {readiness.map((item) => (
                <div key={item.system}>
                  <span>{item.system}</span>
                  <strong className="pending">{item.status}</strong>
                </div>
              ))}
            </div>
          </section>

          <section id="contracts">
            <span className="docs-number">06</span>
            <h2>Contract registry</h2>
            <p>
              PIPEDOG is the only configured asset. Singleton addresses remain
              blank rather than falling back to the previous multi-launch
              system.
            </p>
            <dl className="contract-registry">
              <div>
                <dt>PIPEDOG</dt>
                <dd>{PIPEDOG_CA}</dd>
              </div>
              <div>
                <dt>LAYPIPE + PipeDog mirror</dt>
                <dd>Pending singleton deployment</dd>
              </div>
              <div>
                <dt>PipeDog fee hook</dt>
                <dd>Pending singleton deployment</dd>
              </div>
              <div>
                <dt>PipeDog rewards</dt>
                <dd>Pending singleton deployment</dd>
              </div>
            </dl>
            <div className="docs-links">
              <a
                href={`https://robinhoodchain.blockscout.com/token/${PIPEDOG_CA}`}
                target="_blank"
                rel="noreferrer"
              >
                PIPEDOG on Blockscout
              </a>
              <Link href="/tokenomics">LayPipe mechanics</Link>
              <Link href="/lore">PipeDog provenance and ethos</Link>
              <Link href="/#trade">Trade preview</Link>
            </div>
          </section>
        </article>
      </div>
    </main>
  );
}
