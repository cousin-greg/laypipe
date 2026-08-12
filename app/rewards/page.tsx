import { WalletPortfolio } from "../_components/WalletPortfolio";

export default function RewardsPage() {
  return (
    <main className="inner-page content-width">
      <section className="page-heading compact">
        <div>
          <p className="eyebrow">PUBLIC MAINTENANCE. PUBLIC REWARDS.</p>
          <h1>Rewards</h1>
          <p>Claim creator PIPEDOG from the configured release hook. Native ETH pays gas only.</p>
        </div>
      </section>
      <WalletPortfolio view="rewards" />
    </main>
  );
}
