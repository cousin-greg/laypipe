import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "laypipe.fun",
    short_name: "LAYPIPE",
    description:
      "Trade LAYPIPE against native ETH and unlock automatic Lay Pipedog NFTs.",
    start_url: "/",
    display: "standalone",
    background_color: "#fff7dc",
    theme_color: "#fff7dc",
    icons: [
      {
        src: "/brand/pipedog-pipe-mark.png",
        sizes: "512x512",
        type: "image/png",
      },
    ],
  };
}
