import type { Metadata } from "next";
import { PipeDogWalletPanel } from "../_components/PipeDogWalletPanel";
import { readLaypipePageData } from "../_data/laypipe";

export const metadata: Metadata = {
  title: "PIPEDOG Rewards | laypipe.fun",
  description:
    "See the periodic PIPEDOG rewards allocated to automatic Lay Pipedog NFTs.",
};

export default async function RewardsPage() {
  const { protocol, wallet } = await readLaypipePageData();

  return (
    <main className="inner-page content-width">
      <section className="page-heading compact">
        <div>
          <p className="eyebrow">ONE LAY PIPEDOG NFT. ONE REWARD UNIT.</p>
          <h1>Rewards</h1>
          <p>
            The planned ETH/LAYPIPE v4 hook accrues a 1% ETH-side fee for
            periodic, trustless PIPEDOG purchases and holder distribution.
            Wallets below one full NFT threshold receive no share.
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
