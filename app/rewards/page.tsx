import Link from "next/link";

const rewardCards = [
  {
    label: "Claimable creator PIPEDOG",
    value: "—",
    note: "Wallet and fee indexer required",
  },
  {
    label: "Available keeper jobs",
    value: "—",
    note: "Router deployment required",
  },
  {
    label: "Lifetime keeper rewards",
    value: "—",
    note: "No live LayPipe history yet",
  },
];

export default function RewardsPage() {
  return (
    <main className="inner-page content-width">
      <section className="page-heading compact">
        <div>
          <p className="eyebrow">PUBLIC MAINTENANCE. PUBLIC REWARDS.</p>
          <h1>Rewards</h1>
          <p>
            Claim creator fees and trigger eligible routes or self-burns.
            Keeper bounties are PIPEDOG-denominated; native ETH pays gas only.
          </p>
        </div>
      </section>

      <section className="reward-grid">
        {rewardCards.map((card) => (
          <article key={card.label}>
            <span>{card.label}</span>
            <strong>{card.value}</strong>
            <p>{card.note}</p>
          </article>
        ))}
      </section>

      <section className="keeper-panel">
        <div className="keeper-pipe" aria-hidden="true">
          <span>accrued PIPEDOG</span>
          <i />
          <strong>bounty</strong>
          <i />
          <span>direct route</span>
        </div>
        <div>
          <span className="status-pill">Contracts pending</span>
          <h2>Keep the machine moving.</h2>
          <p>
            In the intended design, anyone can call an eligible routing or
            self-burn action. The caller receives the configured PIPEDOG bounty
            deducted from that lane, and the remainder follows its direct
            destination or launched-token burn path.
          </p>
          <button className="button button-disabled" type="button" disabled>
            No live sweeps
          </button>
          <Link href="/docs#keepers">How keeper rewards work →</Link>
        </div>
      </section>
    </main>
  );
}
