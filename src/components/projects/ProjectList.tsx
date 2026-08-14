"use client";

import type { ProjectEntry } from "@/lib/types";
import { playClickTick, playHoverTick } from "@/lib/uiSound";

type ProjectListProps = {
  projects: ProjectEntry[];
  selectedId: string | null;
  onSelect: (id: string) => void;
};

export function ProjectList({
  projects,
  selectedId,
  onSelect,
}: ProjectListProps) {
  return (
    <ul className="divide-y divide-[var(--border)]">
      {projects.map((project) => {
        const selected = project.id === selectedId;
        return (
          <li key={project.id}>
            <button
              type="button"
              onClick={() => {
                playClickTick();
                onSelect(project.id);
              }}
              onMouseEnter={playHoverTick}
              className={[
                "flex w-full origin-left flex-col items-start gap-1 px-1 py-4 text-left",
                "transition-[color,transform] duration-150 ease-out",
                "hover:translate-x-1.5 hover:scale-[1.015]",
                selected
                  ? "text-[var(--text)]"
                  : "text-[var(--muted)] hover:text-[var(--text)]",
              ].join(" ")}
              aria-pressed={selected}
            >
              <span className="font-display text-lg tracking-tight">
                {project.title}
              </span>
              <span className="text-sm leading-relaxed text-[var(--muted)]">
                {project.summary}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
