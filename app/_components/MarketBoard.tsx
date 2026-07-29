"use client";

import Image from "next/image";
import Link from "next/link";
import {
  type KeyboardEvent,
  useEffect,
  useMemo,
  useState,
} from "react";
import { demoMarketAdapter } from "../_data/adapter";
import {
  LaunchMode,
  LaunchToken,
  marketSource,
  protocolPreviewStats,
} from "../_data/market";
import {
  compactMoney,
  compactNumber,
  formatAge,
  formatMoney,
} from "./format";
import { Sparkline } from "./Sparkline";

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

function rankedToken(tab: FeatureTab, sourceTokens: LaunchToken[]) {
  const tokens = [
    ...(sourceTokens.length > 0 ? sourceTokens : marketSource.tokens),
  ];

  if (tab === "largest") {
    return tokens.sort((a, b) => b.marketCap - a.marketCap)[0];
  }

  if (tab === "newest") {
    return tokens.sort((a, b) => a.ageHours - b.ageHours)[0];
  }

  if (tab === "mover") {
    return tokens.sort((a, b) => b.change24h - a.change24h)[0];
  }

  return tokens.sort(
    (a, b) =>
      b.volume24h * (1 + Math.max(b.change24h, 0) / 100) -
      a.volume24h * (1 + Math.max(a.change24h, 0) / 100),
  )[0];
}

function TokenAvatar({
  token,
  size = "medium",
}: {
  token: LaunchToken;
  size?: "small" | "medium" | "large";
}) {
  return (
    <span
      className={`token-avatar ${size}`}
      style={{ "--token-accent": token.accent } as React.CSSProperties}
      aria-hidden="true"
    >
      {token.symbol.slice(0, 2)}
    </span>
  );
}

function Change({ value }: { value: number }) {
  return (
    <span className={`change ${value >= 0 ? "up" : "down"}`}>
      {value >= 0 ? "+" : ""}
      {value.toFixed(1)}%
    </span>
  );
}

