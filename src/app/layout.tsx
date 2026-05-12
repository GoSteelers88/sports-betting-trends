import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";

// Inter is a variable font with wght axis 100..900 — drives the
// odds-distortion typography (hot = 900, cold = 200).
const inter = Inter({
  variable: "--font-display",
  subsets: ["latin"],
  axes: ["opsz"],
});

const interSans = Inter({
  variable: "--font-sans",
  subsets: ["latin"],
});

// JetBrains Mono — thermal receipt + radar telemetry
const jetbrainsMono = JetBrains_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "//NATESTACKS — TRANSMISSION 001",
  description: "Sports edges. Live. Raw. No fluff.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${interSans.variable} ${inter.variable} ${jetbrainsMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
