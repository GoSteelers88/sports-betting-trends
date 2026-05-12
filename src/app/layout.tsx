import type { Metadata } from "next";
import { Archivo_Black, JetBrains_Mono, Inter } from "next/font/google";
import "./globals.css";

const inter = Inter({
  variable: "--font-sans",
  subsets: ["latin"],
});

// Archivo Black — single weight (900), perfect for brutalist display + odds
const archivoBlack = Archivo_Black({
  variable: "--font-display",
  subsets: ["latin"],
  weight: ["400"],
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "NATESTACKS // SPORTS TRENDS",
  description: "Live picks. Real edges. No fluff.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${inter.variable} ${archivoBlack.variable} ${jetbrainsMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
