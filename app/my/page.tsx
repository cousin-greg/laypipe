import type { Metadata } from "next";
import { PipeDogWalletPanel } from "../_components/PipeDogWalletPanel";
import { readLaypipePageData } from "../_data/laypipe";

export const metadata: Metadata = {
  title: "My PipeDogs | laypipe.fun",
  description:
    "See automatic PipeDog NFTs and progress to the next 100,000 LAYPIPE threshold.",
};

export default async function MyPipeDogsPage() {
  const { protocol, wallet } = await readLaypipePageData();

  return (
    <main className="inner-page content-width">
      <section className="page-heading compact">
        <div>
          <p className="eyebrow">100,000 LAYPIPE = 1 PIPEDOG NFT</p>
          <h1>My PipeDogs</h1>
          <p>
            See each automatic PipeDog in your wallet, your reward-unit count,
            and your exact progress to the next NFT threshold.
          </p>
        </div>
      </section>

      <PipeDogWalletPanel
        protocol={protocol}
        snapshot={wallet}
        variant="collection"
      />
    </main>
  );
}
