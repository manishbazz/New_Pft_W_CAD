"use client";

import { useEffect, useRef } from "react";

/**
 * Low-resolution 2D incompressible flow visualization using the Stable
 * Fluids method (Stam, 1999): direct velocity-field projection via
 * Gauss-Seidel relaxation to enforce incompressibility, rather than a
 * vorticity–streamfunction formulation. This is the same approach used by
 * reference Eulerian solvers that reproduce correct vortex shedding
 * (e.g. https://github.com/xzips/Euler-Fluid-Simulation):
 *
 *   1. Apply boundary conditions (inlet, far-field, obstacle).
 *   2. Project: solve for pressure via Gauss-Seidel so that ∇·u = 0,
 *      then subtract ∇p from the velocity field.
 *   3. Re-enforce obstacle boundary (no-slip solid).
 *   4. Self-advect velocity (semi-Lagrangian).
 *   5. Project again (advection reintroduces divergence).
 *   6. Advect dye (passive scalar) through the divergence-free field.
 *
 * No explicit viscosity term is used — as in the Euler-equation reference
 * above, the coarse grid's numerical dissipation is what produces shedding.
 * The dye field has no decay: it's a bounded convex combination under
 * semi-Lagrangian advection, so streaklines stay at full strength until
 * they're actually carried out through the open right boundary.
 */

const NX = 96;
const NY = 48;
const PROJECT_ITERATIONS = 26;
const U_INF = 1.0;
const TIME_SCALE = 20; // grid-units of advection per second

// Smoke field tuning.
const STRIPE_SPACING = 4; // grid rows per light/dark stripe pair
const STRIPE_WIDTH = 2; // rows of "on" smoke within each pair
const SMOKE_BLUR_PX = 1.1;

