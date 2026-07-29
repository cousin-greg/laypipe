import Image from "next/image";
import Link from "next/link";

export default function MyTokensPage() {
  return (
    <main className="inner-page content-width">
      <section className="page-heading compact">
        <div>
          <p className="eyebrow">YOUR LAUNCHES</p>
          <h1>My tokens</h1>
          <p>
            Creator positions, claimable ETH, self-burn totals, and launch
            controls will live here.
          </p>
        </div>
      </section>

      <section className="wallet-empty-state">
        <div className="empty-pipe-art">
          <Image
            src="/brand/laypipe-mark.png"
            alt="PIPEDOG detective checking an empty pipe"
            width={310}
            height={310}
            unoptimized
          />
        </div>
        <div>
          <span className="status-pill">Wallet view</span>
          <h2>Connect to inspect your pipes.</h2>
          <p>
            Use the wallet control in the header. Once the factory and indexer
            are live, this page will resolve created tokens and fee positions
            directly from your address.
          </p>
          <div className="empty-actions">
            <Link className="button button-accent" href="/launch">
              Preview a launch
            </Link>
            <Link className="button button-quiet" href="/docs#readiness">
              See integration status
            </Link>
          </div>
        </div>
      </section>

      <section className="future-grid" aria-label="Planned wallet features">
        <article>
          <span>01</span>
          <h3>Created coins</h3>
          <p>Factory event history, pool status, volume, and current holders.</p>
        </article>
        <article>
          <span>02</span>
          <h3>Creator claims</h3>
          <p>Accrued ETH and a public claim transaction with receipt status.</p>
        </article>
        <article>
          <span>03</span>
          <h3>Burn activity</h3>
          <p>Self-burn sweeps, keeper bounties, and tokens removed from supply.</p>
        </article>
      </section>
    </main>
  );
}
