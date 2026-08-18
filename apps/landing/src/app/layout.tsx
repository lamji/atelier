import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

export const metadata: Metadata = {
  metadataBase: new URL("https://atelier.dev"),
  title: "Atelier - AI code editor portfolio",
  description:
    "Atelier is a local-first AI code editor for grounded agent work, project knowledge, terminals, git, previews, pricing, and downloads.",
  openGraph: {
    title: "Atelier - AI code editor portfolio",
    description:
      "A local-first AI code editor for grounded, visible, recoverable agent work.",
    images: ["/images/atelier-hero.png"],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={inter.variable}>{children}</body>
    </html>
  );
}
