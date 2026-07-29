"use client";

import Image from "next/image";
import { FormEvent, useEffect, useMemo, useState } from "react";

const PIPEDOG_CA = "0x5Cb6F181081301b44905F3ae15419112ecaBd8A6";
const CHAIN_ID = 4663;
const CHAIN_HEX = `0x${CHAIN_ID.toString(16)}`;
const UNISWAP_URL =
  "https://app.uniswap.org/explore/tokens/robinhood/0x5Cb6F181081301b44905F3ae15419112ecaBd8A6";
const EXPLORER_URL = `https://robinhoodchain.blockscout.com/token/${PIPEDOG_CA}`;
const DEXSCREENER_URL =
  "https://dexscreener.com/robinhood/0xb7f10f74b39291b9290b779978e19a7637c742d6";

type MarketStats = {
  price: number | null;
  marketCap: number | null;
  volume24h: number | null;
  holders: number | null;
  supply: number | null;
};

type BlockscoutToken = {
  decimals?: string;
  total_supply?: string;
  exchange_rate?: string;
  circulating_market_cap?: string;
  volume_24h?: string;
  holders_count?: string | number;
};

type DexPair = {
  priceUsd?: string;
  marketCap?: number;
  liquidity?: { usd?: number };
  volume?: { h24?: number };
};

type DexResponse = {
  pairs?: DexPair[];
};

type EthereumProvider = {
  request: (args: {
    method: string;
    params?: Array<Record<string, unknown> | string>;
  }) => Promise<unknown>;
};

declare global {
  interface Window {
    ethereum?: EthereumProvider;
  }
}

function compact(value: number | null, prefix = "") {
  if (value === null) return "—";
  return `${prefix}${Intl.NumberFormat("en", {
    notation: "compact",
    maximumFractionDigits: 2,
  }).format(value)}`;
}

function price(value: number | null) {
  if (value === null) return "—";
  return `$${value < 0.01 ? value.toFixed(6) : value.toFixed(4)}`;
}

