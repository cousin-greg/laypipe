import Image from "next/image";

const PIPEDOG_CA = "0x5Cb6F181081301b44905F3ae15419112ecaBd8A6";

export default function TokenomicsPage() {
  return (
    <main className="inner-page content-width">
      <section className="page-heading tokenomics-heading">
        <div>
          <p className="eyebrow">ONE PERCENT. FULLY ROUTED.</p>
          <h1>Every trade feeds a visible pipe.</h1>
          <p>
            LayPipe adapts the LetsCash fee machine around PIPEDOG. The launch
            mode controls 70% of fees; the remaining 30% enters the protocol
            router.
          </p>
        </div>
        <Image
          src="/brand/pipedog.png"
          alt="PIPEDOG detective"
          width={386}
          height={351}
          unoptimized
        />
      </section>

      <section className="fee-diagram" aria-label="One percent trading fee flow">
        <div className="fee-source">
          <span>Every buy + sell</span>
          <strong>1.00%</strong>
          <small>Collected in ETH by the v4 hook</small>
        </div>
        <div className="fee-pipe" aria-hidden="true">
          <i />
        </div>
        <div className="fee-branches">
          <article>
            <span>Creator lane</span>
            <strong>0.70%</strong>
            <p>
              Paid as claimable ETH or used to buy and burn the launched token.
            </p>
            <div className="branch-choice">
              <span>Creator fees</span>
              <span>Self-burn</span>
            </div>
          </article>
          <article className="protocol-branch">
            <span>Protocol lane</span>
            <strong>0.30%</strong>
            <p>
              Routed through the LayPipe splitter: equal PIPEDOG buy lanes for
              0xdead and treasury, with the remaining half paid as operations
              ETH.
            </p>
            <div className="protocol-mini-split">
              <span style={{ width: "25%" }}>25% → 0xdead</span>
              <span style={{ width: "25%" }}>25% treasury</span>
              <span style={{ width: "50%" }}>50% ops</span>
            </div>
          </article>
        </div>
      </section>

      <section className="tokenomics-notes">
        <article>
          <span>Fixed at launch</span>
          <h2>One billion tokens.</h2>
          <p>
            The intended factory issues the full fixed supply once and deposits
            it into the launch pool. No admin mint path.
          </p>
        </article>
        <article>
          <span>Locked forever</span>
          <h2>No liquidity removal.</h2>
          <p>
            The hook rejects removal, making the initial liquidity position a
            permanent part of the market.
          </p>
        </article>
        <article>
          <span>Permissionless</span>
          <h2>Anyone can sweep.</h2>
          <p>
            Public keepers can move accrued ETH. PIPEDOG router actions pay a
            1% bounty; unbountied hook sweeps require production monitoring.
          </p>
        </article>
      </section>

      <section className="contract-callout">
        <div>
          <span>PIPEDOG protocol asset</span>
          <strong>{PIPEDOG_CA}</strong>
        </div>
        <a
          className="button button-quiet"
          href={`https://robinhoodchain.blockscout.com/token/${PIPEDOG_CA}`}
          target="_blank"
          rel="noreferrer"
        >
          Verify token ↗
        </a>
      </section>

      <aside className="readiness-banner">
        <span>Design target</span>
        <div>
          <strong>This describes the intended LayPipe contracts.</strong>
          <p>
            PIPEDOG does not expose a native burn method. The 0xdead lane
            permanently sequesters purchased tokens but does not decrement
            ERC-20 totalSupply. Final addresses and permissions must match the
            reviewed deployment before the interface is marked live.
          </p>
        </div>
      </aside>
    </main>
  );
}