function TokenCard({ token }: { token: LaunchToken }) {
  return (
    <article className="token-card">
      <div className="token-card-top">
        <TokenAvatar token={token} />
        <div>
          <Link href={`/token/${token.slug}`}>{token.name}</Link>
          <span>${token.symbol}</span>
        </div>
        <span className="demo-chip">Demo</span>
      </div>

      <Sparkline
        values={token.chart}
        positive={token.change24h >= 0}
        label={`${token.name} illustrative price trend`}
        compact
      />

      <div className="token-price-line">
        <strong>{formatMoney(token.price)}</strong>
        <Change value={token.change24h} />
      </div>

      <dl className="token-card-stats">
        <div>
          <dt>Market cap</dt>
          <dd>{compactMoney(token.marketCap)}</dd>
        </div>
        <div>
          <dt>24h volume</dt>
          <dd>{compactMoney(token.volume24h)}</dd>
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
  const [featureTab, setFeatureTab] = useState<FeatureTab>("hot");
  const [featurePaused, setFeaturePaused] = useState(false);
  const [tokens, setTokens] = useState<LaunchToken[]>(marketSource.tokens);
  const [refreshState, setRefreshState] = useState<
    "ready" | "refreshing" | "error"
  >("ready");
  const [lastUpdated, setLastUpdated] = useState(marketSource.updatedAt);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortMode>("hot");
  const [mode, setMode] = useState<"all" | LaunchMode>("all");
  const [cap, setCap] = useState<CapFilter>("all");
  const [date, setDate] = useState<DateFilter>("all");
  const [view, setView] = useState<BoardView>("cards");
  const [urlReady, setUrlReady] = useState(false);
  const [page, setPage] = useState(1);

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
        )
      ) {
        setSort(sortValue as SortMode);
      }
      if (["all", "creator", "self-burn"].includes(modeValue ?? "")) {
        setMode(modeValue as "all" | LaunchMode);
      }
      if (["all", "micro", "mid", "large"].includes(capValue ?? "")) {
        setCap(capValue as CapFilter);
      }
      if (["all", "day", "week"].includes(dateValue ?? "")) {
        setDate(dateValue as DateFilter);
      }
      if (params.get("view") === "table") setView("table");
      setUrlReady(true);
    });

    return () => window.cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    if (featurePaused) return;

    const interval = window.setInterval(() => {
      setFeatureTab((current) => {
        const currentIndex = featureTabs.findIndex((tab) => tab.id === current);
        return featureTabs[(currentIndex + 1) % featureTabs.length].id;
      });
    }, 8000);

    return () => window.clearInterval(interval);
  }, [featurePaused]);

  useEffect(() => {
    const refresh = window.setInterval(async () => {
      setRefreshState("refreshing");
      try {
        const result = await demoMarketAdapter.listTokens();
        setTokens(result.tokens);
        setLastUpdated(result.updatedAt);
        setRefreshState("ready");
      } catch {
        setRefreshState("error");
      }
    }, 10000);

    return () => window.clearInterval(refresh);
  }, []);

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
        (cap === "micro" && token.marketCap < 50000) ||
        (cap === "mid" &&
          token.marketCap >= 50000 &&
          token.marketCap < 150000) ||
        (cap === "large" && token.marketCap >= 150000);
      const matchesDate =
        date === "all" ||
        (date === "day" && token.ageHours <= 24) ||
        (date === "week" && token.ageHours <= 168);

      return matchesSearch && matchesMode && matchesCap && matchesDate;
    });

    return matchingTokens.sort((a, b) => {
      if (sort === "market-cap") return b.marketCap - a.marketCap;
      if (sort === "newest") return a.ageHours - b.ageHours;
      if (sort === "volume") return b.volume24h - a.volume24h;
      if (sort === "gainers") return b.change24h - a.change24h;
      return (
        b.volume24h * (1 + Math.max(b.change24h, 0) / 100) -
        a.volume24h * (1 + Math.max(a.change24h, 0) / 100)
      );
    });
  }, [cap, date, mode, search, sort, tokens]);

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
      nextIndex = (tabIndex + 1) % featureTabs.length;
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      nextIndex = (tabIndex - 1 + featureTabs.length) % featureTabs.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = featureTabs.length - 1;
    }

    if (nextIndex === null) return;

    event.preventDefault();
    const nextTab = featureTabs[nextIndex];
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
            Browse fresh launches, see where fees flow, and follow the public
            route from every trade to PIPEDOG buybacks for treasury and the
            0xdead sink.
          </p>
        </div>
        <div className="board-intro-art" aria-label="PIPEDOG in the LayPipe">
          <div className="sun-disc" aria-hidden="true" />
          <div className="pipe-horizon" aria-hidden="true">
            <span />
            <span />
          </div>
          <Image
            src="/brand/laypipe-mark.png"
            alt="PIPEDOG detective sitting inside a green pipe"
            width={540}
            height={540}
            priority
            unoptimized
          />
          <p>fees enter here</p>
        </div>
      </section>

      <section
        className="featured-section content-width"
        onMouseEnter={() => setFeaturePaused(true)}
        onMouseLeave={() => setFeaturePaused(false)}
        onFocusCapture={() => setFeaturePaused(true)}
        onBlurCapture={() => setFeaturePaused(false)}
      >
        <article className="featured-token">
          <header className="featured-header">
            <div className="featured-context">
              <span className="featured-kicker">
                {featureTabs.find((tab) => tab.id === featureTab)?.label} right
                now
              </span>
              <span className="demo-chip">Demo</span>
            </div>

            <div
              className="featured-tabs"
              role="tablist"
              aria-label="Featured token ranking"
            >
              {featureTabs.map((tab, tabIndex) => (
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
                  View demo market
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
                  <span>Illustrative price</span>
                  <strong>{formatMoney(featured.price)}</strong>
                </div>
                <Change value={featured.change24h} />
              </div>
              <Sparkline
                values={featured.chart}
                positive={featured.change24h >= 0}
                label={`${featured.name} illustrative 24 hour price trend`}
              />
              <div className="chart-axis" aria-hidden="true">
                <span>24h ago</span>
                <span>Now</span>
              </div>
            </div>

            <dl className="featured-stats">
              <div>
                <dt>Market cap</dt>
                <dd>{compactMoney(featured.marketCap)}</dd>
              </div>
              <div>
                <dt>24h volume</dt>
                <dd>{compactMoney(featured.volume24h)}</dd>
              </div>
              <div>
                <dt>Liquidity</dt>
                <dd>{compactMoney(featured.liquidity)}</dd>
              </div>
              <div>
                <dt>Holders</dt>
                <dd>{compactNumber(featured.holders)}</dd>
              </div>
            </dl>
          </div>
        </article>
      </section>

      <section className="protocol-strip" aria-label="Protocol preview stats">
        <div className="content-width">
          {protocolPreviewStats.map((stat) => (
            <div key={stat.label}>
              <span>{stat.label}</span>
              <strong>{stat.value}</strong>
              <small>{stat.note}</small>
            </div>
          ))}
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
            <h2>All preview launches</h2>
            <p>
              Sorted, filtered, and ready for the live factory event stream.
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
              <option value="hot">Hot</option>
              <option value="market-cap">Market cap</option>
              <option value="newest">Newest</option>
              <option value="volume">24h volume</option>
              <option value="gainers">Biggest mover</option>
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
            {filteredTokens.length} preview{" "}
            {filteredTokens.length === 1 ? "coin" : "coins"}
          </span>
          <span>
            {refreshState === "refreshing"
              ? "Refreshing demo adapter…"
              : refreshState === "error"
                ? "Adapter refresh failed · showing last snapshot"
                : `Illustrative data · refreshed ${formatRefreshTime(
                    lastUpdated,
                  )}`}
          </span>
        </div>

        {tokens.length === 0 ? (
          <div className="empty-state">
            <Image
              src="/brand/laypipe-mark.png"
              alt=""
              width={140}
              height={140}
              unoptimized
            />
            <h3>The launch feed is empty.</h3>
            <p>The Board will fill as the indexer receives factory events.</p>
          </div>
        ) : visibleTokens.length === 0 ? (
          <div className="empty-state">
            <Image
              src="/brand/laypipe-mark.png"
              alt=""
              width={140}
              height={140}
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
                          <small>${token.symbol} · Demo</small>
                        </span>
                      </Link>
                    </td>
                    <td>{formatMoney(token.price)}</td>
                    <td>
                      <Change value={token.change24h} />
                    </td>
                    <td>{compactMoney(token.marketCap)}</td>
                    <td>{compactMoney(token.volume24h)}</td>
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
      </section>
    </main>
  );
}
