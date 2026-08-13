import type { Metadata } from "next";
import { Instrument_Sans, Syne } from "next/font/google";
import "./globals.css";

const syne = Syne({
  variable: "--font-display",
  subsets: ["latin"],
  weight: ["500", "600", "700"],
});

const instrument = Instrument_Sans({
  variable: "--font-body",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Manish — Portfolio",
  description: "Project showcase portfolio",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${syne.variable} ${instrument.variable} h-full antialiased`}
    >
      <body className="min-h-full overflow-hidden bg-[var(--bg)] text-[var(--text)]">
        {children}
      </body>
    </html>
  );
}
