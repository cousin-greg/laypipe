import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  compactMoney,
  compactNumber,
  formatAge,
  formatMoney,
} from "../../_components/format";
import { Sparkline } from "../../_components/Sparkline";
import { findDemoToken, marketSource } from "../../_data/market";

export function generateStaticParams() {
  return [
    { slug: "pipedog" },
    ...marketSource.tokens.map((token) => ({ slug: token.slug })),
  ];
}

const PIPEDOG_CA = "0x5Cb6F181081301b44905F3ae15419112ecaBd8A6";

function PipedogPage() {
  return (
    <main className="inner-page content-width token-page">
      <div className="breadcrumb">
        <Link href="/">Board</Link>
        <span>→</span>
        <span>PIPEDOG</span>
      </div>

      <aside className="preview-notice token-notice">
        <span>Protocol asset</span>
        <p>
          PIPEDOG is live on Robinhood Chain. LayPipe’s direct routing to
          0xdead, treasury, and operations is still pending deployment.
        </p>
        <a
          href={`https://robinhoodchain.blockscout.com/token/${PIPEDOG_CA}`}
          target="_blank"
          rel="noreferrer"
        >
          Verify token ↗
        </a>
      </aside>

      <section className="pipedog-profile">
        <div className="pipedog-portrait">
          <div className="sun-disc" aria-hidden="true" />
          <Image
            src="/brand/pipedog.png"
            alt="PIPEDOG detective"
            width={386}
            height={351}
            priority
            unoptimized
          />
        </div>
        <div>
          <span className="status-pill">LayPipe protocol token</span>
          <h1>PIPEDOG</h1>
          <p>
            The curious dog at the end of the pipe. PIPEDOG is LayPipe’s quote,
            payment, fee, and paired asset. The gross protocol share routes 25%
            directly to 0xdead, 25% to treasury, and 50% to operations.
          </p>
          <div className="pipedog-ca">
            <span>Contract address</span>
            <strong>{PIPEDOG_CA}</strong>
          </div>
          <div className="empty-actions">
            <a
              className="button button-accent"
              href="https://app.uniswap.org/explore/tokens/robinhood/0x5Cb6F181081301b44905F3ae15419112ecaBd8A6"
              target="_blank"
              rel="noreferrer"
            >
              Trade on Uniswap ↗
            </a>
            <a
              className="button button-quiet"
              href="https://dexscreener.com/robinhood/0xb7f10f74b39291b9290b779978e19a7637c742d6"
              target="_blank"
              rel="noreferrer"
            >
              Live chart ↗
            </a>
          </div>
        </div>
      </section>

      <section className="pipedog-route">
        <div>
          <span>LayPipe route status</span>
          <strong>Pending contract deployment</strong>
          <p>
            The interface will display verified direct distributions and
            cumulative PIPEDOG sent to 0xdead, treasury, operations, and
            eligible keepers after the fee router and indexer are connected.
            PIPEDOG has no native burn method, so 0xdead transfers do not
            reduce ERC-20 totalSupply.
          </p>
        </div>
        <div className="route-pipe" aria-hidden="true">
          <span>PIPEDOG fees</span>
          <i />
          <span>Router</span>
          <i />
          <span>0xdead</span>
        </div>
      </section>
    </main>
  );
}

export default async function TokenPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  if (slug === "pipedog") return <PipedogPage />;

  const token = findDemoToken(slug);

  if (!token) notFound();

  return (
    <main className="inner-page content-width token-page token-market-page">
      <div className="breadcrumb">
        <Link href="/">Board</Link>
        <span>→</span>
        <span>{token.name}</span>
      </div>

      <aside className="preview-notice token-notice">
        <span>Demo market</span>
        <p>
          This is an interface fixture, not a deployed token or tradeable pool.
        </p>
        <Link href="/docs#readiness">Why? →</Link>
      </aside>

      <section className="token-hero">
        <div className="token-profile">
          <span
            className="token-avatar xlarge"
            style={{ "--token-accent": token.accent } as React.CSSProperties}
            aria-hidden="true"
          >
            {token.symbol.slice(0, 2)}
          </span>
          <div>
            <span className="demo-chip">Preview coin</span>
            <h1>{token.name}</h1>
            <p>
              ${token.symbol} · launched {formatAge(token.ageHours)} ago
            </p>
          </div>
        </div>
        <p className="token-description">{token.description}</p>
        <div className="token-price">
          <span>Illustrative price</span>
          <strong>{formatMoney(token.price)}</strong>
          <em className={token.change24h >= 0 ? "up" : "down"}>
            {token.change24h >= 0 ? "+" : ""}
            {token.change24h.toFixed(1)}% 24h
          </em>
        </div>
      </section>

      <div className="token-workspace">
        <section className="token-chart-panel">
          <div className="panel-title">
            <div>
              <span>Price movement</span>
              <strong>24 hours</strong>
            </div>
            <span>Fixture series</span>
          </div>
          <Sparkline
            values={token.chart}
            positive={token.change24h >= 0}
            label={`${token.name} illustrative 24 hour price trend`}
          />
          <div className="chart-axis" aria-hidden="true">
            <span>24h ago</span>
            <span>12h</span>
            <span>Now</span>
          </div>
        </section>

        <aside className="trade-panel">
          <div className="trade-tabs">
            <button type="button" aria-pressed="true">
              Buy
            </button>
            <button type="button" aria-pressed="false">
              Sell
            </button>
          </div>
          <label>
            <span>You pay</span>
            <div>
              <input value="0.00" readOnly aria-label="Trade amount" />
              <strong>PIPEDOG</strong>
            </div>
          </label>
          <div className="trade-quote">
            <span>You receive</span>
            <strong>— ${token.symbol}</strong>
          </div>
          <button className="button button-disabled" type="button" disabled>
            Pool not deployed
          </button>
          <p>
            Trading activates only for verified LayPipe pools. A live buy needs
            an exact PIPEDOG approval; native ETH pays gas only.
          </p>
        </aside>
      </div>

      <section className="token-stat-grid">
        <article>
          <span>Market cap</span>
          <strong>{compactMoney(token.marketCap)}</strong>
        </article>
        <article>
          <span>24h volume</span>
          <strong>{compactMoney(token.volume24h)}</strong>
        </article>
        <article>
          <span>Liquidity</span>
          <strong>{compactMoney(token.liquidity)}</strong>
        </article>
        <article>
          <span>Holders</span>
          <strong>{compactNumber(token.holders)}</strong>
        </article>
        <article>
          <span>Trades</span>
          <strong>{compactNumber(token.trades)}</strong>
        </article>
        <article>
          <span>Fee mode</span>
          <strong>
            {token.mode === "self-burn" ? "Self-burn" : "Creator fees"}
          </strong>
        </article>
      </section>

      <section className="token-route-card">
        <div>
          <span>Fee route</span>
          <h2>
            1% enters in PIPEDOG. The 0.3% protocol lane splits 25% / 25% /
            50%.
          </h2>
        </div>
        <div className="route-pipe" aria-hidden="true">
          <span>Trade</span>
          <i />
          <span>Hook</span>
          <i />
          <span>Router</span>
        </div>
      </section>
    </main>
  );
}
