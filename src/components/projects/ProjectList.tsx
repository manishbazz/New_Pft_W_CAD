"use client";

import type { ProjectEntry } from "@/lib/types";

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
              onClick={() => onSelect(project.id)}
              className={[
                "flex w-full flex-col items-start gap-1 px-1 py-4 text-left transition-colors",
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
