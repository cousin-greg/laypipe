import { MarketBoard } from "./_components/MarketBoard";
import { readMarketDataMode } from "@/lib/server/market/mode";

export default function HomePage() {
  return <MarketBoard marketMode={readMarketDataMode()} />;
}
