"use client";

import { useState } from "react";
import type { LaypipeProtocolSnapshot } from "../_data/laypipe";
import styles from "./laypipe-product.module.css";

type TradeSide = "buy" | "sell";

const sideCopy: Record<
  TradeSide,
  { inputLabel: string; inputSymbol: string; outputSymbol: string }
> = {
  buy: {
    inputLabel: "You pay",
    inputSymbol: "PIPEDOG",
    outputSymbol: "LAYPIPE",
  },
  sell: {
    inputLabel: "You sell",
    inputSymbol: "LAYPIPE",
    outputSymbol: "PIPEDOG",
  },
};

export function LaypipeTradePanel({
  protocol,
}: {
  protocol: LaypipeProtocolSnapshot;
}) {
  const [side, setSide] = useState<TradeSide>("buy");
  const [amount, setAmount] = useState("");
  const copy = sideCopy[side];

  return (
    <form
      className={styles.tradePanel}
      onSubmit={(event) => event.preventDefault()}
    >
      <div className={styles.panelHeading}>
        <div>
          <span>Bonding pool</span>
          <h3>PIPEDOG / LAYPIPE</h3>
        </div>
        <span className={styles.previewBadge}>{protocol.statusLabel}</span>
      </div>

      <div className={styles.tradeTabs} role="tablist" aria-label="Trade side">
        {(["buy", "sell"] as const).map((tab) => (
          <button
            key={tab}
            type="button"
            role="tab"
            aria-selected={side === tab}
            onClick={() => setSide(tab)}
          >
            {tab === "buy" ? "Buy" : "Sell"}
          </button>
        ))}
      </div>

      <label className={styles.amountField}>
        <span>{copy.inputLabel}</span>
        <span className={styles.amountInputRow}>
          <input
            type="text"
            inputMode="decimal"
            autoComplete="off"
            placeholder="0"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            aria-label={`${copy.inputLabel} in ${copy.inputSymbol}`}
          />
          <strong>{copy.inputSymbol}</strong>
        </span>
      </label>

      <div className={styles.quoteRows}>
        <div>
          <span>You receive</span>
          <strong>- {copy.outputSymbol}</strong>
        </div>
        <div>
          <span>Hook fee</span>
          <strong>{protocol.tradeFeeBps / 100}% in PIPEDOG</strong>
        </div>
        <div>
          <span>Route</span>
          <strong>Permanent one-sided v4 pool</strong>
        </div>
      </div>

      <button className={styles.tradeSubmit} type="submit" disabled>
        Trading opens when contracts are wired
      </button>

      <p className={styles.safetyNote}>
        Contract preview. No approval or transaction can be submitted. Live
        buys will request one exact, single-use PIPEDOG allowance. A single
        buy, sell, or transfer may cross at most 20 NFT thresholds (2,000,000
        LAYPIPE); larger actions must be split across transactions.
      </p>
    </form>
  );
}
