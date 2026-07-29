import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import { Poppins } from "next/font/google";
import localFont from "next/font/local";
import "./globals.css";

const moriFallback = Poppins({
  variable: "--font-mori-fallback",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800"],
  display: "swap",
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
  themeColor: "#f8c94c",
  colorScheme: "light",
};

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("host") ?? "laypipe.fun";
  const protocol =
    requestHeaders.get("x-forwarded-proto") ??
    (host.startsWith("localhost") ? "http" : "https");
  const origin = `${protocol}://${host}`;
  const socialImage = `${origin}/og.png`;

  return {
    metadataBase: new URL(origin),
    title: "laypipe.fun — Fees in. PIPEDOG burns.",
    description:
      "A sunny Robinhood Chain launchpad where trading fees flow through public buybacks and burns of PIPEDOG.",
    applicationName: "laypipe.fun",
    icons: {
      icon: "/brand/favicon.png",
      shortcut: "/brand/favicon.png",
      apple: "/brand/favicon.png",
    },
    openGraph: {
      title: "laypipe.fun — Fees in. PIPEDOG burns.",
      description:
        "Launch a coin, lock its liquidity, and route protocol fees through public PIPEDOG buybacks and burns.",
      url: origin,
      siteName: "laypipe.fun",
      type: "website",
      images: [
        {
          url: socialImage,
          width: 1200,
          height: 630,
          alt: "PIPEDOG detective inside sunny green pipeworks",
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: "laypipe.fun — Fees in. PIPEDOG burns.",
      description:
        "Sunshine launch infrastructure with public PIPEDOG buybacks and burns.",
      images: [socialImage],
    },
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${moriFallback.variable} ${dragon.variable}`}
      >
        {children}
      </body>
    </html>
  );
}
