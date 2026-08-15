import type { Metadata } from "next";
import Link from "next/link";

const PIPEDOG_CA = "0x5Cb6F181081301b44905F3ae15419112ecaBd8A6";

const readiness = [
  { system: "Singleton product UI", status: "Contract preview" },
  { system: "LAYPIPE token + NFT mirror", status: "ABI pending" },
  { system: "ETH/LAYPIPE v4 fee hook", status: "ABI pending" },
  { system: "PIPEDOG buyback + rewards", status: "ABI pending" },
  { system: "Robinhood deployment", status: "Not configured" },
];

export const metadata: Metadata = {
  title: "Docs | laypipe.fun",
  description:
    "The native ETH/LAYPIPE lifecycle, automatic Lay Pipedogs, periodic PIPEDOG rewards, and interface status.",
};

export default function DocsPage() {
  return (
    <main className="inner-page content-width docs-page">
      <section className="page-heading compact">
        <div>
          <p className="eyebrow">OPEN THE PIPEWORKS</p>
          <h1>Docs</h1>
          <p>
            The intended lifecycle for one LAYPIPE token, one native ETH bonding
            pool, automatic Lay Pipedogs, and periodic PIPEDOG rewards.
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
              single market for LAYPIPE, quoted only in native ETH on Robinhood
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
            <h2>ETH / LAYPIPE</h2>
            <p>
              The intended market is one permanent one-sided Uniswap v4 bonding
              pool. Native ETH is the payment asset, paired asset, and source of
              the hook fee. PIPEDOG is purchased later for holder rewards.
            </p>
            <ol>
              <li>Choose buy or sell and request a fresh curve quote.</li>
              <li>
                For buys, set the native ETH amount. No payment-token allowance
                is required for ETH.
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
            <h2>Automatic Lay Pipedogs</h2>
            <p>
              Every whole 100,000 LAYPIPE held by a wallet maps to one Lay Pipedog
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
                  user-facing Lay Pipedogs.
                </p>
              </div>
            </div>
          </section>

          <section id="rewards">
            <span className="docs-number">04</span>
            <h2>One percent into PIPEDOG rewards</h2>
            <p>
              The planned v4 hook accrues a clean 1% fee on the ETH side of each
              official-pool trade. A periodic, trustless reward cycle uses the
              accrued ETH to buy PIPEDOG, then allocates the purchased PIPEDOG
              by whole Lay Pipedog count. Wallets below the NFT threshold have
              zero reward units.
            </p>
            <div className="docs-note">
              <strong>Deterministic holder accounting</strong>
              <p>
                The reward cycle updates one accumulator instead of looping over
                every holder. Each wallet&apos;s allocation follows its whole NFT
                count; no operator chooses holder-by-holder payouts.
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
              PIPEDOG is the configured external reward asset. Native ETH needs
              no token address, and all singleton addresses remain blank rather
              than falling back to the previous multi-launch system.
            </p>
            <dl className="contract-registry">
              <div>
                <dt>PIPEDOG</dt>
                <dd>{PIPEDOG_CA}</dd>
              </div>
              <div>
                <dt>Native ETH</dt>
                <dd>Official market quote and fee input</dd>
              </div>
              <div>
                <dt>LAYPIPE + PipeDog mirror</dt>
                <dd>Pending singleton deployment</dd>
              </div>
              <div>
                <dt>ETH/LAYPIPE fee hook</dt>
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
