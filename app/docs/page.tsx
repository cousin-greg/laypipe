import Link from "next/link";

const PIPEDOG_CA = "0x5Cb6F181081301b44905F3ae15419112ecaBd8A6";

const readiness = [
  { system: "Product interface", status: "Preview ready", tone: "ready" },
  {
    system: "Factory + v4 hook",
    status: "Release suite pending",
    tone: "pending",
  },
  {
    system: "Curve economics",
    status: "Not production-calibrated",
    tone: "pending",
  },
  { system: "Direct fee router", status: "Release suite pending", tone: "pending" },
  {
    system: "Dividend launches",
    status: "Contract-disabled",
    tone: "pending",
  },
  { system: "External audit", status: "Not started", tone: "pending" },
  { system: "Robinhood deployment", status: "Not deployed", tone: "pending" },
  { system: "Event indexer", status: "Not connected", tone: "pending" },
];

export default function DocsPage() {
  return (
    <main className="inner-page content-width docs-page">
      <section className="page-heading compact">
        <div>
          <p className="eyebrow">OPEN THE PIPEWORKS</p>
          <h1>Docs</h1>
          <p>
            The intended launch lifecycle, fee routes, keeper actions, and the
            line between this product preview and live infrastructure.
          </p>
        </div>
      </section>

      <div className="docs-layout">
        <aside className="docs-nav">
          <strong>On this page</strong>
          <a href="#overview">Overview</a>
          <a href="#launches">Launches</a>
          <a href="#fees">Trading fees</a>
          <a href="#keepers">Keepers</a>
          <a href="#readiness">Readiness</a>
          <a href="#contracts">Contracts</a>
        </aside>

        <article className="docs-content">
          <section id="overview">
            <span className="docs-number">01</span>
            <h2>Overview</h2>
            <p>
              LayPipe is a Robinhood Chain coin launcher built around a Uniswap
              v4 hook. Each launch creates a fixed-supply token, opens a
              permanent one-sided PIPEDOG pool, and configures its fee route in
              one flow.
            </p>
            <div className="docs-note">
              <strong>Current state</strong>
              <p>
                The product UI uses explicitly labeled fixtures. No demo coin
                shown on the Board represents an actual LayPipe deployment.
              </p>
            </div>
          </section>

          <section id="launches">
            <span className="docs-number">02</span>
            <h2>Launches</h2>
            <p>
              The intended factory creates a token with a fixed one-billion
              supply and deposits the whole supply into its PIPEDOG-quoted v4
              pool. The hook prevents liquidity removal; there is no separate
              graduation or migration step.
            </p>
            <ol>
              <li>Choose the token identity and optional PIPEDOG first buy.</li>
              <li>Select creator-fee or self-burn mode.</li>
              <li>
                Approve only the exact PIPEDOG launch fee and first-buy amount.
              </li>
              <li>Create the token and initialize its PIPEDOG pair.</li>
              <li>Lock the liquidity path and emit indexable launch events.</li>
            </ol>
            <div className="docs-note">
              <strong>Approval is a separate wallet action</strong>
              <p>
                PIPEDOG has no permit support. A live wallet must grant the
                exact ERC-20 allowance required for that launch or buy, never
                an unlimited approval. Native ETH pays network gas only.
              </p>
            </div>
            <div className="docs-note">
              <strong>Dividend launches are closed</strong>
              <p>
                The inherited enrollment-based dividend mode is intentionally
                blocked by the current factory implementation. Creator-fee and
                self-burn launches remain the only supported modes until a
                complete-holder reward design receives a separate review.
              </p>
            </div>
            <div className="docs-note">
              <strong>Curve economics need production calibration</strong>
              <p>
                The permanent v4 launch curve is implemented locally, but its
                starting price, depth, and execution bounds still need
                fork-backed liquidity testing before any production release.
              </p>
            </div>
          </section>

          <section id="fees">
            <span className="docs-number">03</span>
            <h2>Trading fees</h2>
            <p>
              A fixed 1% fee is collected in PIPEDOG. The creator lane receives
              0.7%; the LayPipe protocol router receives 0.3%.
            </p>
            <div className="docs-columns">
              <div>
                <strong>Creator-fee mode</strong>
                <p>The launch owner can claim accrued PIPEDOG.</p>
              </div>
              <div>
                <strong>Self-burn mode</strong>
                <p>
                  Accrued PIPEDOG buys the launched coin from its own pool and
                  permanently burns the received tokens.
                </p>
              </div>
            </div>
          </section>

          <section id="keepers">
            <span className="docs-number">04</span>
            <h2>Permissionless keepers</h2>
            <p>
              Hook sweeps and protocol-router actions are public. The router’s
              two permissionless routing lanes can pay a configured PIPEDOG
              keeper bounty deducted from the lane being processed. Sweeping
              platform fees out of an inactive launch pool is unbountied, so
              production operations must monitor and trigger that step when
              creators stop claiming.
            </p>
            <div className="docs-note">
              <strong>Self-burn orders expose execution risk</strong>
              <p>
                Self-burns use capped, visible PIPEDOG market orders without an
                oracle or minimum output. The caps limit order size, but do not
                eliminate sandwiching or price movement. Review those limits
                against live liquidity before enabling launches. Protocol
                PIPEDOG distributions are direct transfers, not market orders.
              </p>
            </div>
            <div className="docs-note">
              <strong>What “PIPEDOG burn” means</strong>
              <p>
                The gross protocol lane is already PIPEDOG. It assigns 25%
                directly to 0x000000000000000000000000000000000000dEaD, 25%
                to treasury, and 50% to operations. Eligible keeper bounties
                are deducted from the two permissionless routing lanes.
                PIPEDOG has no native burn function, so the dead-address
                transfer removes tokens from usable circulation without
                reducing ERC-20 totalSupply.
              </p>
            </div>
          </section>

          <section id="readiness">
            <span className="docs-number">05</span>
            <h2>Readiness</h2>
            <p>
              “Live” requires verified contract addresses, an end-to-end launch
              on Robinhood Chain, indexed events, and a completed security
              review.
            </p>
            <div className="docs-note">
              <strong>Admin roles remain trusted</strong>
              <p>
                The factory can be upgraded for future launches, the hook
                owner can change the platform-fee destination, and the router
                owner can pause or migrate platform PIPEDOG. Production
                ownership should move to a reviewed Safe or timelock before
                launch.
              </p>
            </div>
            <div className="readiness-table">
              {readiness.map((item) => (
                <div key={item.system}>
                  <span>{item.system}</span>
                  <strong className={item.tone}>{item.status}</strong>
                </div>
              ))}
            </div>
          </section>

          <section id="contracts">
            <span className="docs-number">06</span>
            <h2>Contract registry</h2>
            <p>
              Only the protocol asset is configured today. LayPipe deployment
              fields remain deliberately blank rather than pointing at the
              original LetsCash system.
            </p>
            <dl className="contract-registry">
              <div>
                <dt>PIPEDOG</dt>
                <dd>{PIPEDOG_CA}</dd>
              </div>
              <div>
                <dt>LayPipe factory</dt>
                <dd>Pending deployment</dd>
              </div>
              <div>
                <dt>LayPipe v4 hook</dt>
                <dd>Pending deployment</dd>
              </div>
              <div>
                <dt>PIPEDOG fee router</dt>
                <dd>Pending deployment</dd>
              </div>
            </dl>
            <div className="docs-links">
              <a
                href="https://www.letscash.fun/docs"
                target="_blank"
                rel="noreferrer"
              >
                Reference protocol docs ↗
              </a>
              <a
                href={`https://robinhoodchain.blockscout.com/token/${PIPEDOG_CA}`}
                target="_blank"
                rel="noreferrer"
              >
                PIPEDOG on Blockscout ↗
              </a>
              <Link href="/tokenomics">LayPipe tokenomics →</Link>
            </div>
          </section>
        </article>
      </div>
    </main>
  );
}
