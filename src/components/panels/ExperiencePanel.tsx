"use client";

import { useEffect, useRef, useState } from "react";
import type { ExperienceEntry } from "@/lib/types";

type ExperiencePanelProps = {
  experience: ExperienceEntry[];
};

export function ExperiencePanel({ experience }: ExperiencePanelProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLOListElement>(null);
  const [progress, setProgress] = useState(0);
  const [activeIds, setActiveIds] = useState<Set<string>>(new Set());

  // Fill line grows as the timeline scrolls past the viewport's vertical center.
  useEffect(() => {
    const scrollEl = scrollRef.current;
    const listEl = listRef.current;
    if (!scrollEl || !listEl) return;

    const updateProgress = () => {
      const scrollRect = scrollEl.getBoundingClientRect();
      const listRect = listEl.getBoundingClientRect();
      const anchor = scrollRect.top + scrollRect.height * 0.5;
      const raw = (anchor - listRect.top) / listRect.height;
      setProgress(Math.min(1, Math.max(0, raw)));
    };

    updateProgress();
    scrollEl.addEventListener("scroll", updateProgress, { passive: true });
    window.addEventListener("resize", updateProgress);
    return () => {
      scrollEl.removeEventListener("scroll", updateProgress);
      window.removeEventListener("resize", updateProgress);
    };
  }, [experience]);

  // Each dot lights up once it's scrolled into the upper portion of the viewport.
  useEffect(() => {
    const scrollEl = scrollRef.current;
    const listEl = listRef.current;
    if (!scrollEl || !listEl) return;

    const observer = new IntersectionObserver(
      (entries) => {
        setActiveIds((prev) => {
          const next = new Set(prev);
          let changed = false;
          for (const entry of entries) {
            const id = (entry.target as HTMLElement).dataset.entryId;
            if (!id || !entry.isIntersecting) continue;
            if (!next.has(id)) {
              next.add(id);
              changed = true;
            }
          }
          return changed ? next : prev;
        });
      },
      { root: scrollEl, rootMargin: "0px 0px -55% 0px", threshold: 0 },
    );

    const dots = listEl.querySelectorAll<HTMLElement>("[data-entry-id]");
    dots.forEach((dot) => observer.observe(dot));
    return () => observer.disconnect();
  }, [experience]);

  return (
    <div
      ref={scrollRef}
      data-panel-scroll="true"
      className="h-full overflow-y-auto overscroll-contain px-6 pt-24 pb-16"
    >
      <div className="mx-auto max-w-3xl">
        <h2 className="font-display text-3xl tracking-tight sm:text-4xl">
          Experience
        </h2>
        <p className="mt-2 text-[var(--muted)]">A short timeline of roles.</p>

        <ol ref={listRef} className="relative mt-12 pl-8">
          <span
            className="absolute top-0 left-0 h-full w-px bg-[var(--border)]"
            aria-hidden
          />
          <span
            className="absolute top-0 left-0 w-px origin-top bg-[var(--accent)] transition-transform duration-150 ease-out"
            style={{ height: "100%", transform: `scaleY(${progress})` }}
            aria-hidden
          />

          {experience.map((entry) => {
            const active = activeIds.has(entry.id);
            return (
              <li key={entry.id} className="relative mb-12 last:mb-0">
                <span
                  data-entry-id={entry.id}
                  className={[
                    "absolute top-1.5 -left-[2.45rem] size-2.5 rounded-full",
                    "transition-[transform,background-color] duration-300 ease-out",
                    active
                      ? "scale-125 bg-[var(--accent)]"
                      : "scale-100 bg-[var(--border)]",
                  ].join(" ")}
                  aria-hidden
                />
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <h3 className="text-lg text-[var(--text)]">{entry.role}</h3>
                  <span className="text-sm text-[var(--muted)]">
                    {entry.company}
                    {entry.location ? ` · ${entry.location}` : ""}
                  </span>
                </div>
                <p className="mt-1 text-xs tracking-wide text-[var(--muted)] uppercase">
                  {entry.start} — {entry.end}
                </p>
                <ul className="mt-4 space-y-2">
                  {entry.bullets.map((bullet) => (
                    <li
                      key={bullet}
                      className="text-sm leading-relaxed text-[var(--muted-strong)]"
                    >
                      {bullet}
                    </li>
                  ))}
                </ul>
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}
