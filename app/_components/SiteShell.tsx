"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ReactNode, useEffect, useMemo, useState } from "react";
import { useMarketData } from "./MarketDataProvider";
import { compactMoney } from "./format";

const CHAIN_ID = 4663;
const CHAIN_HEX = `0x${CHAIN_ID.toString(16)}`;
type Theme = "light" | "dark";

type EthereumProvider = {
  request: (args: {
    method: string;
    params?: Array<Record<string, unknown> | string>;
  }) => Promise<unknown>;
  on?: (event: string, listener: (...args: unknown[]) => void) => void;
  removeListener?: (
    event: string,
    listener: (...args: unknown[]) => void,
  ) => void;
};

declare global {
  interface Window {
    ethereum?: EthereumProvider;
  }
}

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
  const [walletLabel, setWalletLabel] = useState("Connect wallet");
  const [walletBusy, setWalletBusy] = useState(false);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      setTheme(
        document.documentElement.dataset.theme === "dark" ? "dark" : "light",
      );
    });

    return () => window.cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    const provider = window.ethereum;
    if (!provider?.on) return;

    const handleAccounts = (...args: unknown[]) => {
      const accounts = Array.isArray(args[0]) ? (args[0] as string[]) : [];
      setWalletLabel(accounts[0] ? shortAddress(accounts[0]) : "Connect wallet");
    };

    provider.on("accountsChanged", handleAccounts);
    return () => provider.removeListener?.("accountsChanged", handleAccounts);
  }, []);

  function applyTheme(nextTheme: Theme) {
    document.documentElement.dataset.theme = nextTheme;
    localStorage.setItem("laypipe-theme", nextTheme);
    setTheme(nextTheme);
  }

  async function connectWallet() {
    const provider = window.ethereum;
    if (!provider) {
      setWalletLabel("Wallet needed");
      return;
    }

    setWalletBusy(true);
    setWalletLabel("Connecting…");

    try {
      const accounts = (await provider.request({
        method: "eth_requestAccounts",
      })) as string[];

      try {
        await provider.request({
          method: "wallet_switchEthereumChain",
          params: [{ chainId: CHAIN_HEX }],
        });
      } catch (error) {
        if ((error as { code?: number }).code !== 4902) throw error;

        await provider.request({
          method: "wallet_addEthereumChain",
          params: [
            {
              chainId: CHAIN_HEX,
              chainName: "Robinhood Chain",
              nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
              rpcUrls: ["https://rpc.mainnet.chain.robinhood.com"],
              blockExplorerUrls: ["https://robinhoodchain.blockscout.com"],
            },
          ],
        });
      }

      setWalletLabel(
        accounts[0] ? shortAddress(accounts[0]) : "Connect wallet",
      );
    } catch {
      setWalletLabel("Try again");
    } finally {
      setWalletBusy(false);
    }
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
              onClick={connectWallet}
              disabled={walletBusy}
            >
              {walletLabel}
            </button>
          </div>

          <div className="mobile-tools">
            <button
              className="button button-quiet button-small"
              type="button"
              onClick={connectWallet}
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
              ) : [...latestTokens, ...latestTokens].map((token, index) => (
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
                      token.change24h === null
                        ? undefined
                        : token.change24h >= 0
                          ? "up"
                          : "down"
                    }
                  >
                    {token.change24h === null
                      ? "24h unavailable"
                      : `${token.change24h >= 0 ? "+" : ""}${token.change24h.toFixed(1)}%`}
                  </em>
                </Link>
              ))}
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
