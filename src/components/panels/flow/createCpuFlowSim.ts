"use client";

import type { FlowController, FlowView } from "./types";
import {
  createStrouhalMeter,
  FLOW_BODY_X,
  FLOW_BODY_Y,
  FLOW_DIAMETER,
  FLOW_MAX_NX,
  FLOW_MAX_STEPS_PER_FRAME,
  FLOW_MAX_SUBSTEP_DT,
  FLOW_MIN_NX,
  FLOW_NU,
  FLOW_NY,
  FLOW_PROBE_DX,
  FLOW_PROBE_DY,
  FLOW_RE,
  FLOW_SMOKE_BAND_MARGIN,
  FLOW_SOR_OMEGA,
  FLOW_SOR_PASSES,
  FLOW_STRIPE_SPACING,
  FLOW_STRIPE_WIDTH,
  FLOW_TIME_SCALE,
  FLOW_U_INF,
} from "./flowParams";

/**
 * CPU (canvas 2D) fallback backend — used automatically when WebGL2 or
 * float render targets aren't available. Same equations, scheme, boundary
 * conditions and parameters as createGpuFlowSim.ts (see that file and
 * flowParams.ts): MacCormack advection, explicit viscosity (nu = U D / Re),
 * red-black SOR projection warm-started across steps with p = 0 at the
 * outlet, and a moving no-slip cylinder.
 *
 * Grid is cell-centred with bilinear clamp-to-edge sampling, matching the
 * GPU texture sampling. Row 0 is the TOP of the canvas here (canvas 2D
 * convention); the physics is symmetric so only pointer mapping cares.
 */

const SMOKE_BLUR_PX = 1.1;

