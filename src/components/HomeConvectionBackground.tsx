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
 * into the plume that can be click-and-dragged around.
 *
 * The canvas itself is always pointer-events: none — it's just a render
 * target, sitting at z-0 behind the actual panel content. That panel
 * content wrapper spans the full viewport and (like any ordinary div)
 * has pointer-events: auto by default even where it's visually empty, so
 * it swallows clicks before they'd ever reach something at z-0. Rather
 * than fight that, obstacle mode adds its own full-viewport overlay
 * above everything except the nav/button (z-40, under nav's z-50) that
 * captures the drag while it's on. It's an explicit, opt-in "editing"
 * mode — turning it off (or the fact the toggle button sits at an even
 * higher z-index) hands normal interaction back immediately.
 */
export function HomeConvectionBackground() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
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
    const overlay = overlayRef.current;
    if (!overlay) return;

    if (!obstacleOn) {
      controllerRef.current?.setObstacle?.(null, null);
      draggingRef.current = false;
      return;
    }

    const setFromEvent = (event: PointerEvent) => {
      const rect = overlay.getBoundingClientRect();
      const xFrac = (event.clientX - rect.left) / Math.max(rect.width, 1);
      const yFrac = (event.clientY - rect.top) / Math.max(rect.height, 1);
      controllerRef.current?.setObstacle?.(xFrac, yFrac);
    };

    const onPointerDown = (event: PointerEvent) => {
      draggingRef.current = true;
      overlay.setPointerCapture(event.pointerId);
      setFromEvent(event);
    };
    const onPointerMove = (event: PointerEvent) => {
      if (!draggingRef.current) return;
      setFromEvent(event);
    };
    const endDrag = (event: PointerEvent) => {
      draggingRef.current = false;
      if (overlay.hasPointerCapture(event.pointerId)) {
        overlay.releasePointerCapture(event.pointerId);
      }
    };

    // Drop it in the middle of the viewport as soon as obstacle mode is
    // switched on, so there's something to see/grab immediately.
    controllerRef.current?.setObstacle?.(0.5, 0.5);

    overlay.addEventListener("pointerdown", onPointerDown);
    overlay.addEventListener("pointermove", onPointerMove);
    overlay.addEventListener("pointerup", endDrag);
    overlay.addEventListener("pointercancel", endDrag);

    return () => {
      overlay.removeEventListener("pointerdown", onPointerDown);
      overlay.removeEventListener("pointermove", onPointerMove);
      overlay.removeEventListener("pointerup", endDrag);
      overlay.removeEventListener("pointercancel", endDrag);
    };
  }, [obstacleOn]);

  return (
    <>
      <canvas
        ref={canvasRef}
        aria-hidden="true"
        className="pointer-events-none fixed inset-0 z-0 h-screen w-screen"
      />
      {obstacleOn && (
        <div
          ref={overlayRef}
          aria-hidden="true"
          className="fixed inset-0 z-40 h-screen w-screen touch-none cursor-grab active:cursor-grabbing"
        />
      )}
      <button
        type="button"
        onClick={() => setObstacleOn((prev) => !prev)}
        className="fixed bottom-6 right-6 z-50 rounded-full border border-[var(--border)] bg-[rgba(7,8,9,0.7)] px-4 py-2 text-[10px] tracking-[0.2em] text-[var(--muted)] uppercase backdrop-blur transition-colors hover:text-[var(--foreground)]"
        aria-pressed={obstacleOn}
      >
        {obstacleOn ? "Remove obstacle" : "Add obstacle"}
      </button>
    </>
  );
}
