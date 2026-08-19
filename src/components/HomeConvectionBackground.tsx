"use client";

import { useEffect, useRef } from "react";
import { createConvectionSim } from "./panels/flow/createConvectionSim";
import type { FlowController } from "./panels/flow/types";

/**
 * Ambient, full-viewport buoyant-plume background for the home screen.
 * GPU-only (see createConvectionSim.ts for why) — renders nothing on
 * unsupported browsers or when the user prefers reduced motion, rather
 * than falling back to a CPU simulation running full-screen.
 */
export function HomeConvectionBackground() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const controllerRef = useRef<FlowController | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const controller = createConvectionSim(canvas);
    controllerRef.current = controller;

    return () => {
      controller?.destroy();
      controllerRef.current = null;
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className="pointer-events-none fixed inset-0 z-0 h-screen w-screen"
    />
  );
}