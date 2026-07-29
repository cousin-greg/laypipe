import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import localFont from "next/font/local";
import { SiteShell } from "./_components/SiteShell";
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
    title: "laypipe.fun — Launch and trade with PIPEDOG",
    description:
      "A Robinhood Chain launch board where every coin pairs and trades with PIPEDOG and protocol fees route directly to 0xdead, treasury, and operations.",
    applicationName: "laypipe.fun",
    icons: {
      icon: "/brand/favicon.png",
      shortcut: "/brand/favicon.png",
      apple: "/brand/favicon.png",
    },
    openGraph: {
      title: "laypipe.fun — The Robinhood Chain coin pipeline",
      description:
        "Launch a coin against PIPEDOG, lock its liquidity, and route the protocol fee lane directly to 0xdead, treasury, and operations.",
      url: origin,
      siteName: "laypipe.fun",
      type: "website",
      images: [
        {
          url: socialImage,
          width: 1200,
          height: 630,
          alt: "The original PIPEDOG beside a green pipe and burn furnace for laypipe.fun",
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: "laypipe.fun — The Robinhood Chain coin pipeline",
      description:
        "Sunshine launch infrastructure where every coin trades in PIPEDOG and protocol fees route directly.",
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
    <html
      lang="en"
      className={`${mori.variable} ${dragon.variable}`}
      data-scroll-behavior="smooth"
      suppressHydrationWarning
    >
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html:
              'try{var t=localStorage.getItem("laypipe-theme");if(t==="dark"||(!t&&matchMedia("(prefers-color-scheme: dark)").matches)){document.documentElement.dataset.theme="dark"}}catch(e){}',
          }}
        />
      </head>
      <body>
        <SiteShell>{children}</SiteShell>
      </body>
    </html>
  );
}
