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

export const metadata: Metadata = {
  title: "NATESTACKS — The Paper Trial",
  description:
    "A quant desk that bets on sports — on paper, until it earns the right to real money. Picks, closing-line value, critic kills, and the funding gate, in ink.",
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
