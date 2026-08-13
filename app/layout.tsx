import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import Script from "next/script";
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

const dragon = localFont({
  variable: "--font-dragon",
  src: [
    {
      path: "./fonts/Dragon-Regular.woff2",
      weight: "400",
      style: "normal",
    },
    {
      path: "./fonts/Dragon-Medium.woff2",
      weight: "500",
      style: "normal",
    },
    {
      path: "./fonts/Dragon-SemiBold.woff2",
      weight: "600",
      style: "normal",
    },
    {
      path: "./fonts/Dragon-Bold.woff2",
      weight: "700",
      style: "normal",
    },
    {
      path: "./fonts/Dragon-ExtraBold.woff2",
      weight: "800",
      style: "normal",
    },
    {
      path: "./fonts/Dragon-Black.woff2",
      weight: "900",
      style: "normal",
    },
  ],
  display: "swap",
  fallback: ["system-ui", "sans-serif"],
});

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#fff7dc" },
    { media: "(prefers-color-scheme: dark)", color: "#07150c" },
  ],
  colorScheme: "light dark",
};

export const metadata: Metadata = {
  metadataBase: new URL("https://laypipe.fun"),
  title: "laypipe.fun - LayPipe, PipeDogs, and PIPEDOG",
  description:
    "The single LAYPIPE bonding market: trade against PIPEDOG, automatically unlock PipeDog NFTs, and claim PIPEDOG fees by NFT count.",
  applicationName: "laypipe.fun",
  icons: {
    icon: "/brand/favicon.png",
    shortcut: "/brand/favicon.png",
    apple: "/brand/favicon.png",
  },
  openGraph: {
    title: "laypipe.fun - Every official-pool trade fills the pipe",
    description:
      "Buy LAYPIPE with PIPEDOG. Every 100,000 LAYPIPE automatically maps to one PipeDog and one share of official-pool PIPEDOG fees.",
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
      "Trade LAYPIPE against PIPEDOG, unlock automatic PipeDogs, and claim PIPEDOG by NFT count.",
    images: ["/og.png"],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${mori.variable} ${dragon.variable}`}
      data-scroll-behavior="smooth"
      suppressHydrationWarning
    >
      <head>
        <Script src="/theme-init.js" strategy="beforeInteractive" />
      </head>
      <body>
        <WalletProvider>
          <SiteShell>{children}</SiteShell>
        </WalletProvider>
      </body>
    </html>
  );
}
