"use client";

import type { SiteContent } from "@/lib/types";
import { ScrambleText } from "@/components/ScrambleText";
import { MechanicalDecor } from "@/components/panels/MechanicalDecor";

type HomePanelProps = {
  site: SiteContent;
  active?: boolean;
};

export function HomePanel({ site, active = true }: HomePanelProps) {
  return (
    <div className="relative flex h-full w-full items-center justify-center px-6 pt-20">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_30%_20%,rgba(90,120,140,0.12),transparent_55%),radial-gradient(ellipse_at_80%_80%,rgba(40,50,60,0.35),transparent_50%)]" />
      <MechanicalDecor />
      <div className="relative max-w-3xl text-center">
        <p className="mb-4 text-xs tracking-[0.35em] text-[var(--muted)] uppercase">
          Portfolio
        </p>
        <ScrambleText
          as="h1"
          text={site.name}
          play={active}
          className="font-display text-3xl leading-relaxed tracking-wide text-[var(--text)] sm:text-4xl md:text-5xl"
        />
        <p className="mt-6 text-lg text-[var(--muted)] sm:text-xl">
          {site.designation}
        </p>
        <ul className="mt-12 flex flex-wrap items-center justify-center gap-6">
          {site.links.map((link) => (
            <li key={link.href}>
              <a
                href={link.href}
                target={link.href.startsWith("mailto:") ? undefined : "_blank"}
                rel={
                  link.href.startsWith("mailto:")
                    ? undefined
                    : "noopener noreferrer"
                }
                className="text-sm tracking-wide text-[var(--text)] underline-offset-4 transition-opacity hover:opacity-60 hover:underline"
              >
                {link.label}
              </a>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
