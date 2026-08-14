import type { Metadata } from "next";
import { Fraunces, Archivo, IBM_Plex_Mono } from "next/font/google";
import "./globals.css";

// Display face — Fraunces. A wonky, sharp editorial serif: the voice of a
// betting ledger's front page. Words only — numbers are never set in it.
const fraunces = Fraunces({
  variable: "--font-display",
  subsets: ["latin"],
  weight: ["400", "600", "900"],
  style: ["normal", "italic"],
});

// Text face — Archivo, a plain-spoken grotesque for UI copy and body text.
const archivo = Archivo({
  variable: "--font-sans",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});

// Data face — IBM Plex Mono. Every number on the page, tabular figures.
const plexMono = IBM_Plex_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});

// PUBLIC_BASE_URL is the repo's established base-URL convention (notify.ts,
// x-ready.ts) — reuse it, falling back to the production alias.
const BASE_URL = process.env.PUBLIC_BASE_URL ?? "https://sports-betting-trends.vercel.app";

const SITE_TITLE = "NATESTACKS — The Paper Trial";
const SITE_DESCRIPTION =
  "A quant desk that bets on sports — on paper, until it earns the right to real money. Picks, closing-line value, critic kills, and the funding gate, in ink.";

export const metadata: Metadata = {
  metadataBase: new URL(BASE_URL),
  title: {
    default: SITE_TITLE,
    template: "%s · NATESTACKS",
  },
  description: SITE_DESCRIPTION,
  alternates: { canonical: "/" },
  // The audience arrives from X — the card IS the front door. /api/og/picks is
  // the DB-backed 1200x675 card with today's actual board on it.
  openGraph: {
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
    url: "/",
    siteName: "NATESTACKS",
    type: "website",
    images: ["/api/og/picks"],
  },
  twitter: {
    card: "summary_large_image",
    site: "@NateStacksData",
    creator: "@NateStacksData",
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
    images: ["/api/og/picks"],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${archivo.variable} ${fraunces.variable} ${plexMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
