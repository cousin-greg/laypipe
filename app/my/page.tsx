import { WalletPortfolio } from "../_components/WalletPortfolio";

export default function MyTokensPage() {
  return (
    <main className="inner-page content-width">
      <section className="page-heading compact">
        <div>
          <p className="eyebrow">YOUR LAUNCHES</p>
          <h1>My tokens</h1>
          <p>
            Creator positions, claimable PIPEDOG, self-burn totals, and launch
            controls will live here.
          </p>
        </div>
      </section>

      <WalletPortfolio view="tokens" />
    </main>
  );
}
