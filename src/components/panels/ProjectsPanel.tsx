"use client";

import { useMemo, useState } from "react";
import { ProjectList } from "@/components/projects/ProjectList";
import {
  ProjectPreview,
  type PreviewMode,
} from "@/components/projects/ProjectPreview";
import { ScrambleText } from "@/components/ScrambleText";
import type { ProjectEntry } from "@/lib/types";

type ProjectsPanelProps = {
  projects: ProjectEntry[];
  defaultModelUrl: string;
  /** Mount 3D only while this panel is active. */
  active?: boolean;
};

function initialMode(project: ProjectEntry | null): PreviewMode {
  if (project?.modelUrl) return "model";
  if (project?.description) return "description";
  return "model";
}

export function ProjectsPanel({
  projects,
  defaultModelUrl,
  active = true,
}: ProjectsPanelProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mode, setMode] = useState<PreviewMode>("model");

  const selected = useMemo(
    () => projects.find((p) => p.id === selectedId) ?? null,
    [projects, selectedId],
  );

  const onSelect = (id: string) => {
    const project = projects.find((p) => p.id === id) ?? null;
    setSelectedId(id);
    setMode(initialMode(project));
  };

  return (
    <div className="flex h-full w-full flex-col pt-20 lg:flex-row">
      <div
        data-panel-scroll="true"
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-6 pb-10 lg:max-w-md lg:border-r lg:border-[var(--border)] xl:max-w-lg"
      >
        <div className="mb-6">
          <ScrambleText
            as="h2"
            text="Projects"
            play={active}
            className="font-display text-3xl tracking-tight sm:text-4xl"
          />
          <p className="mt-2 text-[var(--muted)]">
            Select a project to preview details
            <span className="hidden lg:inline"> on the right</span>.
          </p>
        </div>

        <ProjectList
          projects={projects}
          selectedId={selectedId}
          onSelect={onSelect}
        />

        {/* Mobile: description + doc, no 3D */}
        <div className="mt-8 space-y-4 lg:hidden">
          {selected ? (
            <>
              <div className="border-t border-[var(--border)] pt-6">
                <h3 className="font-display text-xl">{selected.title}</h3>
                <p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed text-[var(--muted-strong)]">
                  {selected.description}
                </p>
              </div>
              {selected.docUrl ? (
                <a
                  href={selected.docUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-block border border-[var(--border)] px-3 py-1.5 text-xs tracking-wide text-[var(--muted)] uppercase transition-colors hover:text-[var(--text)]"
                >
                  Open doc
                </a>
              ) : null}
            </>
          ) : (
            <p className="text-sm text-[var(--muted)]">
              Tap a project to read its description.
            </p>
          )}
        </div>
      </div>

      <div className="hidden min-h-0 flex-1 lg:block">
        <ProjectPreview
          project={selected}
          defaultModelUrl={defaultModelUrl}
          mode={mode}
          onModeChange={setMode}
          enableModel={active}
        />
      </div>
    </div>
  );
}
