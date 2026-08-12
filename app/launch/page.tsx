import Image from "next/image";
import LaunchForm from "./LaunchForm";

export default function LaunchPage() {
  return (
    <main className="inner-page content-width">
      <section className="page-heading launch-heading">
        <div>
          <p className="eyebrow">ONE LAUNCH. ONE-WAY LIQUIDITY.</p>
          <h1>Launch a coin into the pipe.</h1>
          <p>
            Issue the full supply, seed its PIPEDOG-quoted Uniswap v4 pool,
            lock liquidity, and choose where your creator lane flows.
          </p>
        </div>
        <Image
          src="/brand/pipedog-cutout.png"
          alt="The original PIPEDOG detective"
          width={386}
          height={351}
          unoptimized
        />
      </section>

      <LaunchForm />
    </main>
  );
}
