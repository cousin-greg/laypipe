import Link from "next/link";

const rewardCards = [
  {
    label: "Claimable creator ETH",
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
            Claim creator fees and trigger eligible sweeps. Keeper bounties pay
            the address that moves idle ETH through the pipe.
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
          <span>accrued ETH</span>
          <i />
          <strong>1%</strong>
          <i />
          <span>PIPEDOG route</span>
        </div>
        <div>
          <span className="status-pill">Contracts pending</span>
          <h2>Keep the machine moving.</h2>
          <p>
            In the intended design, anyone can call an eligible sweep. The
            caller receives a 1% keeper bounty and the remaining value follows
            the configured buyback route.
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
