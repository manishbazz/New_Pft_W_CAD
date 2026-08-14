"use client";

import {
  useEffect,
  useState,
  type ComponentType,
} from "react";
import type { ProjectEntry } from "@/lib/types";

export type PreviewMode = "description" | "model";

type ProjectPreviewProps = {
  project: ProjectEntry | null;
  defaultModelUrl: string;
  mode: PreviewMode;
  onModeChange: (mode: PreviewMode) => void;
  /** When false, skip mounting the 3D viewer (keeps Three.js off the critical path). */
  enableModel?: boolean;
};

type ModelViewerProps = { url?: string };

export function ProjectPreview({
  project,
  defaultModelUrl,
  mode,
  onModeChange,
  enableModel = true,
}: ProjectPreviewProps) {
  const hasDescription = Boolean(project?.description);
  const hasModel = Boolean(project?.modelUrl);
  const hasDoc = Boolean(project?.docUrl);
  const modelUrl = project
    ? project.modelUrl
    : defaultModelUrl || undefined;
  const showModel = enableModel && mode === "model";

  return (
    <div className="flex h-full min-h-0 flex-col border-l border-[var(--border)]">
      <div className="flex flex-wrap items-center gap-2 border-b border-[var(--border)] px-4 py-3">
        {project && hasDescription ? (
          <button
            type="button"
            onClick={() => onModeChange("description")}
            className={toolbarClass(mode === "description")}
          >
            Description
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => onModeChange("model")}
          className={toolbarClass(mode === "model")}
        >
          3D
        </button>
        {project && hasDoc ? (
          <a
            href={project.docUrl}
            target="_blank"
            rel="noopener noreferrer"
            className={toolbarClass(false)}
          >
            Doc
          </a>
        ) : null}
        {!project ? (
          <span className="ml-auto text-xs text-[var(--muted)]">
            Default preview
          </span>
        ) : null}
        {project && !hasModel && mode === "model" ? (
          <span className="ml-auto text-xs text-[var(--muted)]">
            Placeholder mesh (add GLB)
          </span>
        ) : null}
      </div>

      <div className="min-h-0 flex-1">
        {mode === "description" && project ? (
          <div
            key={`desc-${project.id}`}
            className="animate-content-fade h-full overflow-y-auto px-5 py-6"
          >
            <h3 className="font-display text-2xl tracking-tight">
              {project.title}
            </h3>
            <p className="mt-4 whitespace-pre-wrap text-sm leading-relaxed text-[var(--muted-strong)]">
              {project.description}
            </p>
          </div>
        ) : showModel ? (
          <div
            key={`model-${project?.id ?? "default"}`}
            className="animate-content-fade h-full"
          >
            <LazyModelViewer url={modelUrl} />
          </div>
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-[var(--muted)]">
            3D preview idle
          </div>
        )}
      </div>
    </div>
  );
}

function LazyModelViewer({ url }: ModelViewerProps) {
  const [Viewer, setViewer] = useState<ComponentType<ModelViewerProps> | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    import("@/components/projects/ModelViewer")
      .then((mod) => {
        if (!cancelled) setViewer(() => mod.ModelViewer);
      })
      .catch((err: unknown) => {
        console.error("[portfolio] failed to load ModelViewer", err);
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load 3D");
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return (
      <div className="flex h-full items-center justify-center px-4 text-center text-sm text-[var(--muted)]">
        3D preview unavailable ({error})
      </div>
    );
  }

  if (!Viewer) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-[var(--muted)]">
        Loading preview…
      </div>
    );
  }

  return <Viewer url={url} />;
}

function toolbarClass(active: boolean) {
  return [
    "border px-3 py-1.5 text-xs tracking-wide uppercase transition-colors",
    active
      ? "border-[var(--accent)] text-[var(--accent)]"
      : "border-[var(--border)] text-[var(--muted)] hover:text-[var(--text)]",
  ].join(" ");
}
