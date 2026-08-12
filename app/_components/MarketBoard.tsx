"use client";

import Image from "next/image";
import Link from "next/link";
import {
  type KeyboardEvent,
  useEffect,
  useMemo,
  useState,
} from "react";
import { type BoardToken } from "../_data/adapter";
import { LaunchMode, protocolPreviewStats } from "../_data/market";
import {
  compactMoney,
  compactNumber,
  formatAge,
} from "./format";
import {
  compareTokenChanges,
  compareTokenVolumes,
  formatTokenChange,
  formatTokenPrice,
  formatTokenVolume,
  tokenChangeDirection,
} from "./market-format";
import { Sparkline } from "./Sparkline";
import { TokenAvatar } from "./TokenAvatar";
import { useMarketData } from "./MarketDataProvider";

type FeatureTab = "hot" | "largest" | "newest" | "mover";
type SortMode = "hot" | "market-cap" | "newest" | "volume" | "gainers";
type CapFilter = "all" | "micro" | "mid" | "large";
type DateFilter = "all" | "day" | "week";
type BoardView = "cards" | "table";

const PAGE_SIZE = 20;

function formatRefreshTime(timestamp: string) {
  return `${new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
    timeZone: "UTC",
  }).format(new Date(timestamp))} UTC`;
}

const featureTabs: Array<{ id: FeatureTab; label: string }> = [
  { id: "hot", label: "Hot" },
  { id: "largest", label: "Largest" },
  { id: "newest", label: "Newest" },
  { id: "mover", label: "Biggest mover" },
];

function metric(value: number | null) {
  return value ?? Number.NEGATIVE_INFINITY;
}

function rankedToken(tab: FeatureTab, sourceTokens: BoardToken[]) {
  const tokens = [...sourceTokens];

  if (tab === "largest") {
    return tokens.sort((a, b) => metric(b.marketCap) - metric(a.marketCap))[0];
  }

  if (tab === "newest") {
    return tokens.sort((a, b) => a.ageHours - b.ageHours)[0];
  }

  if (tab === "mover") {
    return tokens.sort((a, b) => compareTokenChanges(b, a))[0];
  }

  return tokens.sort((a, b) => {
    if (a.source === "fixture" && b.source === "fixture") {
      return (
        b.volume24h * (1 + Math.max(b.change24h, 0) / 100) -
        a.volume24h * (1 + Math.max(a.change24h, 0) / 100)
      );
    }
    return b.trades - a.trades;
  })[0];
}

function Change({ token }: { token: BoardToken }) {
  const direction = tokenChangeDirection(token);
  if (direction === null) return <span className="change">Unavailable</span>;
  return (
    <span className={`change ${direction >= 0 ? "up" : "down"}`}>
      {formatTokenChange(token)}
    </span>
  );
}

function TokenCard({ token }: { token: BoardToken }) {
  return (
    <article className="token-card">
      <div className="token-card-top">
        <TokenAvatar token={token} />
        <div>
          <Link href={`/token/${token.slug}`}>{token.name}</Link>
          <span>${token.symbol}</span>
        </div>
        <span className="demo-chip">{token.source === "live" ? "Live" : "Fixture"}</span>
      </div>

      {token.chart.length > 1 ? (
        <Sparkline
          values={token.chart}
          positive={(tokenChangeDirection(token) ?? 0) >= 0}
          label={`${token.name} ${token.source === "live" ? "indexed" : "illustrative"} price trend`}
          compact
        />
      ) : (
        <p className="market-metric-unavailable">Chart unavailable until indexed price history is enabled.</p>
      )}

      <div className="token-price-line">
        <strong>{formatTokenPrice(token)}</strong>
        <Change token={token} />
      </div>

      <dl className="token-card-stats">
        <div>
          <dt>Market cap</dt>
          <dd>{token.marketCap === null ? "Unavailable" : compactMoney(token.marketCap)}</dd>
        </div>
        <div>
          <dt>24h volume</dt>
          <dd>{formatTokenVolume(token)}</dd>
        </div>
        <div>
          <dt>Launched</dt>
          <dd>{formatAge(token.ageHours)} ago</dd>
        </div>
      </dl>

      <div className="token-card-foot">
        <span className={`mode-badge ${token.mode}`}>
          {token.mode === "self-burn" ? "Self-burn" : "Creator fees"}
        </span>
        <Link href={`/token/${token.slug}`}>View coin →</Link>
      </div>
    </article>
  );
}

