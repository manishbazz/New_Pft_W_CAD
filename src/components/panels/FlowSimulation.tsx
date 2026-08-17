"use client";

import { useEffect, useRef } from "react";

/**
 * Low-resolution 2D incompressible Navier–Stokes visualization.
 *
 * Formulation:
 *   ∂ω/∂t + u·∇ω = ν∇²ω
 *   ∇²ψ = -ω
 *   u =  ∂ψ/∂y
 *   v = -∂ψ/∂x
 *
 * We deliberately solve on a coarse grid and render to a normal-resolution
 * canvas. This keeps the simulation inexpensive while retaining a real
 * viscous wake behind the mouse-controlled circular body.
 */

const NX = 96;
const NY = 48;
const ITERATIONS = 18;
const SOLVE_EVERY = 2;
const U_INF = 1.0;
const RE = 80;
const VISCOSITY = 1 / RE;
const MAX_PARTICLES = 150;
const SEED_ROWS = 15;

type Particle = { x: number; y: number };

export function FlowSimulation() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) return;

    const omega = new Float32Array(NX * NY);
    const omegaNext = new Float32Array(NX * NY);
    const psi = new Float32Array(NX * NY);
    const psiNext = new Float32Array(NX * NY);
    const u = new Float32Array(NX * NY);
    const v = new Float32Array(NX * NY);
    const solid = new Uint8Array(NX * NY);

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
    let frame = 0;

    const particles: Particle[] = [];

    const idx = (x: number, y: number) => y * NX + x;
    const clamp = (x: number, lo: number, hi: number) =>
      Math.max(lo, Math.min(hi, x));

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

    function resetParticles() {
      particles.length = 0;
      for (let i = 0; i < MAX_PARTICLES; i++) {
        particles.push({
          x: Math.random() * NX,
          y: 2 + Math.random() * (NY - 4),
        });
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

    function setInletAndFarField() {
      // Uniform left-to-right streamfunction:
      // ψ = U*y on the outer boundary.
      for (let y = 0; y < NY; y++) {
        const value = U_INF * y;
        psi[idx(0, y)] = value;
        psi[idx(NX - 1, y)] = value;
      }
      for (let x = 0; x < NX; x++) {
        psi[idx(x, 0)] = 0;
        psi[idx(x, NY - 1)] = U_INF * (NY - 1);
      }
    }

    function solveStreamfunction() {
      setInletAndFarField();

      // Jacobi relaxation for ∇²ψ = -ω.
      for (let k = 0; k < ITERATIONS; k++) {
        for (let y = 1; y < NY - 1; y++) {
          for (let x = 1; x < NX - 1; x++) {
            const i = idx(x, y);
            if (solid[i]) {
              psiNext[i] = U_INF * bodyY;
              continue;
            }

            psiNext[i] =
              0.25 *
              (psi[idx(x + 1, y)] +
                psi[idx(x - 1, y)] +
                psi[idx(x, y + 1)] +
                psi[idx(x, y - 1)] +
                omega[i]);
          }
        }

        for (let x = 1; x < NX - 1; x++) {
          psiNext[idx(x, 0)] = 0;
          psiNext[idx(x, NY - 1)] = U_INF * (NY - 1);
        }
        for (let y = 0; y < NY; y++) {
          psiNext[idx(0, y)] = U_INF * y;
          psiNext[idx(NX - 1, y)] = U_INF * y;
        }

        psi.set(psiNext);
      }
    }

    function updateVelocity() {
      for (let y = 1; y < NY - 1; y++) {
        for (let x = 1; x < NX - 1; x++) {
          const i = idx(x, y);
          if (solid[i]) {
            u[i] = 0;
            v[i] = 0;
            continue;
          }

          u[i] = 0.5 * (psi[idx(x, y + 1)] - psi[idx(x, y - 1)]);
          v[i] = -0.5 * (psi[idx(x + 1, y)] - psi[idx(x - 1, y)]);
        }
      }

      // Uniform inflow/outflow and far-field values.
      for (let y = 0; y < NY; y++) {
        u[idx(0, y)] = U_INF;
        u[idx(NX - 1, y)] = U_INF;
        v[idx(0, y)] = 0;
        v[idx(NX - 1, y)] = 0;
      }
      for (let x = 0; x < NX; x++) {
        u[idx(x, 0)] = U_INF;
        u[idx(x, NY - 1)] = U_INF;
        v[idx(x, 0)] = 0;
        v[idx(x, NY - 1)] = 0;
      }
    }

    function sampleVelocity(x: number, y: number): [number, number] {
      if (x < 0 || x > NX - 1 || y < 0 || y > NY - 1) return [U_INF, 0];

      const x0 = Math.floor(x);
      const y0 = Math.floor(y);
      const x1 = Math.min(NX - 1, x0 + 1);
      const y1 = Math.min(NY - 1, y0 + 1);
      const tx = x - x0;
      const ty = y - y0;

      const i00 = idx(x0, y0);
      const i10 = idx(x1, y0);
      const i01 = idx(x0, y1);
      const i11 = idx(x1, y1);

      return [
        (u[i00] * (1 - tx) + u[i10] * tx) * (1 - ty) +
          (u[i01] * (1 - tx) + u[i11] * tx) * ty,
        (v[i00] * (1 - tx) + v[i10] * tx) * (1 - ty) +
          (v[i01] * (1 - tx) + v[i11] * tx) * ty,
      ];
    }

    function advectVorticity(dt: number) {
      // Semi-Lagrangian advection plus explicit diffusion. This is stable at
      // the deliberately low simulation resolution used by the portfolio.
      const diffusion = VISCOSITY * dt;

      for (let y = 1; y < NY - 1; y++) {
        for (let x = 1; x < NX - 1; x++) {
          const i = idx(x, y);
          if (solid[i]) {
            omegaNext[i] = 0;
            continue;
          }

          const [vx, vy] = sampleVelocity(x, y);
          const bx = clamp(x - vx * dt, 0, NX - 1);
          const by = clamp(y - vy * dt, 0, NY - 1);
          const x0 = Math.floor(bx);
          const y0 = Math.floor(by);
          const x1 = Math.min(NX - 1, x0 + 1);
          const y1 = Math.min(NY - 1, y0 + 1);
          const tx = bx - x0;
          const ty = by - y0;

          const advected =
            (omega[idx(x0, y0)] * (1 - tx) +
              omega[idx(x1, y0)] * tx) *
              (1 - ty) +
            (omega[idx(x0, y1)] * (1 - tx) +
              omega[idx(x1, y1)] * tx) *
              ty;

          const lap =
            omega[idx(x + 1, y)] +
            omega[idx(x - 1, y)] +
            omega[idx(x, y + 1)] +
            omega[idx(x, y - 1)] -
            4 * omega[i];

          omegaNext[i] = advected + diffusion * lap;
        }
      }

      // Inlet has zero incoming vorticity.
      for (let y = 0; y < NY; y++) omegaNext[idx(0, y)] = 0;

      // Lightweight no-slip wall vorticity (Thom-style boundary closure).
      const r = bodyRadius;
      const wallValue = -2 / Math.max(r * r, 1);
      for (let y = 1; y < NY - 1; y++) {
        for (let x = 1; x < NX - 1; x++) {
          const i = idx(x, y);
          if (!solid[i]) continue;

          let neighbor = false;
          const dirs = [
            [1, 0],
            [-1, 0],
            [0, 1],
            [0, -1],
          ];
          for (const [dx, dy] of dirs) {
            if (!solid[idx(x + dx, y + dy)]) {
              neighbor = true;
              break;
            }
          }
          if (neighbor) omegaNext[i] = wallValue;
        }
      }

      omega.set(omegaNext);
    }

    function seedParticles() {
      for (let row = 0; row < SEED_ROWS; row++) {
        const y = 2 + (row / (SEED_ROWS - 1)) * (NY - 4);
        particles[row].x = Math.random() * 4;
        particles[row].y = y;
      }
    }

    function drawParticles(dt: number) {
      ctx.fillStyle = "rgba(7, 8, 9, 0.16)";
      ctx.fillRect(0, 0, width, height);

      const sx = width / NX;
      const sy = height / NY;

      ctx.fillStyle = "rgba(143, 163, 176, 0.72)";
      for (const p of particles) {
        const [vx, vy] = sampleVelocity(p.x, p.y);
        const px = p.x;
        const py = p.y;

        p.x += vx * dt * 16;
        p.y += vy * dt * 16;

        const dx = p.x - bodyX;
        const dy = p.y - bodyY;
        if (
          p.x > NX + 2 ||
          p.y < 0 ||
          p.y > NY ||
          dx * dx + dy * dy < bodyRadius * bodyRadius
        ) {
          p.x = -Math.random() * 3;
          p.y = 2 + Math.random() * (NY - 4);
          continue;
        }

        const x0 = px * sx;
        const y0 = py * sy;
        const x1 = p.x * sx;
        const y1 = p.y * sy;

        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);
        ctx.strokeStyle = "rgba(143, 163, 176, 0.55)";
        ctx.lineWidth = 1;
        ctx.stroke();
      }

      // A few continuous instantaneous streamlines are drawn from the inlet.
      // These are reconstructed from the current velocity field.
      ctx.strokeStyle = "rgba(143, 163, 176, 0.28)";
      ctx.lineWidth = 0.7;

      for (let row = 0; row < SEED_ROWS; row++) {
        let x = 0;
        let y = 2 + (row / (SEED_ROWS - 1)) * (NY - 4);
        ctx.beginPath();
        ctx.moveTo(x * sx, y * sy);

        for (let step = 0; step < 130 && x < NX; step++) {
          const [vx, vy] = sampleVelocity(x, y);
          const speed = Math.max(0.2, Math.hypot(vx, vy));
          x += (vx / speed) * 0.65;
          y += (vy / speed) * 0.65;

          if (y < 0 || y > NY) break;

          const dx = x - bodyX;
          const dy = y - bodyY;
          if (dx * dx + dy * dy < bodyRadius * bodyRadius) break;

          ctx.lineTo(x * sx, y * sy);
        }
        ctx.stroke();
      }

      // Body.
      ctx.beginPath();
      ctx.arc(bodyX * sx, bodyY * sy, bodyRadius * sx, 0, Math.PI * 2);
      ctx.fillStyle = "rgb(7, 8, 9)";
      ctx.fill();
      ctx.strokeStyle = "rgba(143, 163, 176, 0.95)";
      ctx.lineWidth = 1.2;
      ctx.stroke();
    }

    function render(now: number) {
      const dt = Math.min(0.045, Math.max(0.001, (now - last) / 1000));
      last = now;

      if (hovering) {
        bodyX += (targetX - bodyX) * 0.12;
        bodyY += (targetY - bodyY) * 0.12;
        updateBodyMask();
      }

      // The solver runs at a deliberately lower cadence than the renderer.
      if (frame % SOLVE_EVERY === 0) {
        advectVorticity(dt * 16);
        solveStreamfunction();
        updateVelocity();
      }

      drawParticles(dt);

      frame++;
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
    resetParticles();
    seedParticles();
    solveStreamfunction();
    updateVelocity();

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
        2D Navier–Stokes flow — move the cylinder with your cursor
      </p>
      <canvas
        ref={canvasRef}
        className="h-48 w-full touch-none rounded-md border border-[var(--border)] sm:h-56"
        aria-label="Interactive two-dimensional viscous flow simulation"
      />
    </div>
  );
}
