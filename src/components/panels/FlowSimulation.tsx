"use client";

import { useEffect, useRef, useState } from "react";
import type { FlowController } from "./flow/types";
import { supportsGpuFlowSim } from "./flow/supportsGpuFlowSim";
import { createGpuFlowSim } from "./flow/createGpuFlowSim";
import { createCpuFlowSim } from "./flow/createCpuFlowSim";

/**
 * 2D incompressible flow visualization (smoke advected by a solved
 * velocity field around a mouse-controlled cylinder).
 *
 * Uses WebGL2 (GPU, fragment-shader passes over ping-pong textures) when
 * available, since it's dramatically faster than the CPU fallback for this
 * kind of per-cell iterative solve. Falls back automatically — same
 * physics, same visuals, same UI — on browsers without WebGL2 or without
 * floating-point render-target support.
 *
 * The simulation only advances while explicitly playing. It starts paused
 * (a static setup frame is drawn once) and the loop is torn down entirely
 * whenever the tab is hidden or the user pauses, so it costs nothing when
 * not actively visible and running.
 */
export function FlowSimulation() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const isPlayingRef = useRef(isPlaying);
  const controllerRef = useRef<FlowController | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const controller = supportsGpuFlowSim()
      ? createGpuFlowSim(canvas, isPlayingRef)
      : createCpuFlowSim(canvas, isPlayingRef);

    controllerRef.current = controller;

    return () => {
      controller?.destroy();
      controllerRef.current = null;
    };
  }, []);

  useEffect(() => {
    isPlayingRef.current = isPlaying;
    if (isPlaying) {
      controllerRef.current?.start();
    } else {
      controllerRef.current?.stop();
    }
  }, [isPlaying]);

  return (
    <div className="relative">
      <p className="mb-2 text-[10px] tracking-[0.2em] text-[var(--muted)] uppercase">
        2D flow simulation — move the cylinder with your cursor
      </p>
      <div className="relative">
        <canvas
          ref={canvasRef}
          className="h-48 w-full touch-none rounded-md border border-[var(--border)] sm:h-56"
          aria-label="Interactive two-dimensional flow simulation with smoke visualization"
        />
        {!isPlaying && (
          <button
            type="button"
            onClick={() => setIsPlaying(true)}
            className="absolute inset-0 flex items-center justify-center gap-2 rounded-md bg-[rgba(7,8,9,0.35)] text-[var(--muted)] transition-colors hover:text-[var(--foreground)]"
            aria-label="Start flow simulation"
          >
            <span className="flex h-10 w-10 items-center justify-center rounded-full border border-[var(--border)] bg-[rgba(7,8,9,0.7)]">
              <svg viewBox="0 0 16 16" className="h-4 w-4 translate-x-[1px]" fill="currentColor" aria-hidden="true">
                <path d="M4 2.5v11l10-5.5-10-5.5z" />
              </svg>
            </span>
            <span className="text-[10px] tracking-[0.2em] uppercase">Run simulation</span>
          </button>
        )}
        {isPlaying && (
          <button
            type="button"
            onClick={() => setIsPlaying(false)}
            className="absolute right-2 top-2 flex h-7 w-7 items-center justify-center rounded-full border border-[var(--border)] bg-[rgba(7,8,9,0.7)] text-[var(--muted)] transition-colors hover:text-[var(--foreground)]"
            aria-label="Pause flow simulation"
          >
            <svg viewBox="0 0 16 16" className="h-3 w-3" fill="currentColor" aria-hidden="true">
              <path d="M3 2h3v12H3zM10 2h3v12h-3z" />
            </svg>
          </button>
        )}
      </div>
    </div>
  );
}
