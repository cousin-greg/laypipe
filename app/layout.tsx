import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import { SiteShell } from "./_components/SiteShell";
import { WalletProvider } from "./_components/WalletProvider";
import "./globals.css";

const mori = localFont({
  variable: "--font-mori",
  src: [
    {
      path: "./fonts/PPMori-Regular.woff2",
      weight: "400",
      style: "normal",
    },
    {
      path: "./fonts/PPMori-Medium.woff2",
      weight: "500",
      style: "normal",
    },
    {
      path: "./fonts/PPMori-SemiBold.woff2",
      weight: "600",
      style: "normal",
    },
    {
      path: "./fonts/PPMori-Bold.woff2",
      weight: "700",
      style: "normal",
    },
    {
      path: "./fonts/PPMori-ExtraBold.woff2",
      weight: "800",
      style: "normal",
    },
  ],
  display: "swap",
  fallback: ["system-ui", "sans-serif"],
});

export const viewport: Viewport = {
  themeColor: "#ffffff",
  colorScheme: "light",
};

export const metadata: Metadata = {
  metadataBase: new URL("https://laypipe.fun"),
  title: "laypipe.fun - LAYPIPE, Lay Pipedogs, and PIPEDOG",
  description:
    "The official native ETH/LAYPIPE bonding market: unlock Lay Pipedog NFTs and receive periodic PIPEDOG rewards by NFT count.",
  applicationName: "laypipe.fun",
  icons: {
    icon: "/brand/favicon.png",
    shortcut: "/brand/favicon.png",
    apple: "/brand/favicon.png",
  },
  openGraph: {
    title: "laypipe.fun - Every official-pool trade fills the pipe",
    description:
      "Buy LAYPIPE with native ETH. Every 100,000 LAYPIPE maps to one Lay Pipedog and one share of periodic PIPEDOG rewards.",
    url: "https://laypipe.fun",
    siteName: "laypipe.fun",
    type: "website",
    images: [
      {
        url: "/og.png",
        width: 1200,
        height: 630,
        alt: "The original PIPEDOG beside the LayPipe",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "laypipe.fun - Every official-pool trade fills the pipe",
    description:
      "Trade LAYPIPE against native ETH, unlock automatic Lay Pipedogs, and receive periodic PIPEDOG rewards by NFT count.",
    images: ["/og.png"],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={mori.variable} data-scroll-behavior="smooth">
      <body>
        <WalletProvider>
          <SiteShell>{children}</SiteShell>
        </WalletProvider>
      </body>
    </html>
  );
}
