import type { NextConfig } from "next";

export function buildContentSecurityPolicy(isDevelopment = false) {
  return [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline'${isDevelopment ? " 'unsafe-eval'" : ""}`,
    "script-src-attr 'none'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https://gateway.pinata.cloud https://*.mypinata.cloud",
    "font-src 'self' data:",
    `connect-src 'self'${isDevelopment ? " ws:" : ""} https://uploads.pinata.cloud https://rpc.mainnet.chain.robinhood.com`,
    "worker-src 'self' blob:",
    "frame-src 'none'",
    "media-src 'none'",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "upgrade-insecure-requests",
  ].join("; ");
}

const nextConfig: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  // Preserve the authored pixels in the original PIPEDOG brand artwork.
  images: {
    unoptimized: true,
    remotePatterns: [
      { protocol: "https", hostname: "gateway.pinata.cloud", pathname: "/ipfs/**" },
      { protocol: "https", hostname: "**.mypinata.cloud", pathname: "/ipfs/**" },
    ],
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          {
            key: "Content-Security-Policy",
            value: buildContentSecurityPolicy(process.env.NODE_ENV !== "production"),
          },
          {
            key: "Referrer-Policy",
            value: "strict-origin-when-cross-origin",
          },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=()",
          },
          {
            key: "Strict-Transport-Security",
            value: "max-age=31536000; includeSubDomains",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