export function MarketBoard() {
  const {
    hasMore,
    lastUpdated,
    loadMore,
    loadMoreError,
    loadingMore,
    marketMode,
    refreshState,
    tokens,
  } = useMarketData();
  const [featureTab, setFeatureTab] = useState<FeatureTab>("hot");
  const [featurePaused, setFeaturePaused] = useState(false);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortMode>("hot");
  const [mode, setMode] = useState<"all" | LaunchMode>("all");
  const [cap, setCap] = useState<CapFilter>("all");
  const [date, setDate] = useState<DateFilter>("all");
  const [view, setView] = useState<BoardView>("cards");
  const [urlReady, setUrlReady] = useState(false);
  const [page, setPage] = useState(1);
  const visibleFeatureTabs = useMemo(
    () =>
      marketMode === "live"
        ? [
            { id: "hot" as const, label: "Most traded" },
            { id: "newest" as const, label: "Newest" },
            { id: "mover" as const, label: "Biggest mover" },
          ]
        : featureTabs,
    [marketMode],
  );

  const featured = useMemo(
    () => rankedToken(featureTab, tokens),
    [featureTab, tokens],
  );

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const params = new URLSearchParams(window.location.search);
      const sortValue = params.get("sort");
      const modeValue = params.get("mode");
      const capValue = params.get("mcap");
      const dateValue = params.get("age");

      setSearch(params.get("q") ?? "");
      if (
        ["hot", "market-cap", "newest", "volume", "gainers"].includes(
          sortValue ?? "",
        ) &&
        !(
          marketMode === "live" &&
          sortValue === "market-cap"
        )
      ) {
        setSort(sortValue as SortMode);
      }
      if (["all", "creator", "self-burn"].includes(modeValue ?? "")) {
        setMode(modeValue as "all" | LaunchMode);
      }
      if (
        marketMode === "fixture" &&
        ["all", "micro", "mid", "large"].includes(capValue ?? "")
      ) {
        setCap(capValue as CapFilter);
      }
      if (["all", "day", "week"].includes(dateValue ?? "")) {
        setDate(dateValue as DateFilter);
      }
      if (params.get("view") === "table") setView("table");
      setUrlReady(true);
    });

    return () => window.cancelAnimationFrame(frame);
  }, [marketMode]);

  useEffect(() => {
    if (featurePaused) return;

    const interval = window.setInterval(() => {
      setFeatureTab((current) => {
        const currentIndex = visibleFeatureTabs.findIndex((tab) => tab.id === current);
        return visibleFeatureTabs[(currentIndex + 1) % visibleFeatureTabs.length].id;
      });
    }, 8000);

    return () => window.clearInterval(interval);
  }, [featurePaused, visibleFeatureTabs]);

  useEffect(() => {
    if (!urlReady) return;

    const params = new URLSearchParams(window.location.search);
    const setOrDelete = (key: string, value: string, fallback: string) => {
      if (value === fallback || !value) params.delete(key);
      else params.set(key, value);
    };

    setOrDelete("q", search, "");
    setOrDelete("sort", sort, "hot");
    setOrDelete("mode", mode, "all");
    setOrDelete("mcap", cap, "all");
    setOrDelete("age", date, "all");
    setOrDelete("view", view, "cards");

    const nextQuery = params.toString();
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${nextQuery ? `?${nextQuery}` : ""}`,
    );
  }, [cap, date, mode, search, sort, urlReady, view]);

  const filteredTokens = useMemo(() => {
    const normalizedSearch = search.trim().toLowerCase();
    const matchingTokens = tokens.filter((token) => {
      const matchesSearch =
        !normalizedSearch ||
        token.name.toLowerCase().includes(normalizedSearch) ||
        token.symbol.toLowerCase().includes(normalizedSearch);
      const matchesMode = mode === "all" || token.mode === mode;
      const matchesCap =
        cap === "all" ||
        (token.marketCap !== null && cap === "micro" && token.marketCap < 50000) ||
        (cap === "mid" &&
          token.marketCap !== null &&
          token.marketCap >= 50000 &&
          token.marketCap < 150000) ||
        (token.marketCap !== null && cap === "large" && token.marketCap >= 150000);
      const matchesDate =
        date === "all" ||
        (date === "day" && token.ageHours <= 24) ||
        (date === "week" && token.ageHours <= 168);

      return matchesSearch && matchesMode && matchesCap && matchesDate;
    });

    return matchingTokens.sort((a, b) => {
      if (sort === "market-cap") return metric(b.marketCap) - metric(a.marketCap);
      if (sort === "newest") return a.ageHours - b.ageHours;
      if (sort === "volume") return compareTokenVolumes(b, a);
      if (sort === "gainers") return compareTokenChanges(b, a);
      if (marketMode === "live") return b.trades - a.trades;
      if (a.source === "fixture" && b.source === "fixture") {
        return (
          b.volume24h * (1 + Math.max(b.change24h, 0) / 100) -
          a.volume24h * (1 + Math.max(a.change24h, 0) / 100)
        );
      }
      return b.trades - a.trades;
    });
  }, [cap, date, marketMode, mode, search, sort, tokens]);

  const pageCount = Math.max(1, Math.ceil(filteredTokens.length / PAGE_SIZE));
  const visibleTokens = filteredTokens.slice(
    (page - 1) * PAGE_SIZE,
    page * PAGE_SIZE,
  );

  function handleFeatureTabKeyDown(
    event: KeyboardEvent<HTMLButtonElement>,
    tabIndex: number,
  ) {
    let nextIndex: number | null = null;

    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      nextIndex = (tabIndex + 1) % visibleFeatureTabs.length;
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      nextIndex = (tabIndex - 1 + visibleFeatureTabs.length) % visibleFeatureTabs.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = visibleFeatureTabs.length - 1;
    }

    if (nextIndex === null) return;

    event.preventDefault();
    const nextTab = visibleFeatureTabs[nextIndex];
    setFeatureTab(nextTab.id);
    event.currentTarget
      .closest('[role="tablist"]')
      ?.querySelectorAll<HTMLButtonElement>('[role="tab"]')
      [nextIndex]?.focus();
  }

  return (
    <main>
      <section className="board-intro content-width">
        <div className="board-intro-copy">
          <p className="eyebrow">THE ROBINHOOD CHAIN PIPELINE</p>
          <h1>LAY SOME PIPE, DOG.</h1>
          <p>
            Browse fresh launches and trade every curve in PIPEDOG. The 0.3%
            protocol lane routes 25% to 0xdead, 25% to treasury, and 50% to
            operations.
          </p>
        </div>
        <div
          className="board-intro-art"
          aria-label="PIPEDOG seated inside a green pipe connected to a burn furnace"
        >
          <Image
            className="board-intro-scene"
            src="/brand/pipedog-furnace.png"
            alt="PIPEDOG sitting fully inside a green pipe connected to a lit furnace"
            width={1538}
            height={1023}
            priority
            unoptimized
          />
          <p>PIPEDOG in · 25% to 0xdead</p>
        </div>
      </section>

      <section
        className="featured-section content-width"
        onMouseEnter={() => setFeaturePaused(true)}
        onMouseLeave={() => setFeaturePaused(false)}
        onFocusCapture={() => setFeaturePaused(true)}
        onBlurCapture={() => setFeaturePaused(false)}
      >
        {featured ? (
          <article className="featured-token">
          <header className="featured-header">
            <div className="featured-context">
              <span className="featured-kicker">
                {visibleFeatureTabs.find((tab) => tab.id === featureTab)?.label} right
                now
              </span>
              <span className="demo-chip">
                {marketMode === "live" ? "Live index" : "Fixture"}
              </span>
            </div>

            <div
              className="featured-tabs"
              role="tablist"
              aria-label="Featured token ranking"
            >
              {visibleFeatureTabs.map((tab, tabIndex) => (
                <button
                  id={`feature-tab-${tab.id}`}
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-controls="featured-market-panel"
                  aria-selected={featureTab === tab.id}
                  tabIndex={featureTab === tab.id ? 0 : -1}
                  onClick={() => setFeatureTab(tab.id)}
                  onKeyDown={(event) =>
                    handleFeatureTabKeyDown(event, tabIndex)
                  }
                >
                  {tab.label}
                </button>
              ))}
            </div>
          </header>

          <div
            id="featured-market-panel"
            className="featured-body"
            role="tabpanel"
            aria-labelledby={`feature-tab-${featureTab}`}
          >
            <div className="featured-identity">
              <div className="featured-name">
                <TokenAvatar token={featured} size="large" />
                <div>
                  <h2>{featured.name}</h2>
                  <p>${featured.symbol}</p>
                </div>
              </div>
              <p>{featured.description}</p>
              <div className="featured-actions">
                <Link
                  className="button button-accent"
                  href={`/token/${featured.slug}`}
                >
                  {marketMode === "live" ? "View indexed market" : "View fixture market"}
                </Link>
                <span className={`mode-badge ${featured.mode}`}>
                  {featured.mode === "self-burn"
                    ? "Self-burn mode"
                    : "Creator-fee mode"}
                </span>
              </div>
            </div>

            <div className="featured-chart">
              <div className="chart-heading">
                <div>
                  <span>
                    {marketMode === "live" ? "Last indexed price" : "Illustrative price"}
                  </span>
                  <strong>{formatTokenPrice(featured)}</strong>
                </div>
                <Change token={featured} />
              </div>
              {featured.chart.length > 1 ? (
                <Sparkline
                  values={featured.chart}
                  positive={(tokenChangeDirection(featured) ?? 0) >= 0}
                  label={`${featured.name} illustrative 24 hour price trend`}
                />
              ) : (
                <p className="market-metric-unavailable">
                  Price history is unavailable until chart indexing is enabled.
                </p>
              )}
              <div className="chart-axis" aria-hidden="true">
                <span>24h ago</span>
                <span>Now</span>
              </div>
            </div>

            <dl className="featured-stats">
              <div>
                <dt>Market cap</dt>
                <dd>
                  {featured.marketCap === null
                    ? "Unavailable"
                    : compactMoney(featured.marketCap)}
                </dd>
              </div>
              <div>
                <dt>24h volume</dt>
                <dd>{formatTokenVolume(featured)}</dd>
              </div>
              <div>
                <dt>Liquidity</dt>
                <dd>
                  {featured.liquidity === null
                    ? "Unavailable"
                    : compactMoney(featured.liquidity)}
                </dd>
              </div>
              <div>
                <dt>Holders</dt>
                <dd>
                  {featured.holders === null
                    ? "Unavailable"
                    : compactNumber(featured.holders)}
                </dd>
              </div>
            </dl>
          </div>
          </article>
        ) : (
          <article className="featured-token empty-state">
            <h2>{refreshState === "refreshing" ? "Loading the live pipe…" : "No indexed launches yet."}</h2>
            <p>
              {refreshState === "error"
                ? "The live market API is unavailable. Fixture data was not substituted."
                : "This space fills only from verified LayPipe factory events."}
            </p>
          </article>
        )}
      </section>

      <section className="protocol-strip" aria-label="Protocol preview stats">
        <div className="content-width">
          {marketMode === "fixture" ? (
            protocolPreviewStats.map((stat) => (
              <div key={stat.label}>
                <span>{stat.label}</span>
                <strong>{stat.value}</strong>
                <small>{stat.note}</small>
              </div>
            ))
          ) : (
            <>
              <div>
                <span>Indexed launches</span>
                <strong>{tokens.length}</strong>
                <small>current API page</small>
              </div>
              <div>
                <span>Market feed</span>
                <strong>{refreshState === "ready" ? "Live" : refreshState}</strong>
                <small>no fixture fallback</small>
              </div>
              <div>
                <span>USD market cap</span>
                <strong>Unavailable</strong>
                <small>no trusted price oracle</small>
              </div>
              <div>
                <span>Holder count</span>
                <strong>Unavailable</strong>
                <small>aggregation not enabled</small>
              </div>
            </>
          )}
          <div className="protocol-mark">
            <Image
              src="/brand/pipedog.png"
              alt=""
              width={72}
              height={66}
              unoptimized
            />
            <p>
              <strong>PIPEDOG lane</strong>
              <span>Router deployment pending</span>
            </p>
          </div>
        </div>
      </section>

      <section className="board-section content-width">
        <div className="section-title-row">
          <div>
            <p className="eyebrow">THE BOARD</p>
            <h2>{marketMode === "live" ? "Indexed launches" : "Fixture launches"}</h2>
            <p>
              {marketMode === "live"
                ? "Read-only markets from the canonical Robinhood Chain index."
                : "Illustrative fixtures for interface preview only."}
            </p>
          </div>
          <Link className="button button-accent" href="/launch">
            + Launch a coin
          </Link>
        </div>

        <div className="board-controls">
          <label className="search-control">
            <span className="visually-hidden">Search tokens</span>
            <i aria-hidden="true">⌕</i>
            <input
              type="search"
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setPage(1);
              }}
              placeholder="Search name or ticker"
            />
          </label>

          <label>
            <span>Sort</span>
            <select
              value={sort}
              onChange={(event) => {
                setSort(event.target.value as SortMode);
                setPage(1);
              }}
            >
              <option value="hot">
                {marketMode === "live" ? "Most traded" : "Hot"}
              </option>
              <option value="market-cap" disabled={marketMode === "live"}>
                Market cap{marketMode === "live" ? " (unavailable)" : ""}
              </option>
              <option value="newest">Newest</option>
              <option value="volume">24h volume</option>
              <option value="gainers">
                Biggest mover
              </option>
            </select>
          </label>

          <label>
            <span>Launch mode</span>
            <select
              value={mode}
              onChange={(event) => {
                setMode(event.target.value as "all" | LaunchMode);
                setPage(1);
              }}
            >
              <option value="all">All modes</option>
              <option value="creator">Creator fees</option>
              <option value="self-burn">Self-burn</option>
            </select>
          </label>

          <label>
            <span>Market cap</span>
            <select
              value={cap}
              disabled={marketMode === "live"}
              onChange={(event) => {
                setCap(event.target.value as CapFilter);
                setPage(1);
              }}
            >
              <option value="all">Any size</option>
              <option value="micro">Under $50K</option>
              <option value="mid">$50K–$150K</option>
              <option value="large">$150K+</option>
            </select>
          </label>

          <label>
            <span>Launch date</span>
            <select
              value={date}
              onChange={(event) => {
                setDate(event.target.value as DateFilter);
                setPage(1);
              }}
            >
              <option value="all">Any time</option>
              <option value="day">Past 24 hours</option>
              <option value="week">Past 7 days</option>
            </select>
          </label>

          <div className="view-toggle" role="group" aria-label="Board view">
            <button
              type="button"
              aria-pressed={view === "cards"}
              onClick={() => {
                setView("cards");
                setPage(1);
              }}
            >
              Cards
            </button>
            <button
              type="button"
              aria-pressed={view === "table"}
              onClick={() => {
                setView("table");
                setPage(1);
              }}
            >
              Table
            </button>
          </div>
        </div>

        <div className="results-meta" aria-live="polite">
          <span>
            {filteredTokens.length} {marketMode === "live" ? "indexed" : "fixture"}{" "}
            {filteredTokens.length === 1 ? "coin" : "coins"}
          </span>
          <span>
            {refreshState === "refreshing"
              ? `Refreshing ${marketMode === "live" ? "live index" : "fixture adapter"}…`
              : refreshState === "error"
                ? marketMode === "live"
                  ? "Live API unavailable · no fixture fallback"
                  : "Fixture refresh failed · showing last fixture snapshot"
                : lastUpdated
                  ? `${marketMode === "live" ? "Indexer watermark" : "Fixture data"} · ${formatRefreshTime(lastUpdated)}`
                  : "Live index connected · watermark unavailable"}
          </span>
        </div>

        {tokens.length === 0 ? (
          <div className="empty-state">
            <Image
              src="/brand/pipedog-cutout.png"
              alt=""
              width={386}
              height={351}
              unoptimized
            />
            <h3>The launch feed is empty.</h3>
            <p>
              {marketMode === "live" && refreshState === "error"
                ? "The live API failed. No fixture coins are shown in live mode."
                : "The Board will fill as the indexer receives factory events."}
            </p>
          </div>
        ) : visibleTokens.length === 0 ? (
          <div className="empty-state">
            <Image
              src="/brand/pipedog-cutout.png"
              alt=""
              width={386}
              height={351}
              unoptimized
            />
            <h3>No matching coins.</h3>
            <p>Clear a filter or try a different ticker.</p>
            <button
              className="button button-quiet"
              type="button"
              onClick={() => {
                setSearch("");
                setMode("all");
                setCap("all");
                setDate("all");
              }}
            >
              Clear filters
            </button>
          </div>
        ) : view === "cards" ? (
          <div className="token-grid">
            {visibleTokens.map((token) => (
              <TokenCard key={token.slug} token={token} />
            ))}
          </div>
        ) : (
          <div className="token-table-wrap">
            <table className="token-table">
              <thead>
                <tr>
                  <th scope="col">Coin</th>
                  <th scope="col">Price</th>
                  <th scope="col">24h</th>
                  <th scope="col">Market cap</th>
                  <th scope="col">Volume</th>
                  <th scope="col">Mode</th>
                  <th scope="col">Age</th>
                </tr>
              </thead>
              <tbody>
                {visibleTokens.map((token) => (
                  <tr key={token.slug}>
                    <td>
                      <Link
                        className="table-token"
                        href={`/token/${token.slug}`}
                      >
                        <TokenAvatar token={token} size="small" />
                        <span>
                          <strong>{token.name}</strong>
                          <small>
                            ${token.symbol} · {token.source === "live" ? "Live" : "Fixture"}
                          </small>
                        </span>
                      </Link>
                    </td>
                    <td>{formatTokenPrice(token)}</td>
                    <td>
                      <Change token={token} />
                    </td>
                    <td>
                      {token.marketCap === null
                        ? "Unavailable"
                        : compactMoney(token.marketCap)}
                    </td>
                    <td>{formatTokenVolume(token)}</td>
                    <td>
                      <span className={`mode-badge ${token.mode}`}>
                        {token.mode === "self-burn" ? "Self-burn" : "Creator"}
                      </span>
                    </td>
                    <td>{formatAge(token.ageHours)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {filteredTokens.length > PAGE_SIZE && (
          <nav className="pagination" aria-label="Board pagination">
            <button
              type="button"
              onClick={() => setPage((value) => Math.max(1, value - 1))}
              disabled={page === 1}
            >
              ← Previous
            </button>
            <span>
              Page {page} of {pageCount}
            </span>
            <button
              type="button"
              onClick={() =>
                setPage((value) => Math.min(pageCount, value + 1))
              }
              disabled={page === pageCount}
            >
              Next →
            </button>
          </nav>
        )}

        {marketMode === "live" && (hasMore || loadMoreError) ? (
          <div className="market-load-more" aria-live="polite">
            {hasMore ? (
              <button
                className="button button-quiet"
                type="button"
                disabled={loadingMore || refreshState === "refreshing"}
                onClick={() => void loadMore()}
              >
                {loadingMore ? "Loading indexed launches…" : "Load more indexed launches"}
              </button>
            ) : null}
            {loadMoreError ? (
              <p>The next indexed page could not be loaded. Try again.</p>
            ) : null}
          </div>
        ) : null}
      </section>
    </main>
  );
}