export function FlowSimulation() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvasElement = canvasRef.current;
    if (!canvasElement) return;

    const context = canvasElement.getContext("2d", { alpha: false });
    if (!context) return;

    const canvas: HTMLCanvasElement = canvasElement;
    const ctx: CanvasRenderingContext2D = context;

    const u = new Float32Array(NX * NY);
    const v = new Float32Array(NX * NY);
    const u0 = new Float32Array(NX * NY);
    const v0 = new Float32Array(NX * NY);
    const p = new Float32Array(NX * NY);
    const div = new Float32Array(NX * NY);
    const solid = new Uint8Array(NX * NY);
    const dye = new Float32Array(NX * NY);
    const dye0 = new Float32Array(NX * NY);

    // Offscreen low-res surface the dye field is written into, then
    // upscaled with bilinear smoothing onto the visible canvas.
    const fieldCanvas = document.createElement("canvas");
    fieldCanvas.width = NX;
    fieldCanvas.height = NY;
    const fieldCtx = fieldCanvas.getContext("2d");
    const fieldImage = fieldCtx?.createImageData(NX, NY) ?? null;

    let width = 0;
    let height = 0;
    let dpr = 1;
    let bodyX = NX * 0.42;
    let bodyY = NY * 0.5;
    let targetX = bodyX;
    let targetY = bodyY;
    let bodyRadius = Math.min(NX, NY) * 0.14;
    let hovering = false;
    let raf = 0;
    let last = performance.now();

    const idx = (x: number, y: number) => y * NX + x;
    const clamp = (x: number, lo: number, hi: number) =>
      Math.max(lo, Math.min(hi, x));

    function sampleField(field: Float32Array, x: number, y: number) {
      const cx = clamp(x, 0, NX - 1.001);
      const cy = clamp(y, 0, NY - 1.001);
      const x0 = Math.floor(cx);
      const y0 = Math.floor(cy);
      const x1 = x0 + 1;
      const y1 = y0 + 1;
      const tx = cx - x0;
      const ty = cy - y0;

      const i00 = idx(x0, y0);
      const i10 = idx(x1, y0);
      const i01 = idx(x0, y1);
      const i11 = idx(x1, y1);

      return (
        (field[i00] * (1 - tx) + field[i10] * tx) * (1 - ty) +
        (field[i01] * (1 - tx) + field[i11] * tx) * ty
      );
    }

    function updateBodyMask() {
      bodyRadius = Math.max(5, Math.min(NX, NY) * 0.14);
      solid.fill(0);
      const r2 = bodyRadius * bodyRadius;

      for (let y = 1; y < NY - 1; y++) {
        for (let x = 1; x < NX - 1; x++) {
          const dx = x - bodyX;
          const dy = y - bodyY;
          if (dx * dx + dy * dy <= r2) solid[idx(x, y)] = 1;
        }
      }
    }

    function resize() {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = canvas.clientWidth;
      height = canvas.clientHeight;
      canvas.width = Math.max(1, Math.round(width * dpr));
      canvas.height = Math.max(1, Math.round(height * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      updateBodyMask();
      ctx.fillStyle = "rgb(7, 8, 9)";
      ctx.fillRect(0, 0, width, height);
    }

    function applyInletBoundary() {
      // Left inlet: fixed uniform inflow.
      for (let y = 0; y < NY; y++) {
        u[idx(0, y)] = U_INF;
        v[idx(0, y)] = 0;
        u[idx(1, y)] = U_INF;
      }
      // Top/bottom far-field: uniform flow (free-slip).
      for (let x = 0; x < NX; x++) {
        u[idx(x, 0)] = U_INF;
        v[idx(x, 0)] = 0;
        u[idx(x, NY - 1)] = U_INF;
        v[idx(x, NY - 1)] = 0;
      }
      // Right outlet: open boundary (zero-gradient).
      for (let y = 0; y < NY; y++) {
        u[idx(NX - 1, y)] = u[idx(NX - 2, y)];
        v[idx(NX - 1, y)] = v[idx(NX - 2, y)];
      }
    }

    function enforceObstacle() {
      for (let i = 0; i < NX * NY; i++) {
        if (solid[i]) {
          u[i] = 0;
          v[i] = 0;
        }
      }
    }

    function setScalarBoundary(field: Float32Array) {
      for (let y = 0; y < NY; y++) {
        field[idx(0, y)] = field[idx(1, y)];
        field[idx(NX - 1, y)] = field[idx(NX - 2, y)];
      }
      for (let x = 0; x < NX; x++) {
        field[idx(x, 0)] = field[idx(x, 1)];
        field[idx(x, NY - 1)] = field[idx(x, NY - 2)];
      }
    }

    // Neighbor pressure with Neumann (zero-flux) mirroring across solid
    // cells, so the projection never pulls flow into the obstacle.
    function neighborPressure(cx: number, cy: number, self: number) {
      const i = idx(cx, cy);
      return solid[i] ? self : p[i];
    }

    function project(iterations: number) {
      for (let y = 1; y < NY - 1; y++) {
        for (let x = 1; x < NX - 1; x++) {
          const i = idx(x, y);
          if (solid[i]) {
            div[i] = 0;
            p[i] = 0;
            continue;
          }
          div[i] =
            -0.5 *
            (u[idx(x + 1, y)] -
              u[idx(x - 1, y)] +
              (v[idx(x, y + 1)] - v[idx(x, y - 1)]));
          p[i] = 0;
        }
      }

      for (let k = 0; k < iterations; k++) {
        for (let y = 1; y < NY - 1; y++) {
          for (let x = 1; x < NX - 1; x++) {
            const i = idx(x, y);
            if (solid[i]) {
              p[i] = 0;
              continue;
            }
            const pl = neighborPressure(x - 1, y, p[i]);
            const pr = neighborPressure(x + 1, y, p[i]);
            const pd = neighborPressure(x, y - 1, p[i]);
            const puN = neighborPressure(x, y + 1, p[i]);
            p[i] = (div[i] + pl + pr + pd + puN) * 0.25;
          }
        }
        setScalarBoundary(p);
      }

      for (let y = 1; y < NY - 1; y++) {
        for (let x = 1; x < NX - 1; x++) {
          const i = idx(x, y);
          if (solid[i]) continue;
          const pl = neighborPressure(x - 1, y, p[i]);
          const pr = neighborPressure(x + 1, y, p[i]);
          const pd = neighborPressure(x, y - 1, p[i]);
          const puN = neighborPressure(x, y + 1, p[i]);
          u[i] -= 0.5 * (pr - pl);
          v[i] -= 0.5 * (puN - pd);
        }
      }
    }

    function advectVelocity(dt: number) {
      u0.set(u);
      v0.set(v);

      for (let y = 1; y < NY - 1; y++) {
        for (let x = 1; x < NX - 1; x++) {
          const i = idx(x, y);
          if (solid[i]) {
            u[i] = 0;
            v[i] = 0;
            continue;
          }
          const bx = x - u0[i] * dt;
          const by = y - v0[i] * dt;
          u[i] = sampleField(u0, bx, by);
          v[i] = sampleField(v0, bx, by);
        }
      }

      applyInletBoundary();
      enforceObstacle();
    }

    function stripeSource(y: number) {
      const band = Math.floor(y) % STRIPE_SPACING;
      return band < STRIPE_WIDTH ? 1 : 0;
    }

    function advectDye(dt: number) {
      dye0.set(dye);

      for (let y = 1; y < NY - 1; y++) {
        for (let x = 1; x < NX - 1; x++) {
          const i = idx(x, y);
          if (solid[i]) {
            dye[i] = 0;
            continue;
          }
          const bx = x - u[i] * dt;
          const by = y - v[i] * dt;
          // Bounded convex combination — no decay term, so intensity is
          // only lost when a parcel is actually advected past the edges.
          dye[i] = sampleField(dye0, bx, by);
        }
      }

      // Continuous smoke source: alternating streaklines at the inlet.
      for (let y = 1; y < NY - 1; y++) {
        dye[idx(0, y)] = stripeSource(y);
        dye[idx(1, y)] = stripeSource(y);
      }
      for (let x = 0; x < NX; x++) {
        dye[idx(x, 0)] = 0;
        dye[idx(x, NY - 1)] = 0;
      }
    }

    function drawSmoke() {
      if (fieldCtx && fieldImage) {
        const data = fieldImage.data;
        for (let i = 0; i < NX * NY; i++) {
          const a = dye[i];
          const o = i * 4;
          data[o] = 7 + (143 - 7) * a;
          data[o + 1] = 8 + (163 - 8) * a;
          data[o + 2] = 9 + (176 - 9) * a;
          data[o + 3] = 255;
        }
        fieldCtx.putImageData(fieldImage, 0, 0);
      }

      ctx.fillStyle = "rgb(7, 8, 9)";
      ctx.fillRect(0, 0, width, height);

      if (fieldCtx) {
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        ctx.filter = `blur(${SMOKE_BLUR_PX}px)`;
        ctx.drawImage(fieldCanvas, 0, 0, width, height);
        ctx.filter = "none";
      }

      const sx = width / NX;
      const sy = height / NY;
      ctx.beginPath();
      ctx.arc(bodyX * sx, bodyY * sy, bodyRadius * sx, 0, Math.PI * 2);
      ctx.fillStyle = "rgb(7, 8, 9)";
      ctx.fill();
      ctx.strokeStyle = "rgba(143, 163, 176, 0.95)";
      ctx.lineWidth = 1.2;
      ctx.stroke();
    }

    function step(dt: number) {
      if (hovering) {
        bodyX += (targetX - bodyX) * 0.12;
        bodyY += (targetY - bodyY) * 0.12;
        updateBodyMask();
      }

      applyInletBoundary();
      enforceObstacle();
      project(PROJECT_ITERATIONS);
      enforceObstacle();
      advectVelocity(dt);
      project(PROJECT_ITERATIONS);
      advectDye(dt);
    }

    function render(now: number) {
      const dt = Math.min(0.045, Math.max(0.001, (now - last) / 1000));
      last = now;

      step(dt * TIME_SCALE * 0.06);
      drawSmoke();

      raf = requestAnimationFrame(render);
    }

    const onPointerMove = (event: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      targetX = clamp(
        ((event.clientX - rect.left) / Math.max(rect.width, 1)) * NX,
        bodyRadius + 2,
        NX - bodyRadius - 2,
      );
      targetY = clamp(
        ((event.clientY - rect.top) / Math.max(rect.height, 1)) * NY,
        bodyRadius + 2,
        NY - bodyRadius - 2,
      );
      hovering = true;
    };

    const onPointerLeave = () => {
      hovering = false;
    };

    resize();
    applyInletBoundary();
    project(PROJECT_ITERATIONS);

    window.addEventListener("resize", resize);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerleave", onPointerLeave);
    raf = requestAnimationFrame(render);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerleave", onPointerLeave);
    };
  }, []);

  return (
    <div className="relative">
      <p className="mb-2 text-[10px] tracking-[0.2em] text-[var(--muted)] uppercase">
        2D flow simulation — move the cylinder with your cursor
      </p>
      <canvas
        ref={canvasRef}
        className="h-48 w-full touch-none rounded-md border border-[var(--border)] sm:h-56"
        aria-label="Interactive two-dimensional flow simulation with smoke visualization"
      />
    </div>
  );
}