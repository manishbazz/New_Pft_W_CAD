"use client";

import { useEffect, useRef, useState } from "react";
import { createConvectionSim } from "./panels/flow/createConvectionSim";
import type { FlowController } from "./panels/flow/types";

/**
 * Ambient, full-viewport buoyant-plume background for the home screen.
 * GPU-only (see createConvectionSim.ts for why) — renders nothing on
 * unsupported browsers or when the user prefers reduced motion, rather
 * than falling back to a CPU simulation running full-screen.
 *
 * Optional disturbance: an "Add obstacle" toggle drops a square solid
 * into the plume that can be click-and-dragged around. The canvas stays
 * pointer-events: none (so it never steals clicks/scroll from the page)
 * except while obstacle mode is on, at which point only the empty
 * background area becomes draggable — anything rendered above it (nav,
 * panel content) still intercepts its own clicks first since it sits at
 * a higher z-index.
 */
export function HomeConvectionBackground() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const controllerRef = useRef<FlowController | null>(null);
  const draggingRef = useRef(false);
  const [obstacleOn, setObstacleOn] = useState(false);

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

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    if (!obstacleOn) {
      controllerRef.current?.setObstacle?.(null, null);
      draggingRef.current = false;
      return;
    }

    const setFromEvent = (event: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      const xFrac = (event.clientX - rect.left) / Math.max(rect.width, 1);
      const yFrac = (event.clientY - rect.top) / Math.max(rect.height, 1);
      controllerRef.current?.setObstacle?.(xFrac, yFrac);
    };

    const onPointerDown = (event: PointerEvent) => {
      draggingRef.current = true;
      canvas.setPointerCapture(event.pointerId);
      setFromEvent(event);
    };
    const onPointerMove = (event: PointerEvent) => {
      if (!draggingRef.current) return;
      setFromEvent(event);
    };
    const endDrag = (event: PointerEvent) => {
      draggingRef.current = false;
      if (canvas.hasPointerCapture(event.pointerId)) {
        canvas.releasePointerCapture(event.pointerId);
      }
    };

    // Drop it in the middle of the viewport as soon as obstacle mode is
    // switched on, so there's something to see/grab immediately.
    controllerRef.current?.setObstacle?.(0.5, 0.5);

    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", endDrag);
    canvas.addEventListener("pointercancel", endDrag);

    return () => {
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", endDrag);
      canvas.removeEventListener("pointercancel", endDrag);
    };
  }, [obstacleOn]);

  return (
    <>
      <canvas
        ref={canvasRef}
        aria-hidden="true"
        className={[
          "fixed inset-0 z-0 h-screen w-screen touch-none",
          obstacleOn ? "pointer-events-auto cursor-grab active:cursor-grabbing" : "pointer-events-none",
        ].join(" ")}
      />
      <button
        type="button"
        onClick={() => setObstacleOn((prev) => !prev)}
        className="fixed bottom-6 right-6 z-30 rounded-full border border-[var(--border)] bg-[rgba(7,8,9,0.7)] px-4 py-2 text-[10px] tracking-[0.2em] text-[var(--muted)] uppercase backdrop-blur transition-colors hover:text-[var(--foreground)]"
        aria-pressed={obstacleOn}
      >
        {obstacleOn ? "Remove obstacle" : "Add obstacle"}
      </button>
    </>
  );
}
