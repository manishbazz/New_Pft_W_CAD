import type { Metadata } from "next";
import { Instrument_Sans, Silkscreen } from "next/font/google";
import "./globals.css";

const pixelDisplay = Silkscreen({
  variable: "--font-display",
  subsets: ["latin"],
  weight: ["400", "700"],
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
      className={`${pixelDisplay.variable} ${instrument.variable} h-full antialiased`}
    >
      <body className="min-h-full overflow-hidden bg-[var(--bg)] text-[var(--text)]">
        {children}
      </body>
    </html>
  );
}
