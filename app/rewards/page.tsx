import type { Metadata } from "next";
import { PipeDogWalletPanel } from "../_components/PipeDogWalletPanel";
import { readLaypipePageData } from "../_data/laypipe";

export const metadata: Metadata = {
  title: "PIPEDOG Rewards | laypipe.fun",
  description:
    "See and claim the PIPEDOG allocated to your automatic PipeDog NFTs.",
};

export default async function RewardsPage() {
  const { protocol, wallet } = await readLaypipePageData();

  return (
    <main className="inner-page content-width">
      <section className="page-heading compact">
        <div>
          <p className="eyebrow">ONE PIPEDOG NFT. ONE REWARD UNIT.</p>
          <h1>Rewards</h1>
          <p>
            The official pool&apos;s v4 hook routes its 1% PIPEDOG trading fee into
            a pull-based accumulator. Wallets below one full NFT threshold
            receive no share.
          </p>
        </div>
      </section>

      <PipeDogWalletPanel
        protocol={protocol}
        snapshot={wallet}
        variant="rewards"
      />
    </main>
  );
}
