import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Sites serves the bundled public assets directly. Avoid routing local brand
  // art through vinext's image worker when the local preview has no IMAGES
  // binding.
  images: {
    unoptimized: true,
  },
};

export default nextConfig;
