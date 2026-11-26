import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import { SITE_URL } from "@/lib/siteUrl";
import "./globals.css";

// Self-hosted (OFL-licensed files in ./fonts) instead of next/font/google:
// the build no longer needs network access to fonts.googleapis.com, and
// visitors don't make a request to Google.
const pixelDisplay = localFont({
  variable: "--font-display",
  src: [
    { path: "./fonts/silkscreen-latin-400-normal.woff2", weight: "400", style: "normal" },
    { path: "./fonts/silkscreen-latin-700-normal.woff2", weight: "700", style: "normal" },
  ],
  display: "swap",
});

const instrument = localFont({
  variable: "--font-body",
  src: "./fonts/instrument-sans-latin-wght-normal.woff2",
  weight: "400 700",
  display: "swap",
});

const TITLE = "Manish Kumar Sharma — Mechanical Design Engineer";
const DESCRIPTION =
  "Portfolio of Manish Kumar Sharma, mechanical design engineer in Chandigarh: mechanism and cam design, FEA and CFD (OpenFOAM, Ansys), UAV design and product development.";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: TITLE,
  description: DESCRIPTION,
  authors: [{ name: "Manish Kumar Sharma", url: "https://github.com/manishbazz" }],
  keywords: [
    "mechanical design engineer",
    "FEA",
    "CFD",
    "OpenFOAM",
    "SolidWorks",
    "UAV design",
    "pantograph",
    "Chandigarh",
  ],
  alternates: { canonical: SITE_URL },
  openGraph: {
    type: "website",
    url: SITE_URL,
    title: TITLE,
    description: DESCRIPTION,
    siteName: "Manish Kumar Sharma",
    images: [{ url: "og.png", width: 1200, height: 630, alt: TITLE }],
  },
  twitter: {
    card: "summary_large_image",
    title: TITLE,
    description: DESCRIPTION,
    images: ["og.png"],
  },
};

export const viewport: Viewport = {
  themeColor: "#070809",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
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
