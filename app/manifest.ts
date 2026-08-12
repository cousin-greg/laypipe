import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "laypipe.fun",
    short_name: "LayPipe",
    description:
      "Launch and trade PIPEDOG-paired coins on Robinhood Chain.",
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
