import type { ExperienceEntry } from "@/lib/types";

type ExperiencePanelProps = {
  experience: ExperienceEntry[];
};

export function ExperiencePanel({ experience }: ExperiencePanelProps) {
  return (
    <div
      data-panel-scroll="true"
      className="h-full overflow-y-auto overscroll-contain px-6 pt-24 pb-16"
    >
      <div className="mx-auto max-w-3xl">
        <h2 className="font-display text-3xl tracking-tight sm:text-4xl">
          Experience
        </h2>
        <p className="mt-2 text-[var(--muted)]">A short timeline of roles.</p>

        <ol className="relative mt-12 border-l border-[var(--border)] pl-8">
          {experience.map((entry) => (
            <li key={entry.id} className="relative mb-12 last:mb-0">
              <span
                className="absolute top-1.5 -left-[2.45rem] size-2.5 rounded-full bg-[var(--accent)]"
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
          ))}
        </ol>
      </div>
    </div>
  );
}
