"use client";

import Image from "next/image";
import { FormEvent, useMemo, useState } from "react";
import { LaunchMode } from "../_data/market";

export default function LaunchPage() {
  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [description, setDescription] = useState("");
  const [mode, setMode] = useState<LaunchMode>("self-burn");
  const [firstBuy, setFirstBuy] = useState("0.05");
  const [imageName, setImageName] = useState("");
  const [reviewed, setReviewed] = useState(false);

  const tokenLabel = useMemo(
    () => `${name || "Your coin"} ${symbol ? `$${symbol}` : ""}`,
    [name, symbol],
  );

  function review(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setReviewed(true);
  }

  return (
    <main className="inner-page content-width">
      <section className="page-heading launch-heading">
        <div>
          <p className="eyebrow">ONE TRANSACTION. ONE-WAY LIQUIDITY.</p>
          <h1>Launch a coin into the pipe.</h1>
          <p>
            Issue the full supply, seed its Uniswap v4 pool, lock liquidity,
            and choose where your creator lane flows.
          </p>
        </div>
        <Image
          src="/brand/laypipe-mark.png"
          alt="PIPEDOG watching over a green pipe"
          width={260}
          height={260}
          unoptimized
        />
      </section>

      <aside className="readiness-banner" role="status">
        <span>Preview only</span>
        <div>
          <strong>Factory deployment and audit are still pending.</strong>
          <p>
            You can complete and review the launch flow, but the interface will
            not request a transaction or accept funds.
          </p>
        </div>
      </aside>

      <div className="launch-workspace">
        <form className="product-form" onSubmit={review}>
          <div className="form-section">
            <div className="form-section-title">
              <span>01</span>
              <div>
                <h2>Coin details</h2>
                <p>The facts traders will see on the board.</p>
              </div>
            </div>

            <div className="form-grid">
              <label>
                <span>Coin name</span>
                <input
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="Very Pipe Coin"
                  maxLength={32}
                  required
                />
              </label>
              <label>
                <span>Ticker</span>
                <div className="affixed-input">
                  <i>$</i>
                  <input
                    value={symbol}
                    onChange={(event) =>
                      setSymbol(
                        event.target.value
                          .toUpperCase()
                          .replace(/[^A-Z0-9]/g, ""),
                      )
                    }
                    placeholder="PIPE"
                    maxLength={10}
                    required
                  />
                </div>
              </label>
            </div>

            <label>
              <span>Description</span>
              <textarea
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="What escaped from this pipe?"
                maxLength={240}
                rows={4}
                required
              />
              <small>{description.length}/240</small>
            </label>

            <label className="file-field">
              <span>Coin artwork</span>
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                onChange={(event) =>
                  setImageName(event.target.files?.[0]?.name ?? "")
                }
              />
              <span className="file-drop">
                <strong>{imageName || "Choose PNG, JPG, or WEBP"}</strong>
                <small>Square artwork · 5 MB maximum at launch</small>
              </span>
            </label>
          </div>

          <div className="form-section">
            <div className="form-section-title">
              <span>02</span>
              <div>
                <h2>Route the creator lane</h2>
                <p>The 0.3% protocol lane always supports PIPEDOG.</p>
              </div>
            </div>

            <fieldset className="mode-picker">
              <legend className="visually-hidden">Fee mode</legend>
              <button
                type="button"
                aria-pressed={mode === "creator"}
                onClick={() => setMode("creator")}
              >
                <i aria-hidden="true">↗</i>
                <strong>Creator fees</strong>
                <span>0.7% of every trade becomes claimable ETH.</span>
              </button>
              <button
                type="button"
                aria-pressed={mode === "self-burn"}
                onClick={() => setMode("self-burn")}
              >
                <i aria-hidden="true">↓</i>
                <strong>Self-burn</strong>
                <span>0.7% buys and permanently burns your own coin.</span>
              </button>
            </fieldset>
          </div>

          <div className="form-section">
            <div className="form-section-title">
              <span>03</span>
              <div>
                <h2>Seed the pool</h2>
                <p>Your optional first buy happens in the launch transaction.</p>
              </div>
            </div>

            <label>
              <span>First buy</span>
              <div className="affixed-input suffix">
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={firstBuy}
                  onChange={(event) => setFirstBuy(event.target.value)}
                  required
                />
                <i>ETH</i>
              </div>
            </label>
          </div>

          <button className="button button-accent review-launch" type="submit">
            Review launch
          </button>
          <p className="form-disclaimer">
            Reviewing does not connect a wallet or submit a transaction.
          </p>
        </form>

        <aside className="launch-receipt">
          <div className="receipt-top">
            <span>Launch receipt</span>
            <span className="preview-tag">Preview</span>
          </div>
          <div className="receipt-coin">
            <div aria-hidden="true">{symbol.slice(0, 2) || "?"}</div>
            <h2>{tokenLabel}</h2>
            <p>{description || "Your launch summary will appear here."}</p>
          </div>
          <dl>
            <div>
              <dt>Total supply</dt>
              <dd>1,000,000,000</dd>
            </div>
            <div>
              <dt>Pool allocation</dt>
              <dd>100%</dd>
            </div>
            <div>
              <dt>Trading fee</dt>
              <dd>1.0%</dd>
            </div>
            <div>
              <dt>Creator lane</dt>
              <dd>{mode === "self-burn" ? "0.7% self-burn" : "0.7% ETH"}</dd>
            </div>
            <div>
              <dt>Protocol lane</dt>
              <dd>0.3% → PIPEDOG router</dd>
            </div>
            <div>
              <dt>First buy</dt>
              <dd>{firstBuy || "0"} ETH</dd>
            </div>
          </dl>
          <div className="locked-liquidity">
            <i aria-hidden="true">×</i>
            <div>
              <strong>Liquidity cannot be removed</strong>
              <span>The v4 hook rejects removal forever.</span>
            </div>
          </div>
          {reviewed && (
            <div className="review-complete" role="status">
              <strong>Preview ready.</strong>
              <p>
                The final launch action stays unavailable until audited contract
                addresses are configured.
              </p>
              <button className="button button-disabled" type="button" disabled>
                Deployment pending
              </button>
            </div>
          )}
        </aside>
      </div>
    </main>
  );
}
