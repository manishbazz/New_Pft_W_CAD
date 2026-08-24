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
 * Optional disturbance: an "Add obstacle" toggle drops a solid (square,
 * circle, or triangle) into the plume that can be click-and-dragged around.
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
  const [obstacleShape, setObstacleShapeState] = useState<
    "square" | "circle" | "triangle"
  >("square");

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
    // Check obstacleOn BEFORE touching overlayRef: the overlay div is only
    // rendered while obstacleOn is true (see JSX below), so on the toggle
    // that turns it off, overlayRef.current is already null by the time
    // this effect re-runs. Reading the ref first and bailing on `!overlay`
    // used to skip the setObstacle(null, null) call entirely, leaving the
    // obstacle enabled (visible, deflecting the flow) with nothing left to
    // drag it with.
    if (!obstacleOn) {
      controllerRef.current?.setObstacle?.(null, null);
      draggingRef.current = false;
      return;
    }

    const overlay = overlayRef.current;
    if (!overlay) return;

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
    controllerRef.current?.setObstacleShape?.(obstacleShape);
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

  // Re-push the shape whenever it changes while obstacle mode is already
  // on, without tearing down/re-adding the drag listeners above.
  useEffect(() => {
    if (!obstacleOn) return;
    controllerRef.current?.setObstacleShape?.(obstacleShape);
  }, [obstacleOn, obstacleShape]);

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
      {obstacleOn && (
        <div
          aria-hidden="false"
          role="group"
          aria-label="Obstacle shape"
          className="fixed right-6 bottom-20 z-50 flex gap-2"
        >
          {(["square", "circle", "triangle"] as const).map((shape) => (
            <button
              key={shape}
              type="button"
              onClick={() => setObstacleShapeState(shape)}
              aria-pressed={obstacleShape === shape}
              title={shape}
              className={`flex h-9 w-9 items-center justify-center rounded-full border backdrop-blur transition-colors ${
                obstacleShape === shape
                  ? "border-[var(--foreground)] bg-[rgba(7,8,9,0.85)] text-[var(--foreground)]"
                  : "border-[var(--border)] bg-[rgba(7,8,9,0.7)] text-[var(--muted)] hover:text-[var(--foreground)]"
              }`}
            >
              <ShapeIcon shape={shape} />
            </button>
          ))}
        </div>
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

function ShapeIcon({ shape }: { shape: "square" | "circle" | "triangle" }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      {shape === "square" && (
        <rect x="2" y="2" width="12" height="12" fill="currentColor" />
      )}
      {shape === "circle" && <circle cx="8" cy="8" r="6" fill="currentColor" />}
      {shape === "triangle" && (
        <polygon points="8,2 14,14 2,14" fill="currentColor" />
      )}
    </svg>
  );
}
