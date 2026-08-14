"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { type ReactNode, useState } from "react";
import { useWallet } from "./WalletProvider";

const navigation = [
  { href: "/#trade", currentPath: "/", label: "Trade" },
  { href: "/my", currentPath: "/my", label: "My PipeDogs" },
  { href: "/rewards", currentPath: "/rewards", label: "Rewards" },
  { href: "/tokenomics", currentPath: "/tokenomics", label: "Mechanics" },
  { href: "/lore", currentPath: "/lore", label: "Lore" },
  { href: "/docs", currentPath: "/docs", label: "Docs" },
];

function shortAddress(address: string) {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

export function SiteShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
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
                aria-current={pathname === item.currentPath ? "page" : undefined}
              >
                {item.label}
              </Link>
            ))}
          </nav>

          <div className="header-tools">
            <button
              className="button button-accent button-small"
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

        {menuOpen ? (
          <div className="mobile-menu">
            <nav aria-label="Mobile navigation">
              {navigation.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={pathname === item.currentPath ? "page" : undefined}
                  onClick={() => setMenuOpen(false)}
                >
                  {item.label}
                </Link>
              ))}
            </nav>
          </div>
        ) : null}

        <div className="singleton-bar" aria-label="LayPipe protocol constants">
          <span><strong>1B</strong> fixed LAYPIPE</span>
          <i aria-hidden="true" />
          <span><strong>100,000</strong> LAYPIPE per PipeDog</span>
          <i aria-hidden="true" />
          <span><strong>1%</strong> PIPEDOG fee to NFT holders</span>
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
          />
          <div>
            <strong>laypipe.fun</strong>
            <p>LayPipe. Get PipeDog. Claim PIPEDOG.</p>
          </div>
        </div>
        <nav aria-label="Footer navigation">
          <Link href="/#trade">Trade</Link>
          <Link href="/my">My PipeDogs</Link>
          <Link href="/rewards">Rewards</Link>
          <Link href="/tokenomics">Mechanics</Link>
          <Link href="/lore">Lore</Link>
          <a href="https://pipedog.xyz" target="_blank" rel="noreferrer">
            pipedog.xyz
          </a>
        </nav>
        <p className="footer-risk">
          Contract preview. LAYPIPE trading, NFT mirroring, and PIPEDOG claims
          remain disabled until the singleton deployment is configured.
        </p>
      </footer>
    </div>
  );
}
