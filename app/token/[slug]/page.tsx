import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import { mapLiveTokenToBoardToken, type BoardToken } from "../../_data/adapter";
import { readMarketDataMode, type MarketDataMode } from "@/lib/server/market/mode";
import { loadLiveTokenPage } from "@/lib/server/market/page-token";
import {
  compactMoney,
  compactNumber,
  formatAge,
} from "../../_components/format";
import {
  formatTokenChange,
  formatTokenPrice,
  formatTokenVolume,
  tokenChangeDirection,
} from "../../_components/market-format";
import { Sparkline } from "../../_components/Sparkline";
import { TokenAvatar } from "../../_components/TokenAvatar";
import { findDemoToken, marketSource } from "../../_data/market";
import type { LiveMarketToken } from "@/lib/market/live";
import type { TradeTokenIdentity } from "@/lib/web3/trade-client";
import { TradePanel } from "./TradePanel";

export const dynamic = "force-dynamic";

export function generateStaticParams() {
  return [
    { slug: "pipedog" },
    ...marketSource.tokens.map((token) => ({ slug: token.slug })),
  ];
}

const PIPEDOG_CA = "0x5Cb6F181081301b44905F3ae15419112ecaBd8A6";

type TokenResolution =
  | {
      status: "ready";
      token: BoardToken;
      tradeToken: TradeTokenIdentity | null;
    }
  | { status: "not_found" }
  | { status: "unavailable" };

async function resolveToken(
  slug: string,
  marketMode: MarketDataMode,
): Promise<TokenResolution> {
  if (marketMode === "fixture") {
    const fixture = findDemoToken(slug);
    return fixture
      ? {
          status: "ready",
          token: {
            ...fixture,
            source: "fixture" as const,
            tokenAddress: null,
            artworkUrl: null,
            priceUnit: "USD" as const,
            volumeUnit: "USD" as const,
          },
          tradeToken: null,
        }
      : { status: "not_found" };
  }

  const result = await loadLiveTokenPage(slug);
  return result.status === "ready"
    ? {
        status: "ready",
        token: mapLiveTokenToBoardToken(result.payload.token),
        tradeToken: liveTradeIdentity(result.payload.token),
      }
    : result;
}

function liveTradeIdentity(token: LiveMarketToken): TradeTokenIdentity {
  return {
    chainId: token.chainId,
    tokenAddress: token.tokenAddress,
    poolId: token.poolId,
    hookAddress: token.hookAddress,
    configId: token.configId,
    feeMode: token.feeMode,
  };
}

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

function LiveTokenUnavailable({ slug }: { slug: string }) {
  return (
    <main className="inner-page content-width token-page">
      <div className="breadcrumb">
        <Link href="/">Board</Link>
        <span>→</span>
        <span>Market unavailable</span>
      </div>

      <aside className="preview-notice token-notice">
        <span>Live data unavailable</span>
        <p>
          The indexed market could not be loaded within the safe read deadline.
          No fixture token or estimated metric has been substituted.
        </p>
        <Link href="/">Return to Board →</Link>
      </aside>

      <section className="empty-state">
        <Image
          src="/brand/pipedog-cutout.png"
          alt=""
          width={386}
          height={351}
          unoptimized
        />
        <h1>This pipe is temporarily unavailable.</h1>
        <p>
          The token address {slug} is not being presented as missing; the live
          database or indexer read failed. Try again after service recovers.
        </p>
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

  const marketMode = readMarketDataMode();
  const resolution = await resolveToken(slug, marketMode);

  if (resolution.status === "not_found") notFound();
  if (resolution.status === "unavailable") {
    return <LiveTokenUnavailable slug={slug} />;
  }
  const token = resolution.token;
  const changeDirection = tokenChangeDirection(token);

  return (
    <main className="inner-page content-width token-page token-market-page">
      <div className="breadcrumb">
        <Link href="/">Board</Link>
        <span>→</span>
        <span>{token.name}</span>
      </div>

      <aside className="preview-notice token-notice">
        <span>{marketMode === "live" ? "Indexed market" : "Fixture market"}</span>
        <p>
          {marketMode === "live"
            ? "Canonical indexed market data. Wallet trading activates only when the complete configured release manifest matches on-chain; unavailable metrics are never estimated."
            : "This is an interface fixture, not a deployed token or tradeable pool."}
        </p>
        <Link href="/docs#readiness">Why? →</Link>
      </aside>

      <section className="token-hero">
        <div className="token-profile">
          <TokenAvatar token={token} size="xlarge" descriptive />
          <div>
            <span className="demo-chip">
              {marketMode === "live" ? "Live index" : "Fixture coin"}
            </span>
            <h1>{token.name}</h1>
            <p>
              ${token.symbol} · launched {formatAge(token.ageHours)} ago
            </p>
          </div>
        </div>
        <p className="token-description">{token.description}</p>
        <div className="token-price">
          <span>{marketMode === "live" ? "Last indexed price" : "Illustrative price"}</span>
          <strong>{formatTokenPrice(token)}</strong>
          {changeDirection === null ? (
            <em>24h change unavailable</em>
          ) : (
            <em className={changeDirection >= 0 ? "up" : "down"}>
              {formatTokenChange(token)} 24h
            </em>
          )}
        </div>
      </section>

      <div className="token-workspace">
        <section className="token-chart-panel">
          <div className="panel-title">
            <div>
              <span>Price movement</span>
              <strong>24 hours</strong>
            </div>
            <span>{marketMode === "live" ? "Indexed series" : "Fixture series"}</span>
          </div>
          {token.chart.length > 1 ? (
            <Sparkline
              values={token.chart}
              positive={(changeDirection ?? 0) >= 0}
              label={`${token.name} illustrative 24 hour price trend`}
            />
          ) : (
            <p className="market-metric-unavailable">
              Chart history is unavailable until indexed candle aggregation is enabled.
            </p>
          )}
          <div className="chart-axis" aria-hidden="true">
            <span>24h ago</span>
            <span>12h</span>
            <span>Now</span>
          </div>
        </section>

        <TradePanel
          enabled={marketMode === "live"}
          symbol={token.symbol}
          token={resolution.tradeToken}
        />
      </div>

      <section className="token-stat-grid">
        <article>
          <span>Market cap</span>
          <strong>
            {token.marketCap === null ? "Unavailable" : compactMoney(token.marketCap)}
          </strong>
        </article>
        <article>
          <span>24h volume</span>
          <strong>{formatTokenVolume(token)}</strong>
        </article>
        <article>
          <span>Liquidity</span>
          <strong>
            {token.liquidity === null ? "Unavailable" : compactMoney(token.liquidity)}
          </strong>
        </article>
        <article>
          <span>Holders</span>
          <strong>
            {token.holders === null ? "Unavailable" : compactNumber(token.holders)}
          </strong>
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
