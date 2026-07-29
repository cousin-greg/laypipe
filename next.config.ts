import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Preserve the authored pixels in the original PIPEDOG brand artwork.
  images: {
    unoptimized: true,
  },
};

export default nextConfig;
