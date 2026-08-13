import { LaypipeProduct } from "./_components/LaypipeProduct";
import { readLaypipePageData } from "./_data/laypipe";

export default async function HomePage() {
  const data = await readLaypipePageData();

  return <LaypipeProduct data={data} />;
}
