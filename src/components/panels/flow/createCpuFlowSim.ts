"use client";

import type { FlowController } from "./types";

/**
 * CPU (canvas 2D) fallback backend — the original working implementation,
 * used automatically whenever WebGL2 isn't available. Same physics, same
 * visuals, same public interface as the GPU backend.
 */

const BASE_NY = 64;
const MIN_NX = 80;
const MAX_NX = 220;
const PROJECT_ITERATIONS = 30;
const U_INF = 1.0;

const BASE_TIME_SCALE = 35;
const MAX_SUBSTEP_DT = 0.16;
const DYE_SPEED_MULTIPLIER = 1.5;

const SMOKE_BAND_MARGIN = 3;
const STRIPE_SPACING = 3;
const STRIPE_WIDTH = 2;
const SMOKE_BLUR_PX = 1.1;

export function createCpuFlowSim(
  canvas: HTMLCanvasElement,
  isPlayingRef: { current: boolean },
): FlowController | null {
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) return null;
  const ctx: CanvasRenderingContext2D = context;

  let NX = MIN_NX;
  let NY = BASE_NY;

  let u = new Float32Array(NX * NY);
  let v = new Float32Array(NX * NY);
  let u0 = new Float32Array(NX * NY);
  let v0 = new Float32Array(NX * NY);
  let p = new Float32Array(NX * NY);
  let div = new Float32Array(NX * NY);
  let solid = new Uint8Array(NX * NY);
  let dye = new Float32Array(NX * NY);
  let dye0 = new Float32Array(NX * NY);

  const fieldCanvas = document.createElement("canvas");
  const fieldCtx = fieldCanvas.getContext("2d");
  let fieldImage: ImageData | null = null;

  let width = 0;
  let height = 0;
  let dpr = 1;

  let bodyFracX = 0.42;
  let bodyFracY = 0.5;
  let targetFracX = bodyFracX;
  let targetFracY = bodyFracY;
  let bodyX = 0;
  let bodyY = 0;
  let bodyRadius = 1;
  let hovering = false;
  let raf = 0;
  let running = false;
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

  function allocateGrid(newNX: number, newNY: number) {
    NX = newNX;
    NY = newNY;
    u = new Float32Array(NX * NY);
    v = new Float32Array(NX * NY);
    u0 = new Float32Array(NX * NY);
    v0 = new Float32Array(NX * NY);
    p = new Float32Array(NX * NY);
    div = new Float32Array(NX * NY);
    solid = new Uint8Array(NX * NY);
    dye = new Float32Array(NX * NY);
    dye0 = new Float32Array(NX * NY);

    fieldCanvas.width = NX;
    fieldCanvas.height = NY;
    fieldImage = fieldCtx ? fieldCtx.createImageData(NX, NY) : null;
  }

  function updateBodyMask() {
    bodyX = bodyFracX * NX;
    bodyY = bodyFracY * NY;
    bodyRadius = Math.max(4, Math.min(NX, NY) * 0.14);
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

  function isEdgeSolid(x: number, y: number) {
    if (!solid[idx(x, y)]) return false;
    if (x === 0 || x === NX - 1 || y === 0 || y === NY - 1) return true;
    return (
      !solid[idx(x + 1, y)] ||
      !solid[idx(x - 1, y)] ||
      !solid[idx(x, y + 1)] ||
      !solid[idx(x, y - 1)]
    );
  }

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    width = canvas.clientWidth;
    height = canvas.clientHeight;
    canvas.width = Math.max(1, Math.round(width * dpr));
    canvas.height = Math.max(1, Math.round(height * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const aspect = height > 0 ? width / height : 2;
    const nextNX = clamp(Math.round(BASE_NY * aspect), MIN_NX, MAX_NX);
    const nextNY = BASE_NY;

    if (nextNX !== NX || nextNY !== NY) {
      allocateGrid(nextNX, nextNY);
      applyInletBoundary();
    }

    updateBodyMask();
    ctx.fillStyle = "rgb(7, 8, 9)";
    ctx.fillRect(0, 0, width, height);
  }

  function applyInletBoundary() {
    for (let y = 0; y < NY; y++) {
      u[idx(0, y)] = U_INF;
      v[idx(0, y)] = 0;
      u[idx(1, y)] = U_INF;
    }
    for (let x = 0; x < NX; x++) {
      u[idx(x, 0)] = U_INF;
      v[idx(x, 0)] = 0;
      u[idx(x, NY - 1)] = U_INF;
      v[idx(x, NY - 1)] = 0;
    }
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
    const centerY = NY / 2;
    const bandHalf = bodyRadius + SMOKE_BAND_MARGIN;
    if (Math.abs(y - centerY) > bandHalf) return 0;
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
        const bx = x - u[i] * dt * DYE_SPEED_MULTIPLIER;
        const by = y - v[i] * dt * DYE_SPEED_MULTIPLIER;
        dye[i] = sampleField(dye0, bx, by);
      }
    }

    for (let y = 1; y < NY - 1; y++) {
      const source = stripeSource(y);
      dye[idx(0, y)] = source;
      dye[idx(1, y)] = source;
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

    drawBody();
  }

  function drawBody() {
    const sx = width / NX;
    const sy = height / NY;
    const pad = 0.6;

    ctx.fillStyle = "rgb(7, 8, 9)";
    for (let y = 0; y < NY; y++) {
      for (let x = 0; x < NX; x++) {
        if (solid[idx(x, y)]) {
          ctx.fillRect(x * sx - pad, y * sy - pad, sx + pad * 2, sy + pad * 2);
        }
      }
    }

    ctx.fillStyle = "rgba(143, 163, 176, 0.95)";
    for (let y = 0; y < NY; y++) {
      for (let x = 0; x < NX; x++) {
        if (isEdgeSolid(x, y)) {
          ctx.fillRect(x * sx - pad, y * sy - pad, sx + pad * 2, sy + pad * 2);
        }
      }
    }
  }

  function step(dt: number) {
    if (hovering) {
      bodyFracX += (targetFracX - bodyFracX) * 0.12;
      bodyFracY += (targetFracY - bodyFracY) * 0.12;
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
    if (!running) return;

    const dt = Math.min(0.045, Math.max(0.001, (now - last) / 1000));
    last = now;

    const totalDt = dt * BASE_TIME_SCALE;
    const substeps = Math.max(1, Math.ceil(totalDt / MAX_SUBSTEP_DT));
    const stepDt = totalDt / substeps;
    for (let s = 0; s < substeps; s++) step(stepDt);

    drawSmoke();

    raf = requestAnimationFrame(render);
  }

  function start() {
    if (running) return;
    running = true;
    last = performance.now();
    raf = requestAnimationFrame(render);
  }

  function stop() {
    running = false;
    cancelAnimationFrame(raf);
  }

  const onPointerMove = (event: PointerEvent) => {
    const rect = canvas.getBoundingClientRect();
    const marginX = (bodyRadius + 2) / NX;
    const marginY = (bodyRadius + 2) / NY;
    targetFracX = clamp(
      (event.clientX - rect.left) / Math.max(rect.width, 1),
      marginX,
      1 - marginX,
    );
    targetFracY = clamp(
      (event.clientY - rect.top) / Math.max(rect.height, 1),
      marginY,
      1 - marginY,
    );
    hovering = true;
  };

  const onPointerLeave = () => {
    hovering = false;
  };

  const onVisibilityChange = () => {
    if (document.hidden) {
      stop();
    } else if (isPlayingRef.current) {
      start();
    }
  };

  allocateGrid(MIN_NX, BASE_NY);
  resize();
  applyInletBoundary();
  project(PROJECT_ITERATIONS);
  drawSmoke();

  window.addEventListener("resize", resize);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerleave", onPointerLeave);
  document.addEventListener("visibilitychange", onVisibilityChange);

  return {
    start,
    stop,
    destroy() {
      stop();
      window.removeEventListener("resize", resize);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerleave", onPointerLeave);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    },
  };
}
