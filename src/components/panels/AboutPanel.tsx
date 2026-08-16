"use client";

import { ScrambleText } from "@/components/ScrambleText";
import { NowPlaying } from "@/components/NowPlaying";
import { MechanicalDecor } from "@/components/panels/MechanicalDecor";
import type { FavoriteSong } from "@/lib/types";

type AboutPanelProps = {
  bio: string[];
  location?: string;
  favoriteSong?: FavoriteSong;
  spotifyStatusUrl?: string;
  active?: boolean;
};

export function AboutPanel({
  bio,
  location,
  favoriteSong,
  spotifyStatusUrl,
  active = true,
}: AboutPanelProps) {
  return (
    <div
      data-panel-scroll="true"
      className="relative h-full overflow-y-auto overscroll-contain px-6 pt-24 pb-16"
    >
      <MechanicalDecor />

      <div className="relative mx-auto max-w-2xl">
        <ScrambleText
          as="h2"
          text="About"
          play={active}
          className="font-display text-3xl tracking-tight sm:text-4xl"
        />

        {location && (
          <p className="mt-3 flex items-center gap-2 text-sm text-[var(--muted)]">
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              aria-hidden
            >
              <path d="M12 21s-7-6.5-7-11.5a7 7 0 0 1 14 0C19 14.5 12 21 12 21z" />
              <circle cx="12" cy="9.5" r="2.5" />
            </svg>
            {location}
          </p>
        )}

        <div className="mt-8 space-y-5">
          {bio.map((paragraph, i) => (
            <p
              key={i}
              className="text-base leading-relaxed text-[var(--muted-strong)]"
            >
              {paragraph}
            </p>
          ))}
        </div>

        <div className="mt-10 max-w-sm">
          <NowPlaying statusUrl={spotifyStatusUrl} fallback={favoriteSong} />
        </div>
      </div>
    </div>
  );
}