export function createCpuFlowSim(
  canvas: HTMLCanvasElement,
  isPlayingRef: { current: boolean },
): FlowController | null {
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) return null;
  const ctx: CanvasRenderingContext2D = context;

  const NY = FLOW_NY;
  let NX = FLOW_MIN_NX;
  let N = NX * NY;

  let u = new Float32Array(N);
  let v = new Float32Array(N);
  let tu = new Float32Array(N);
  let tv = new Float32Array(N);
  let hu = new Float32Array(N);
  let hv = new Float32Array(N);
  let p = new Float32Array(N);
  let div = new Float32Array(N);
  let solid = new Uint8Array(N);
  let dye = new Float32Array(N);
  let tdye = new Float32Array(N);
  let hdye = new Float32Array(N);

  const fieldCanvas = document.createElement("canvas");
  const fieldCtx = fieldCanvas.getContext("2d");
  let fieldImage: ImageData | null = null;

  let width = 0;
  let height = 0;

  let bodyFracX = FLOW_BODY_X;
  let bodyFracY = FLOW_BODY_Y;
  let targetFracX = bodyFracX;
  let targetFracY = bodyFracY;
  let bodyX = 0;
  let bodyY = 0;
  let bodyVelX = 0;
  let bodyVelY = 0;
  let hovering = false;
  let raf = 0;
  let running = false;
  let last = performance.now();
  let acc = 0;
  let simTime = 0;
  let view: FlowView = "dye";
  const meter = createStrouhalMeter();
  const radius = FLOW_DIAMETER / 2;

  const idx = (x: number, y: number) => y * NX + x;
  const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

  /** Bilinear sample at grid position (cell centres at i + 0.5). */
  function sample(f: Float32Array, gx: number, gy: number) {
    const x = clamp(gx - 0.5, 0, NX - 1);
    const y = clamp(gy - 0.5, 0, NY - 1);
    const x0 = Math.min(Math.floor(x), NX - 2);
    const y0 = Math.min(Math.floor(y), NY - 2);
    const tx = x - x0;
    const ty = y - y0;
    const i = y0 * NX + x0;
    return (
      f[i] * (1 - tx) * (1 - ty) +
      f[i + 1] * tx * (1 - ty) +
      f[i + NX] * (1 - tx) * ty +
      f[i + NX + 1] * tx * ty
    );
  }

  /** MacCormack advection of `f` into `out`, using `hat` as scratch. */
  function advect(f: Float32Array, out: Float32Array, hat: Float32Array, dt: number) {
    for (let y = 0; y < NY; y++) {
      for (let x = 0; x < NX; x++) {
        const i = idx(x, y);
        hat[i] = sample(f, x + 0.5 - u[i] * dt, y + 0.5 - v[i] * dt);
      }
    }
    for (let y = 0; y < NY; y++) {
      for (let x = 0; x < NX; x++) {
        const i = idx(x, y);
        const gx = x + 0.5;
        const gy = y + 0.5;
        const back = sample(hat, gx + u[i] * dt, gy + v[i] * dt);
        let c = hat[i] + 0.5 * (f[i] - back);
        // Limiter: clamp to the 4 cells around the back-traced point.
        const px = clamp(gx - u[i] * dt - 0.5, 0, NX - 1);
        const py = clamp(gy - v[i] * dt - 0.5, 0, NY - 1);
        const j = Math.min(Math.floor(py), NY - 2) * NX + Math.min(Math.floor(px), NX - 2);
        const a = f[j], b = f[j + 1], d = f[j + NX], e = f[j + NX + 1];
        c = clamp(c, Math.min(a, b, d, e), Math.max(a, b, d, e));
        out[i] = c;
      }
    }
  }

  function updateBodyMask() {
    bodyX = bodyFracX * NX;
    bodyY = bodyFracY * NY;
    const r2 = radius * radius;
    for (let y = 0; y < NY; y++) {
      for (let x = 0; x < NX; x++) {
        const dx = x + 0.5 - bodyX;
        const dy = y + 0.5 - bodyY;
        solid[idx(x, y)] = dx * dx + dy * dy < r2 ? 1 : 0;
      }
    }
  }

  function applyVelBC() {
    for (let y = 0; y < NY; y++) {
      for (let x = 0; x < 2; x++) {
        u[idx(x, y)] = FLOW_U_INF;
        v[idx(x, y)] = 0;
      }
      u[idx(NX - 1, y)] = u[idx(NX - 2, y)];
      v[idx(NX - 1, y)] = v[idx(NX - 2, y)];
    }
    for (let x = 0; x < NX; x++) {
      v[idx(x, 0)] = 0;
      v[idx(x, NY - 1)] = 0;
    }
    for (let i = 0; i < N; i++) {
      if (solid[i]) {
        u[i] = bodyVelX;
        v[i] = bodyVelY;
      }
    }
  }

  function allocateGrid(nx: number) {
    NX = nx;
    N = NX * NY;
    u = new Float32Array(N).fill(FLOW_U_INF);
    v = new Float32Array(N);
    tu = new Float32Array(N);
    tv = new Float32Array(N);
    hu = new Float32Array(N);
    hv = new Float32Array(N);
    p = new Float32Array(N);
    div = new Float32Array(N);
    solid = new Uint8Array(N);
    dye = new Float32Array(N);
    tdye = new Float32Array(N);
    hdye = new Float32Array(N);
    fieldCanvas.width = NX;
    fieldCanvas.height = NY;
    fieldImage = fieldCtx ? fieldCtx.createImageData(NX, NY) : null;
    updateBodyMask();
    // Small transverse kick behind the body to break symmetry.
    for (let y = 0; y < NY; y++) {
      for (let x = Math.floor(bodyX); x < Math.min(NX, bodyX + 6 * radius); x++) v[idx(x, y)] = 0.05;
    }
    applyVelBC();
    simTime = 0;
    meter.reset();
  }

  function pNeighbour(j: number, self: number) {
    return solid[j] ? self : p[j];
  }

  function project() {
    for (let y = 0; y < NY; y++) {
      for (let x = 0; x < NX; x++) {
        const i = idx(x, y);
        if (solid[i]) {
          div[i] = 0;
          continue;
        }
        const L = u[idx(Math.max(x - 1, 0), y)];
        const R = u[idx(Math.min(x + 1, NX - 1), y)];
        const B = v[idx(x, Math.max(y - 1, 0))];
        const T = v[idx(x, Math.min(y + 1, NY - 1))];
        div[i] = -0.5 * (R - L + (T - B));
      }
    }
    // Red-black SOR, warm-started (p is kept from the previous step).
    for (let pass = 0; pass < FLOW_SOR_PASSES; pass++) {
      const color = pass & 1;
      for (let y = 0; y < NY; y++) {
        for (let x = (y + color) & 1; x < NX; x += 2) {
          const i = idx(x, y);
          if (solid[i]) continue;
          if (x === NX - 1) {
            p[i] = 0; // outlet Dirichlet
            continue;
          }
          const self = p[i];
          const L = pNeighbour(idx(Math.max(x - 1, 0), y), self);
          const R = pNeighbour(idx(x + 1, y), self);
          const B = pNeighbour(idx(x, Math.max(y - 1, 0)), self);
          const T = pNeighbour(idx(x, Math.min(y + 1, NY - 1)), self);
          const gs = 0.25 * (div[i] + L + R + B + T);
          p[i] = self + FLOW_SOR_OMEGA * (gs - self);
        }
      }
    }
    for (let y = 0; y < NY; y++) {
      for (let x = 0; x < NX; x++) {
        const i = idx(x, y);
        if (solid[i]) continue;
        const self = p[i];
        const L = pNeighbour(idx(Math.max(x - 1, 0), y), self);
        const R = pNeighbour(idx(Math.min(x + 1, NX - 1), y), self);
        const B = pNeighbour(idx(x, Math.max(y - 1, 0)), self);
        const T = pNeighbour(idx(x, Math.min(y + 1, NY - 1)), self);
        u[i] -= 0.5 * (R - L);
        v[i] -= 0.5 * (T - B);
      }
    }
  }

  function diffuse(f: Float32Array, out: Float32Array, k: number) {
    for (let y = 0; y < NY; y++) {
      for (let x = 0; x < NX; x++) {
        const i = idx(x, y);
        const L = f[idx(Math.max(x - 1, 0), y)];
        const R = f[idx(Math.min(x + 1, NX - 1), y)];
        const B = f[idx(x, Math.max(y - 1, 0))];
        const T = f[idx(x, Math.min(y + 1, NY - 1))];
        out[i] = f[i] + k * (L + R + B + T - 4 * f[i]);
      }
    }
  }

  function step(dt: number) {
    const prevX = bodyFracX * NX;
    const prevY = bodyFracY * NY;
    if (hovering) {
      bodyFracX += (targetFracX - bodyFracX) * 0.12;
      bodyFracY += (targetFracY - bodyFracY) * 0.12;
    }
    bodyVelX = (bodyFracX * NX - prevX) / dt;
    bodyVelY = (bodyFracY * NY - prevY) / dt;
    if (hovering) updateBodyMask();
    if (Math.hypot(bodyVelX, bodyVelY) > 0.05) meter.reset();

    advect(u, tu, hu, dt);
    advect(v, tv, hv, dt);
    diffuse(tu, u, FLOW_NU * dt);
    diffuse(tv, v, FLOW_NU * dt);
    applyVelBC();
    project();
    applyVelBC();

    advect(dye, tdye, hdye, dt);
    const swap = dye;
    dye = tdye;
    tdye = swap;
    const bandHalf = radius + FLOW_SMOKE_BAND_MARGIN;
    for (let y = 0; y < NY; y++) {
      const inBand =
        Math.abs(y + 0.5 - NY * 0.5) <= bandHalf && y % FLOW_STRIPE_SPACING < FLOW_STRIPE_WIDTH;
      dye[idx(0, y)] = dye[idx(1, y)] = inBand ? 1 : 0;
    }
    for (let x = 0; x < NX; x++) dye[idx(x, 0)] = dye[idx(x, NY - 1)] = 0;
    for (let i = 0; i < N; i++) if (solid[i]) dye[i] = 0;
    simTime += dt;
  }

  function drawField() {
    if (!fieldImage || !fieldCtx) return;
    const data = fieldImage.data;
    const bg = [7, 8, 9];
    const fg = [143, 163, 176];
    for (let y = 0; y < NY; y++) {
      for (let x = 0; x < NX; x++) {
        const i = idx(x, y);
        let r: number, g: number, b: number;
        if (view === "vorticity") {
          const w =
            0.5 *
            (v[idx(Math.min(x + 1, NX - 1), y)] - v[idx(Math.max(x - 1, 0), y)] -
              (u[idx(x, Math.min(y + 1, NY - 1))] - u[idx(x, Math.max(y - 1, 0))]));
          // Row 0 is the top here, so flip the sign to match the GPU colours.
          const s = clamp(-w / 0.25, -1, 1);
          const k = Math.pow(Math.abs(s), 0.7);
          const c = s > 0 ? [219, 107, 92] : [84, 140, 219];
          r = bg[0] + (c[0] - bg[0]) * k;
          g = bg[1] + (c[1] - bg[1]) * k;
          b = bg[2] + (c[2] - bg[2]) * k;
        } else {
          const a =
            view === "speed"
              ? Math.floor(clamp(Math.hypot(u[i], v[i]) / 1.6, 0, 1) * 10) / 10
              : clamp(dye[i], 0, 1);
          r = bg[0] + (fg[0] - bg[0]) * a;
          g = bg[1] + (fg[1] - bg[1]) * a;
          b = bg[2] + (fg[2] - bg[2]) * a;
        }
        if (solid[i]) [r, g, b] = bg;
        const o = i * 4;
        data[o] = r;
        data[o + 1] = g;
        data[o + 2] = b;
        data[o + 3] = 255;
      }
    }
    fieldCtx.putImageData(fieldImage, 0, 0);
    ctx.fillStyle = "rgb(7, 8, 9)";
    ctx.fillRect(0, 0, width, height);
    ctx.imageSmoothingEnabled = true;
    ctx.filter = view === "dye" ? `blur(${SMOKE_BLUR_PX}px)` : "none";
    ctx.drawImage(fieldCanvas, 0, 0, width, height);
    ctx.filter = "none";
    // Body outline.
    const sx = width / NX;
    const sy = height / NY;
    ctx.beginPath();
    ctx.ellipse(bodyX * sx, bodyY * sy, radius * sx, radius * sy, 0, 0, Math.PI * 2);
    ctx.fillStyle = "rgb(7, 8, 9)";
    ctx.fill();
    ctx.strokeStyle = "rgba(143, 163, 176, 0.95)";
    ctx.lineWidth = 1.2;
    ctx.stroke();
  }

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    width = canvas.clientWidth;
    height = canvas.clientHeight;
    canvas.width = Math.max(1, Math.round(width * dpr));
    canvas.height = Math.max(1, Math.round(height * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const aspect = height > 0 ? width / height : 3;
    const nextNX = clamp(Math.round(NY * aspect), FLOW_MIN_NX, FLOW_MAX_NX);
    if (nextNX !== NX || simTime === 0) allocateGrid(nextNX);
    drawField();
  }

  function frame(now: number) {
    if (!running) return;
    const realDt = Math.min(0.05, Math.max(0, (now - last) / 1000));
    last = now;
    acc += realDt * FLOW_TIME_SCALE;
    let steps = 0;
    while (acc >= FLOW_MAX_SUBSTEP_DT && steps < FLOW_MAX_STEPS_PER_FRAME) {
      step(FLOW_MAX_SUBSTEP_DT);
      acc -= FLOW_MAX_SUBSTEP_DT;
      steps++;
    }
    if (steps === FLOW_MAX_STEPS_PER_FRAME) acc = 0;
    if (steps > 0) {
      const px = Math.round(clamp(bodyX + FLOW_PROBE_DX * FLOW_DIAMETER, 0, NX - 1));
      const py = Math.round(clamp(bodyY + FLOW_PROBE_DY * FLOW_DIAMETER, 0, NY - 1));
      meter.push(simTime, v[idx(px, py)]);
    }
    drawField();
    raf = requestAnimationFrame(frame);
  }

  function start() {
    if (running) return;
    running = true;
    last = performance.now();
    raf = requestAnimationFrame(frame);
  }

  function stop() {
    running = false;
    cancelAnimationFrame(raf);
  }

  const onPointerMove = (event: PointerEvent) => {
    const rect = canvas.getBoundingClientRect();
    const marginX = (radius + 3) / NX;
    const marginY = (radius + 2) / NY;
    targetFracX = clamp((event.clientX - rect.left) / Math.max(rect.width, 1), Math.max(marginX, 0.08), 1 - marginX);
    targetFracY = clamp((event.clientY - rect.top) / Math.max(rect.height, 1), marginY, 1 - marginY);
    hovering = true;
  };
  const onPointerLeave = () => {
    hovering = false;
  };
  const onVisibilityChange = () => {
    if (document.hidden) stop();
    else if (isPlayingRef.current) start();
  };

  resize();

  window.addEventListener("resize", resize);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerleave", onPointerLeave);
  document.addEventListener("visibilitychange", onVisibilityChange);

  return {
    start,
    stop,
    setView(next: FlowView) {
      view = next;
      if (!running) drawField();
    },
    getStats: () => ({ re: FLOW_RE, st: meter.value() }),
    destroy() {
      stop();
      window.removeEventListener("resize", resize);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerleave", onPointerLeave);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    },
  };
}