function shortAddress(address: string) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export default function Home() {
  const [stats, setStats] = useState<MarketStats>({
    price: null,
    marketCap: null,
    volume24h: null,
    holders: null,
    supply: null,
  });
  const [marketState, setMarketState] = useState("fetching live pipe data");
  const [walletState, setWalletState] = useState("Connect wallet");
  const [copied, setCopied] = useState(false);
  const [launchMode, setLaunchMode] = useState<"creator" | "burn">("burn");
  const [coinName, setCoinName] = useState("");
  const [ticker, setTicker] = useState("");
  const [initialBuy, setInitialBuy] = useState("0.05");
  const [showReview, setShowReview] = useState(false);

  useEffect(() => {
    let active = true;

    async function loadMarket() {
      try {
        const [tokenResponse, dexResponse] = await Promise.all([
          fetch(
            `https://robinhoodchain.blockscout.com/api/v2/tokens/${PIPEDOG_CA}`,
          ),
          fetch(`https://api.dexscreener.com/latest/dex/tokens/${PIPEDOG_CA}`),
        ]);

        if (!tokenResponse.ok || !dexResponse.ok) {
          throw new Error("Market data unavailable");
        }

        const token = (await tokenResponse.json()) as BlockscoutToken;
        const dex = (await dexResponse.json()) as DexResponse;
        const pairs = Array.isArray(dex.pairs) ? dex.pairs : [];
        const bestPair = [...pairs].sort(
          (a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0),
        )[0];
        const decimals = Number(token.decimals ?? 18);
        const totalSupply =
          Number(token.total_supply ?? 0) / Math.pow(10, decimals);

        if (!active) return;
        setStats({
          price: Number(bestPair?.priceUsd ?? token.exchange_rate) || null,
          marketCap:
            Number(bestPair?.marketCap ?? token.circulating_market_cap) || null,
          volume24h:
            Number(bestPair?.volume?.h24 ?? token.volume_24h) || null,
          holders: Number(token.holders_count) || null,
          supply: totalSupply || null,
        });
        setMarketState("live from Robinhood Chain");
      } catch {
        if (active) setMarketState("refresh unavailable");
      }
    }

    loadMarket();
    return () => {
      active = false;
    };
  }, []);

  const launchTaxCopy = useMemo(
    () =>
      launchMode === "burn"
        ? "0.7% buys and burns your coin"
        : "0.7% streams to your wallet",
    [launchMode],
  );

  async function connectWallet() {
    if (!window.ethereum) {
      setWalletState("Install a wallet");
      return;
    }

    try {
      setWalletState("Connecting…");
      const accounts = (await window.ethereum.request({
        method: "eth_requestAccounts",
      })) as string[];
      const account = accounts?.[0] ?? "";

      try {
        await window.ethereum.request({
          method: "wallet_switchEthereumChain",
          params: [{ chainId: CHAIN_HEX }],
        });
      } catch (error) {
        const code = (error as { code?: number }).code;
        if (code === 4902) {
          await window.ethereum.request({
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
      }

      setWalletState(account ? shortAddress(account) : "Connect wallet");
    } catch {
      setWalletState("Try again");
    }
  }

  async function copyContract() {
    try {
      await navigator.clipboard.writeText(PIPEDOG_CA);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  }

  function reviewLaunch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setShowReview(true);
  }

  return (
    <main>
      <header className="site-header">
        <a className="brand" href="#top" aria-label="laypipe.fun home">
          <span className="brand-mark" aria-hidden="true">
            ?
          </span>
          <span>laypipe.fun</span>
        </a>
        <nav className="desktop-nav" aria-label="Main navigation">
          <a href="#launch">Launch</a>
          <a href="#pipeworks">Pipeworks</a>
          <a href="#docs">Docs</a>
        </nav>
        <div className="header-actions">
          <a
            className="text-link"
            href={UNISWAP_URL}
            target="_blank"
            rel="noreferrer"
          >
            Buy PIPEDOG ↗
          </a>
          <button className="wallet-button" onClick={connectWallet}>
            {walletState}
          </button>
        </div>
      </header>

      <section className="hero" id="top">
        <div className="sun-orbit sun-orbit-one" aria-hidden="true" />
        <div className="sun-orbit sun-orbit-two" aria-hidden="true" />
        <div className="hero-copy">
          <p className="eyebrow">
            ROBINHOOD CHAIN · UNISWAP V4 · PERMISSIONLESS
          </p>
          <h1>
            Fees in.
            <br />
            <span>PIPEDOG burns.</span>
          </h1>
          <p className="hero-lede">
            Launch a coin, lock its liquidity, and route protocol fees through
            a public pipe that buys and burns PIPEDOG forever.
          </p>
          <div className="hero-actions">
            <a className="primary-button" href="#launch">
              Launch into the pipe
            </a>
            <a className="secondary-button" href="#pipeworks">
              See how it flows ↓
            </a>
          </div>
          <button
            className="contract-pill"
            onClick={copyContract}
            aria-label="Copy PIPEDOG contract address"
          >
            <span>CA</span>
            <code>{shortAddress(PIPEDOG_CA)}</code>
            <strong>{copied ? "Copied!" : "Copy"}</strong>
          </button>
        </div>

        <div className="hero-art" aria-label="PIPEDOG inside the pipeworks">
          <div className="cloud cloud-one" />
          <div className="cloud cloud-two" />
          <div className="question-cloud">???</div>
          <div className="hero-pipe">
            <div className="pipe-rim" />
            <div className="pipe-body" />
            <Image
              className="hero-dog"
              src="/brand/pipedog.png"
              alt="PIPEDOG dressed as a detective with a pipe"
              width={385}
              height={351}
              priority
            />
          </div>
          <div className="side-pipe side-pipe-left" />
          <div className="side-pipe side-pipe-right" />
          <div className="pipe-flame">✦</div>
          <p className="art-note">very curious. yes.</p>
        </div>
      </section>

      <section className="market-strip" aria-label="Live PIPEDOG market data">
        <div>
          <span>Price</span>
          <strong>{price(stats.price)}</strong>
        </div>
        <div>
          <span>Market cap</span>
          <strong>{compact(stats.marketCap, "$")}</strong>
        </div>
        <div>
          <span>24h volume</span>
          <strong>{compact(stats.volume24h, "$")}</strong>
        </div>
        <div>
          <span>Holders</span>
          <strong>{compact(stats.holders)}</strong>
        </div>
        <p>
          <i />
          {marketState}
        </p>
      </section>

      <section className="section pipeworks" id="pipeworks">
        <div className="section-heading">
          <p className="eyebrow">THE PUBLIC PIPEWORKS</p>
          <h2>One little tax. Four visible stops.</h2>
          <p>
            Every step is callable or verifiable on chain. No secret operator
            button, no withdraw path for locked liquidity.
          </p>
        </div>
        <div className="flow-grid">
          <article className="flow-card">
            <span>01</span>
            <div className="flow-icon">↕</div>
            <h3>A coin trades</h3>
            <p>The v4 hook collects a fixed 1% tax in ETH on buys and sells.</p>
          </article>
          <article className="flow-card">
            <span>02</span>
            <div className="flow-icon">70</div>
            <h3>Creator lane</h3>
            <p>70% streams to the creator—or buys and burns their own coin.</p>
          </article>
          <article className="flow-card">
            <span>03</span>
            <div className="flow-icon">30</div>
            <h3>Protocol lane</h3>
            <p>30% enters a splitter anyone can trigger and inspect.</p>
          </article>
          <article className="flow-card flow-card-burn">
            <span>04</span>
            <div className="flow-icon">🔥</div>
            <h3>PIPEDOG burns</h3>
            <p>The burn lane market-buys PIPEDOG and destroys the tokens.</p>
          </article>
        </div>
        <div className="pipe-line" aria-hidden="true">
          <i />
          <i />
          <i />
          <i />
        </div>
      </section>

      <section className="section launch-section" id="launch">
        <div className="launch-copy">
          <p className="eyebrow">LAUNCH A COIN</p>
          <h2>Pick where your 70% flows.</h2>
          <p>
            The protocol lane always supports PIPEDOG. Your lane can pay a
            creator or continuously shrink your own token supply.
          </p>
          <div className="promise-list">
            <p>
              <span>✓</span> Fixed supply, issued once
            </p>
            <p>
              <span>✓</span> Liquidity locked by the hook
            </p>
            <p>
              <span>✓</span> Fees paid in ETH
            </p>
            <p>
              <span>✓</span> Public keeper bounties
            </p>
          </div>
        </div>

        <form className="launch-card" onSubmit={reviewLaunch}>
          <div className="launch-card-top">
            <p>Launch preview</p>
            <span>Contracts pending audit</span>
          </div>
          <label>
            Coin name
            <input
              value={coinName}
              onChange={(event) => setCoinName(event.target.value)}
              placeholder="Very Pipe Coin"
              maxLength={32}
              required
            />
          </label>
          <label>
            Ticker
            <div className="ticker-input">
              <span>$</span>
              <input
                value={ticker}
                onChange={(event) =>
                  setTicker(event.target.value.toUpperCase())
                }
                placeholder="PIPE"
                maxLength={10}
                required
              />
            </div>
          </label>
          <fieldset>
            <legend>Fee mode</legend>
            <button
              type="button"
              className={launchMode === "creator" ? "mode active" : "mode"}
              onClick={() => setLaunchMode("creator")}
            >
              <span>Creator stream</span>
              <small>0.7% → your wallet</small>
            </button>
            <button
              type="button"
              className={launchMode === "burn" ? "mode active" : "mode"}
              onClick={() => setLaunchMode("burn")}
            >
              <span>Self burn</span>
              <small>0.7% → buy + burn</small>
            </button>
          </fieldset>
          <label>
            First buy
            <div className="eth-input">
              <input
                type="number"
                min="0"
                step="0.01"
                value={initialBuy}
                onChange={(event) => setInitialBuy(event.target.value)}
                required
              />
              <span>ETH</span>
            </div>
          </label>
          <div className="launch-summary">
            <p>
              <span>Trading tax</span>
              <strong>1.0%</strong>
            </p>
            <p>
              <span>Your lane</span>
              <strong>{launchTaxCopy}</strong>
            </p>
            <p>
              <span>Protocol lane</span>
              <strong>0.3% → PIPEDOG</strong>
            </p>
          </div>
          <button className="review-button" type="submit">
            Review launch
          </button>
          <small className="form-note">
            Preview only. No transaction is sent before contracts are deployed
            and audited.
          </small>
        </form>
      </section>

      <section className="section burn-section">
        <div className="burn-panel">
          <div className="burn-copy">
            <p className="eyebrow">THE PIPEDOG LANE</p>
            <h2>
              The machine buys the question.
              <br />
              Then burns the answer.
            </h2>
            <p>
              The protocol share follows the LetsCash splitter model: one
              quarter buys and burns PIPEDOG, one quarter buys PIPEDOG for the
              treasury, and half funds operations.
            </p>
            <div className="split-bars" aria-label="Protocol fee split">
              <div style={{ width: "25%" }}>
                <span>25%</span>
                <small>burn</small>
              </div>
              <div style={{ width: "25%" }}>
                <span>25%</span>
                <small>treasury</small>
              </div>
              <div style={{ width: "50%" }}>
                <span>50%</span>
                <small>operations</small>
              </div>
            </div>
            <a
              className="secondary-button dark"
              href={EXPLORER_URL}
              target="_blank"
              rel="noreferrer"
            >
              Verify PIPEDOG supply ↗
            </a>
          </div>
          <div className="burn-art">
            <Image
              src="/brand/pipedog.png"
              alt="PIPEDOG detective"
              width={385}
              height={351}
            />
            <div className="burn-pipe">
              <span>ETH IN</span>
              <strong>🔥</strong>
              <span>SUPPLY ↓</span>
            </div>
            <p>current supply</p>
            <strong>{compact(stats.supply)}</strong>
          </div>
        </div>
      </section>

      <section className="section docs-section" id="docs">
        <div className="section-heading narrow">
          <p className="eyebrow">READ THE LABEL</p>
          <h2>Built from a public machine.</h2>
          <p>
            The reference contracts are verified on Robinhood Chain. The
            PIPEDOG version changes the protocol asset and must be separately
            deployed, verified, and audited before launch.
          </p>
        </div>
        <div className="docs-grid">
          <details open>
            <summary>What is borrowed from LetsCash?</summary>
            <p>
              The Uniswap v4 hook pattern, immutable liquidity lock, fixed
              trading tax, creator and self-burn launch modes, permissionless
              sweeps, and keeper bounties.
            </p>
          </details>
          <details>
            <summary>What changes for laypipe.fun?</summary>
            <p>
              PIPEDOG replaces CASHCAT as the protocol buyback asset. The
              visual identity, interface, launch copy, and deployment
              configuration are new.
            </p>
          </details>
          <details>
            <summary>Can anyone trigger a burn?</summary>
            <p>
              That is the intended contract design. Public keeper functions
              turn accrued ETH into market buys, pay a small caller bounty,
              and burn the purchased tokens.
            </p>
          </details>
          <details>
            <summary>Is this live yet?</summary>
            <p>
              The site is a working product preview. The PIPEDOG contracts are
              not presented as deployed until an audited deployment address is
              available.
            </p>
          </details>
        </div>
        <div className="source-links">
          <a
            href="https://www.letscash.fun/docs"
            target="_blank"
            rel="noreferrer"
          >
            Reference docs ↗
          </a>
          <a href={EXPLORER_URL} target="_blank" rel="noreferrer">
            Token contract ↗
          </a>
          <a href={DEXSCREENER_URL} target="_blank" rel="noreferrer">
            Live market ↗
          </a>
          <a href="https://pipedog.xyz" target="_blank" rel="noreferrer">
            PIPEDOG lore ↗
          </a>
        </div>
      </section>

      <section className="rushmore-section">
        <Image
          src="/brand/dog-rushmore.png"
          alt="PIPEDOG discovers the great dogs carved into a mountain"
          width={1536}
          height={1024}
        />
        <div className="rushmore-copy">
          <p>is it pipe?</p>
          <h2>yes. very pipe.</h2>
          <a href={UNISWAP_URL} target="_blank" rel="noreferrer">
            Get PIPEDOG ↗
          </a>
        </div>
      </section>

      <footer>
        <div>
          <a className="brand footer-brand" href="#top">
            <span className="brand-mark">?</span>
            <span>laypipe.fun</span>
          </a>
          <p>Sunshine launch infrastructure for very curious coins.</p>
        </div>
        <nav aria-label="PIPEDOG social links">
          <a href="https://x.com/pipedog_" target="_blank" rel="noreferrer">
            X ↗
          </a>
          <a
            href="https://t.me/pipedogpipe"
            target="_blank"
            rel="noreferrer"
          >
            Telegram ↗
          </a>
          <a href="https://pipedog.xyz" target="_blank" rel="noreferrer">
            pipedog.xyz ↗
          </a>
        </nav>
        <p className="risk">
          Memecoins are volatile and can go to zero. Nothing here is financial
          advice.
        </p>
      </footer>

      {showReview && (
        <div
          className="modal-backdrop"
          role="presentation"
          onMouseDown={() => setShowReview(false)}
        >
          <section
            className="review-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="review-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <button
              className="modal-close"
              onClick={() => setShowReview(false)}
              aria-label="Close launch review"
            >
              ×
            </button>
            <p className="eyebrow">LAUNCH REVIEW</p>
            <h2 id="review-title">
              {coinName} <span>${ticker}</span>
            </h2>
            <div className="modal-pipe">?</div>
            <dl>
              <div>
                <dt>Mode</dt>
                <dd>{launchMode === "burn" ? "Self burn" : "Creator stream"}</dd>
              </div>
              <div>
                <dt>First buy</dt>
                <dd>{initialBuy || "0"} ETH</dd>
              </div>
              <div>
                <dt>Protocol asset</dt>
                <dd>PIPEDOG</dd>
              </div>
            </dl>
            <button
              className="review-button"
              onClick={() => setShowReview(false)}
            >
              Looks good
            </button>
            <p className="form-note">
              This preview becomes a wallet transaction after the audited
              contracts are deployed.
            </p>
          </section>
        </div>
      )}
    </main>
  );
}
