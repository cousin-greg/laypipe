"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ReactNode, useEffect, useMemo, useState } from "react";
import { useMarketData } from "./MarketDataProvider";
import { useWallet } from "./WalletProvider";
import { compactMoney } from "./format";
import { formatTokenChange, tokenChangeDirection } from "./market-format";

type Theme = "light" | "dark";

const navigation = [
  { href: "/", label: "Board" },
  { href: "/my", label: "My tokens" },
  { href: "/rewards", label: "Rewards" },
  { href: "/tokenomics", label: "Tokenomics" },
  { href: "/docs", label: "Docs" },
];

function shortAddress(address: string) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function SiteShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { marketMode, refreshState, tokens } = useMarketData();
  const latestTokens = useMemo(() => tokens.slice(0, 16), [tokens]);
  const feedState = refreshState === "error" ? "error" : "ready";
  const [theme, setTheme] = useState<Theme>("light");
  const [menuOpen, setMenuOpen] = useState(false);
  const { account, status: walletStatus, connect: connectWallet } = useWallet();
  const walletBusy = walletStatus === "connecting";
  const walletLabel = walletStatus === "wrong-chain"
    ? "Switch chain"
    : account
      ? shortAddress(account)
      : walletStatus === "connecting"
      ? "Connecting..."
      : walletStatus === "missing"
        ? "Wallet needed"
        : walletStatus === "error"
            ? "Try again"
            : "Connect wallet";

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      setTheme(
        document.documentElement.dataset.theme === "dark" ? "dark" : "light",
      );
    });

    return () => window.cancelAnimationFrame(frame);
  }, []);

  function applyTheme(nextTheme: Theme) {
    document.documentElement.dataset.theme = nextTheme;
    localStorage.setItem("laypipe-theme", nextTheme);
    setTheme(nextTheme);
  }

  return (
    <div className="site-frame">
      <header className="app-header">
        <div className="header-main">
          <Link className="brand-lockup" href="/" aria-label="laypipe.fun home">
            <Image
              src="/brand/pipedog-pipe-mark.png"
              alt=""
              width={512}
              height={512}
              priority
              unoptimized
            />
            <span className="brand-type">
              laypipe<span>.fun</span>
            </span>
          </Link>

          <span className="chain-badge">
            <i aria-hidden="true" />
            Robinhood Chain
          </span>

          <nav className="primary-nav" aria-label="Primary navigation">
            {navigation.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                aria-current={pathname === item.href ? "page" : undefined}
              >
                {item.label}
              </Link>
            ))}
          </nav>

          <div className="header-tools">
            <div className="theme-switcher" aria-label="Color scheme">
              <button
                type="button"
                aria-pressed={theme === "light"}
                onClick={() => applyTheme("light")}
              >
                Light
              </button>
              <button
                type="button"
                aria-pressed={theme === "dark"}
                onClick={() => applyTheme("dark")}
              >
                Dark
              </button>
            </div>
            <Link className="button button-accent button-small" href="/launch">
              Launch a coin
            </Link>
            <button
              className="button button-quiet button-small"
              type="button"
              onClick={() => void connectWallet()}
              disabled={walletBusy}
            >
              {walletLabel}
            </button>
          </div>

          <div className="mobile-tools">
            <button
              className="button button-quiet button-small"
              type="button"
              onClick={() => void connectWallet()}
              disabled={walletBusy}
            >
              {walletLabel}
            </button>
            <button
              className="menu-button"
              type="button"
              aria-label={menuOpen ? "Close menu" : "Open menu"}
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((open) => !open)}
            >
              <span />
              <span />
              <span />
            </button>
          </div>
        </div>

        {menuOpen && (
          <div className="mobile-menu">
            <nav aria-label="Mobile navigation">
              {navigation.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={pathname === item.href ? "page" : undefined}
                  onClick={() => setMenuOpen(false)}
                >
                  {item.label}
                </Link>
              ))}
              <Link href="/launch" onClick={() => setMenuOpen(false)}>
                Launch a coin
              </Link>
            </nav>
            <div className="theme-switcher" aria-label="Color scheme">
              <button
                type="button"
                aria-pressed={theme === "light"}
                onClick={() => applyTheme("light")}
              >
                Light
              </button>
              <button
                type="button"
                aria-pressed={theme === "dark"}
                onClick={() => applyTheme("dark")}
              >
                Dark
              </button>
            </div>
          </div>
        )}

        <div
          className="launch-marquee"
          aria-label={marketMode === "live" ? "Latest indexed launches" : "Latest fixture launches"}
        >
          <span className="marquee-label">Latest</span>
          <div className="marquee-window">
            <div className={`marquee-track ${latestTokens.length === 0 ? "empty" : ""}`}>
              {latestTokens.length === 0 ? (
                <span className="marquee-empty">
                  {feedState === "error" ? "Live feed unavailable" : "Waiting for indexed launches"}
                </span>
              ) : [...latestTokens, ...latestTokens].map((token, index) => {
                const changeDirection = tokenChangeDirection(token);
                return (
                  <Link
                    href={`/token/${token.slug}`}
                    key={`${token.slug}-${index}`}
                    aria-hidden={index >= latestTokens.length}
                    tabIndex={index >= latestTokens.length ? -1 : undefined}
                  >
                    <i style={{ background: token.accent }} aria-hidden="true" />
                    <strong>${token.symbol}</strong>
                    <span>
                      {token.marketCap === null ? "Market cap unavailable" : compactMoney(token.marketCap)}
                    </span>
                    <em
                      className={
                        changeDirection === null
                          ? undefined
                          : changeDirection >= 0
                            ? "up"
                            : "down"
                      }
                    >
                      {changeDirection === null
                        ? "24h unavailable"
                        : formatTokenChange(token)}
                    </em>
                  </Link>
                );
              })}
            </div>
          </div>
          <span className="preview-tag">
            {marketMode === "live" ? "Live index" : "Fixture feed"}
          </span>
        </div>
      </header>

      <div className="page-shell">{children}</div>

      <footer className="app-footer">
        <div className="footer-brand">
          <Image
            src="/brand/pipedog-pipe-mark.png"
            alt=""
            width={512}
            height={512}
            unoptimized
          />
          <div>
            <strong>laypipe.fun</strong>
            <p>Launches trade in PIPEDOG. The protocol route is direct.</p>
          </div>
        </div>
        <nav aria-label="Footer navigation">
          <Link href="/">Board</Link>
          <Link href="/launch">Launch</Link>
          <Link href="/tokenomics">Tokenomics</Link>
          <Link href="/docs">Docs</Link>
          <a href="https://pipedog.xyz" target="_blank" rel="noreferrer">
            pipedog.xyz ↗
          </a>
        </nav>
        <p className="footer-risk">
          {marketMode === "live"
            ? "Live indexed markets. Verify contracts before trading. Memecoins can go to zero."
            : "Fixture interface. Sample coins are not deployed. Memecoins can go to zero."}
        </p>
      </footer>
    </div>
  );
}
