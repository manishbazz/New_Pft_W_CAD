"use client";

import {
  createGLDoubleTarget,
  createGLProgram,
  createGLTarget,
  deleteGLDoubleTarget,
  deleteGLTarget,
  type GLDoubleTarget,
  type GLProgram,
  type GLTarget,
} from "./webgl2Helpers";
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
 * WebGL2 (GPU) backend for the About-page cylinder wake: incompressible
 * Navier-Stokes on a cell-centred grid, one fragment-shader pass per step.
 *
 * Per fixed substep (see flowParams.ts for the numbers and how they were
 * validated):
 *   1. MacCormack advection of velocity (2 passes) — second order, so the
 *      scheme's own numerical viscosity no longer swamps the physical one.
 *   2. Explicit viscous diffusion nu * lap(u) + boundary conditions.
 *      nu = U D / Re sets the Reynolds number explicitly.
 *   3. Pressure projection: divergence -> red-black SOR (warm-started from
 *      the previous step's pressure) -> gradient subtract.
 *   4. MacCormack advection of the dye, re-injected as stripes at the inlet.
 *
 * Boundary conditions: uniform inflow on the left, zero-gradient outflow
 * with p = 0 on the right (the only Dirichlet pressure boundary, which
 * makes the pressure problem well-posed), free-slip top/bottom walls, and a
 * moving no-slip cylinder: cells inside it take the cylinder's own velocity,
 * so dragging it pushes fluid and leaves a wake.
 *
 * Coordinates: gridPos = vUv * uGridSize, y = 0 at the BOTTOM of the canvas
 * (WebGL convention). Pointer input is flipped accordingly.
 *
 * Must only be constructed after supportsGpuFlowSim() has confirmed
 * WebGL2 + float-render-target support on a throwaway canvas — calling
 * getContext('webgl2') on `canvas` here permanently commits it to WebGL.
 */

const COMMON = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform vec2 uTexel;
uniform vec2 uGridSize;
uniform vec2 uBodyCenter;
uniform float uBodyRadius;
uniform vec2 uBodyVel;
bool isSolid(vec2 g) { return distance(g, uBodyCenter) < uBodyRadius; }
`;

// Velocity boundary conditions shared by every pass that writes velocity.
// The outlet (zero-gradient) is handled by the caller, because it needs a
// texture read of the neighbouring column.
const VEL_BC = `
vec2 applyVelBC(vec2 vel, vec2 g) {
  if (g.x < 2.0) return vec2(${FLOW_U_INF.toFixed(3)}, 0.0);        // inlet
  if (g.y < 1.0 || g.y > uGridSize.y - 1.0) vel.y = 0.0;           // free-slip walls
  if (isSolid(g)) return uBodyVel;                                  // moving no-slip body
  return vel;
}
`;

const INIT_FRAG = `${COMMON}
void main() {
  vec2 g = vUv * uGridSize;
  // Small transverse kick behind the body breaks the up/down symmetry so
  // shedding starts within a couple of periods instead of waiting for
  // round-off to grow.
  float kick = (g.x > uBodyCenter.x && g.x < uBodyCenter.x + 6.0 * uBodyRadius) ? 0.05 : 0.0;
  vec2 vel = vec2(${FLOW_U_INF.toFixed(3)}, kick);
  if (isSolid(g)) vel = vec2(0.0);
  outColor = vec4(vel, 0.0, 1.0);
}`;

// Pass 1 of MacCormack: plain semi-Lagrangian step, phiHat = phi(x - u dt).
const ADVECT_SL_FRAG = `${COMMON}
uniform sampler2D uSrc;
uniform sampler2D uVel;
uniform float uDt;
void main() {
  vec2 vel = texture(uVel, vUv).xy;
  outColor = texture(uSrc, vUv - vel * uDt * uTexel);
}`;

// Pass 2 of MacCormack: error-compensated value with a min/max limiter
// (clamp to the 4 texels around the back-traced point) so it can't
// overshoot and go unstable.
const MACCORMACK = `
uniform sampler2D uSrc;
uniform sampler2D uHat;
uniform sampler2D uVel;
uniform float uDt;
vec4 maccormack(vec2 g) {
  vec2 vel = texture(uVel, vUv).xy;
  vec4 phi = texture(uSrc, vUv);
  vec4 hat = texture(uHat, vUv);
  vec4 back = texture(uHat, vUv + vel * uDt * uTexel);
  vec4 c = hat + 0.5 * (phi - back);
  vec2 p = clamp(g - vel * uDt - 0.5, vec2(0.0), uGridSize - 1.0);
  ivec2 i0 = ivec2(min(floor(p), uGridSize - 2.0));
  vec4 a = texelFetch(uSrc, i0, 0);
  vec4 b = texelFetch(uSrc, i0 + ivec2(1, 0), 0);
  vec4 d = texelFetch(uSrc, i0 + ivec2(0, 1), 0);
  vec4 e = texelFetch(uSrc, i0 + ivec2(1, 1), 0);
  return clamp(c, min(min(a, b), min(d, e)), max(max(a, b), max(d, e)));
}
`;

const ADVECT_VEL_FRAG = `${COMMON}${MACCORMACK}
void main() {
  outColor = vec4(maccormack(vUv * uGridSize).xy, 0.0, 1.0);
}`;

const VISCOUS_BC_FRAG = `${COMMON}${VEL_BC}
uniform sampler2D uVel;
uniform float uNuDt;
void main() {
  vec2 g = vUv * uGridSize;
  vec2 c = texture(uVel, vUv).xy;
  vec2 L = texture(uVel, vUv - vec2(uTexel.x, 0.0)).xy;
  vec2 R = texture(uVel, vUv + vec2(uTexel.x, 0.0)).xy;
  vec2 B = texture(uVel, vUv - vec2(0.0, uTexel.y)).xy;
  vec2 T = texture(uVel, vUv + vec2(0.0, uTexel.y)).xy;
  vec2 vel = c + uNuDt * (L + R + B + T - 4.0 * c);
  if (g.x > uGridSize.x - 1.0) vel = L;                             // outlet
  outColor = vec4(applyVelBC(vel, g), 0.0, 1.0);
}`;

const DIVERGENCE_FRAG = `${COMMON}
uniform sampler2D uVel;
void main() {
  vec2 g = vUv * uGridSize;
  if (isSolid(g)) { outColor = vec4(0.0); return; }
  float L = texture(uVel, vUv - vec2(uTexel.x, 0.0)).x;
  float R = texture(uVel, vUv + vec2(uTexel.x, 0.0)).x;
  float B = texture(uVel, vUv - vec2(0.0, uTexel.y)).y;
  float T = texture(uVel, vUv + vec2(0.0, uTexel.y)).y;
  outColor = vec4(-0.5 * ((R - L) + (T - B)), 0.0, 0.0, 1.0);
}`;

// Neumann (dp/dn = 0) at walls and the body: a solid neighbour returns the
// cell's own pressure.
const P_AT = `
uniform sampler2D uPressure;
float pAt(vec2 uv, float selfP) {
  if (isSolid(uv * uGridSize)) return selfP;
  return texture(uPressure, uv).r;
}
`;

const RB_SOR_FRAG = `${COMMON}${P_AT}
uniform sampler2D uDivergence;
uniform int uColor;
uniform float uOmega;
void main() {
  vec2 g = vUv * uGridSize;
  if (isSolid(g)) { outColor = vec4(0.0); return; }
  // Outlet: p = 0 (Dirichlet). The only fixed-pressure boundary, so the
  // solve has a unique answer and warm-starting from the last step is safe.
  if (g.x > uGridSize.x - 1.0) { outColor = vec4(0.0); return; }
  float self = texture(uPressure, vUv).r;
  // Red-black ordering: only one colour updates per pass, so each update
  // sees its neighbours' newest values (Gauss-Seidel), then over-relaxes.
  ivec2 cell = ivec2(gl_FragCoord.xy);
  if (((cell.x + cell.y) & 1) != uColor) { outColor = vec4(self, 0.0, 0.0, 1.0); return; }
  float div = texture(uDivergence, vUv).r;
  float L = pAt(vUv - vec2(uTexel.x, 0.0), self);
  float R = pAt(vUv + vec2(uTexel.x, 0.0), self);
  float B = pAt(vUv - vec2(0.0, uTexel.y), self);
  float T = pAt(vUv + vec2(0.0, uTexel.y), self);
  float gs = (div + L + R + B + T) * 0.25;
  outColor = vec4(self + uOmega * (gs - self), 0.0, 0.0, 1.0);
}`;

const GRADIENT_BC_FRAG = `${COMMON}${VEL_BC}${P_AT}
uniform sampler2D uVel;
void main() {
  vec2 g = vUv * uGridSize;
  vec2 vel = texture(uVel, vUv).xy;
  if (!isSolid(g)) {
    float self = texture(uPressure, vUv).r;
    float L = pAt(vUv - vec2(uTexel.x, 0.0), self);
    float R = pAt(vUv + vec2(uTexel.x, 0.0), self);
    float B = pAt(vUv - vec2(0.0, uTexel.y), self);
    float T = pAt(vUv + vec2(0.0, uTexel.y), self);
    vel -= 0.5 * vec2(R - L, T - B);
  }
  outColor = vec4(applyVelBC(vel, g), 0.0, 1.0);
}`;

const ADVECT_DYE_FRAG = `${COMMON}${MACCORMACK}
uniform float uStripeSpacing;
uniform float uStripeWidth;
uniform float uBandHalf;
void main() {
  vec2 g = vUv * uGridSize;
  float d = maccormack(g).r;
  if (g.x < 2.0) {
    d = 0.0;
    if (abs(g.y - uGridSize.y * 0.5) <= uBandHalf &&
        mod(floor(g.y), uStripeSpacing) < uStripeWidth) d = 1.0;
  }
  if (isSolid(g) || g.y < 1.0 || g.y > uGridSize.y - 1.0) d = 0.0;
  outColor = vec4(d, 0.0, 0.0, 1.0);
}`;

// uView: 0 = dye (smoke), 1 = vorticity (red = counter-clockwise,
// blue = clockwise), 2 = speed.
const RENDER_FRAG = `${COMMON}
uniform sampler2D uDye;
uniform sampler2D uVel;
uniform int uView;
void main() {
  vec3 bg = vec3(7.0, 8.0, 9.0) / 255.0;
  vec3 fg = vec3(143.0, 163.0, 176.0) / 255.0;
  vec3 col;
  if (uView == 1) {
    float L = texture(uVel, vUv - vec2(uTexel.x, 0.0)).y;
    float R = texture(uVel, vUv + vec2(uTexel.x, 0.0)).y;
    float B = texture(uVel, vUv - vec2(0.0, uTexel.y)).x;
    float T = texture(uVel, vUv + vec2(0.0, uTexel.y)).x;
    float w = 0.5 * ((R - L) - (T - B));
    float s = clamp(w / 0.25, -1.0, 1.0);
    vec3 pos = vec3(0.86, 0.42, 0.36);
    vec3 neg = vec3(0.33, 0.55, 0.86);
    col = mix(bg, s > 0.0 ? pos : neg, pow(abs(s), 0.7));
  } else if (uView == 2) {
    float sp = length(texture(uVel, vUv).xy) / 1.6;
    float bands = 10.0;
    float b = floor(clamp(sp, 0.0, 1.0) * bands) / bands;
    float edge = abs(fract(sp * bands) - 0.5) * 2.0;
    col = mix(bg, fg, b);
    col = mix(col, bg, (1.0 - smoothstep(0.0, 0.15, edge)) * 0.5);
  } else {
    float a = clamp(texture(uDye, vUv).r, 0.0, 1.0);
    col = mix(bg, fg, a);
  }
  vec2 g = vUv * uGridSize;
  float d = distance(g, uBodyCenter);
  if (d < uBodyRadius) col = bg;
  float edge = smoothstep(uBodyRadius - 0.8, uBodyRadius, d) -
               smoothstep(uBodyRadius, uBodyRadius + 0.8, d);
  col = mix(col, fg, edge * 0.95);
  outColor = vec4(col, 1.0);
}`;

const VERT_SRC = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

type Programs = Record<
  "init" | "advectSL" | "advectVel" | "viscousBC" | "divergence" | "sor" | "gradientBC" | "advectDye" | "render",
  GLProgram
>;

const COMMON_UNIFORMS = ["uTexel", "uGridSize", "uBodyCenter", "uBodyRadius", "uBodyVel"];

export function createGpuFlowSim(
  canvas: HTMLCanvasElement,
  isPlayingRef: { current: boolean },
): FlowController | null {
  const glOrNull = canvas.getContext("webgl2", { alpha: false });
  if (!glOrNull) return null;
  const gl: WebGL2RenderingContext = glOrNull;

  let progs: Programs | null = null;
  let quad: WebGLBuffer | null = null;

  let NX = FLOW_MIN_NX;
  const NY = FLOW_NY;
  let velocity: GLDoubleTarget | null = null;
  let velHat: GLTarget | null = null;
  let pressure: GLDoubleTarget | null = null;
  let divergence: GLTarget | null = null;
  let dye: GLDoubleTarget | null = null;
  let dyeHat: GLTarget | null = null;

  let bodyFracX = FLOW_BODY_X;
  let bodyFracY = FLOW_BODY_Y;
  let targetFracX = bodyFracX;
  let targetFracY = bodyFracY;
  let bodyVelX = 0;
  let bodyVelY = 0;
  let hovering = false;

  let raf = 0;
  let running = false;
  let last = performance.now();
  let acc = 0;
  let simTime = 0;
  let frameCount = 0;
  let view: FlowView = "dye";
  const meter = createStrouhalMeter();
  const probeBuf = new Float32Array(4);

  const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
  const radius = FLOW_DIAMETER / 2;

  let floatLinear = false;

  function setup(): boolean {
    if (!gl.getExtension("EXT_color_buffer_float")) return false;
    floatLinear = !!gl.getExtension("OES_texture_float_linear");
    quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const mac = ["uSrc", "uHat", "uVel", "uDt"];
    const p = {
      init: createGLProgram(gl, INIT_FRAG, COMMON_UNIFORMS, VERT_SRC),
      advectSL: createGLProgram(gl, ADVECT_SL_FRAG, [...COMMON_UNIFORMS, "uSrc", "uVel", "uDt"], VERT_SRC),
      advectVel: createGLProgram(gl, ADVECT_VEL_FRAG, [...COMMON_UNIFORMS, ...mac], VERT_SRC),
      viscousBC: createGLProgram(gl, VISCOUS_BC_FRAG, [...COMMON_UNIFORMS, "uVel", "uNuDt"], VERT_SRC),
      divergence: createGLProgram(gl, DIVERGENCE_FRAG, [...COMMON_UNIFORMS, "uVel"], VERT_SRC),
      sor: createGLProgram(gl, RB_SOR_FRAG, [...COMMON_UNIFORMS, "uPressure", "uDivergence", "uColor", "uOmega"], VERT_SRC),
      gradientBC: createGLProgram(gl, GRADIENT_BC_FRAG, [...COMMON_UNIFORMS, "uVel", "uPressure"], VERT_SRC),
      advectDye: createGLProgram(gl, ADVECT_DYE_FRAG, [...COMMON_UNIFORMS, ...mac, "uStripeSpacing", "uStripeWidth", "uBandHalf"], VERT_SRC),
      render: createGLProgram(gl, RENDER_FRAG, [...COMMON_UNIFORMS, "uDye", "uVel", "uView"], VERT_SRC),
    };
    if (Object.values(p).some((x) => !x)) return false;
    progs = p as Programs;
    return true;
  }

  function freeGrid() {
    deleteGLDoubleTarget(gl, velocity);
    deleteGLTarget(gl, velHat);
    deleteGLDoubleTarget(gl, pressure);
    deleteGLTarget(gl, divergence);
    deleteGLDoubleTarget(gl, dye);
    deleteGLTarget(gl, dyeHat);
    velocity = pressure = dye = null;
    velHat = divergence = dyeHat = null;
  }

  function allocateGrid(nx: number) {
    freeGrid();
    NX = nx;
    // Velocity in full 32-bit float where it can be linearly filtered
    // (OES_texture_float_linear: most desktops); half floats otherwise.
    // Half precision is fine for the dye but leaves visible speckle in the
    // vorticity view, which differentiates velocity.
    if (floatLinear) {
      velocity = createGLDoubleTarget(gl, NX, NY, gl.RG32F, gl.RG, gl.FLOAT, gl.LINEAR);
      velHat = createGLTarget(gl, NX, NY, gl.RG32F, gl.RG, gl.FLOAT, gl.LINEAR);
    } else {
      velocity = createGLDoubleTarget(gl, NX, NY, gl.RG16F, gl.RG);
      velHat = createGLTarget(gl, NX, NY, gl.RG16F, gl.RG);
    }
    // 32-bit pressure: it's warm-started across steps, and half floats
    // (~3 significant digits) would stall the residual.
    pressure = createGLDoubleTarget(gl, NX, NY, gl.R32F, gl.RED, gl.FLOAT);
    divergence = createGLTarget(gl, NX, NY, gl.R32F, gl.RED, gl.FLOAT);
    dye = createGLDoubleTarget(gl, NX, NY, gl.R16F, gl.RED);
    dyeHat = createGLTarget(gl, NX, NY, gl.R16F, gl.RED);
    for (const t of [pressure?.read, pressure?.write, dye?.read, dye?.write]) {
      if (!t) continue;
      gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
      gl.viewport(0, 0, NX, NY);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    simTime = 0;
    meter.reset();
    run(progs!.init, velocity!.write, () => {});
    velocity!.swap();
  }

  function run(prog: GLProgram, target: GLTarget | null, setUniforms: (u: GLProgram["uniforms"]) => void) {
    gl.useProgram(prog.program);
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.enableVertexAttribArray(prog.aPosLoc);
    gl.vertexAttribPointer(prog.aPosLoc, 2, gl.FLOAT, false, 0, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fbo : null);
    gl.viewport(0, 0, target ? NX : canvas.width, target ? NY : canvas.height);
    const u = prog.uniforms;
    gl.uniform2f(u.uTexel, 1 / NX, 1 / NY);
    gl.uniform2f(u.uGridSize, NX, NY);
    gl.uniform2f(u.uBodyCenter, bodyFracX * NX, bodyFracY * NY);
    gl.uniform1f(u.uBodyRadius, radius);
    gl.uniform2f(u.uBodyVel, bodyVelX, bodyVelY);
    setUniforms(u);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  function tex(unit: number, t: WebGLTexture, loc: WebGLUniformLocation | null) {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.uniform1i(loc, unit);
  }

  function advect(field: GLDoubleTarget, hat: GLTarget, macProg: GLProgram, dt: number, extra?: (u: GLProgram["uniforms"]) => void) {
    run(progs!.advectSL, hat, (u) => {
      tex(0, field.read.texture, u.uSrc);
      tex(1, velocity!.read.texture, u.uVel);
      gl.uniform1f(u.uDt, dt);
    });
    run(macProg, field.write, (u) => {
      tex(0, field.read.texture, u.uSrc);
      tex(1, hat.texture, u.uHat);
      tex(2, velocity!.read.texture, u.uVel);
      gl.uniform1f(u.uDt, dt);
      extra?.(u);
    });
    field.swap();
  }

  function step(dt: number) {
    const v = velocity!;
    // Move the body toward the pointer and record its velocity (grid units
    // per time unit) so the no-slip condition moves the fluid with it.
    const prevX = bodyFracX * NX;
    const prevY = bodyFracY * NY;
    if (hovering) {
      bodyFracX += (targetFracX - bodyFracX) * 0.12;
      bodyFracY += (targetFracY - bodyFracY) * 0.12;
    }
    bodyVelX = (bodyFracX * NX - prevX) / dt;
    bodyVelY = (bodyFracY * NY - prevY) / dt;
    if (Math.hypot(bodyVelX, bodyVelY) > 0.05) meter.reset();

    advect(v, velHat!, progs!.advectVel, dt);
    run(progs!.viscousBC, v.write, (u) => {
      tex(0, v.read.texture, u.uVel);
      gl.uniform1f(u.uNuDt, FLOW_NU * dt);
    });
    v.swap();

    run(progs!.divergence, divergence, (u) => tex(0, v.read.texture, u.uVel));
    // Warm start: pressure is NOT cleared, so each step's SOR passes refine
    // the previous solution instead of starting from zero.
    for (let i = 0; i < FLOW_SOR_PASSES; i++) {
      run(progs!.sor, pressure!.write, (u) => {
        tex(0, pressure!.read.texture, u.uPressure);
        tex(1, divergence!.texture, u.uDivergence);
        gl.uniform1i(u.uColor, i & 1);
        gl.uniform1f(u.uOmega, FLOW_SOR_OMEGA);
      });
      pressure!.swap();
    }
    run(progs!.gradientBC, v.write, (u) => {
      tex(0, v.read.texture, u.uVel);
      tex(1, pressure!.read.texture, u.uPressure);
    });
    v.swap();

    advect(dye!, dyeHat!, progs!.advectDye, dt, (u) => {
      gl.uniform1f(u.uStripeSpacing, FLOW_STRIPE_SPACING);
      gl.uniform1f(u.uStripeWidth, FLOW_STRIPE_WIDTH);
      gl.uniform1f(u.uBandHalf, radius + FLOW_SMOKE_BAND_MARGIN);
    });
    simTime += dt;
  }

  function sampleProbe() {
    // One texel read per frame for the Strouhal meter: tiny, and the GPU
    // stall is negligible at this grid size.
    const px = Math.round(clamp(bodyFracX * NX + FLOW_PROBE_DX * FLOW_DIAMETER, 0, NX - 1));
    const py = Math.round(clamp(bodyFracY * NY + FLOW_PROBE_DY * FLOW_DIAMETER, 0, NY - 1));
    try {
      gl.bindFramebuffer(gl.FRAMEBUFFER, velocity!.read.fbo);
      gl.readPixels(px, py, 1, 1, gl.RGBA, gl.FLOAT, probeBuf);
      meter.push(simTime, probeBuf[1]);
    } catch {
      /* readback unsupported: just no Strouhal readout */
    }
  }

  function drawFrame() {
    if (!dye || !velocity) return;
    run(progs!.render, null, (u) => {
      tex(0, dye!.read.texture, u.uDye);
      tex(1, velocity!.read.texture, u.uVel);
      gl.uniform1i(u.uView, view === "vorticity" ? 1 : view === "speed" ? 2 : 0);
    });
  }

  function resize() {
    if (gl.isContextLost()) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    canvas.width = Math.max(1, Math.round(width * dpr));
    canvas.height = Math.max(1, Math.round(height * dpr));
    const aspect = height > 0 ? width / height : 3;
    const nextNX = clamp(Math.round(NY * aspect), FLOW_MIN_NX, FLOW_MAX_NX);
    if (nextNX !== NX || !velocity) allocateGrid(nextNX);
    drawFrame();
  }

  function frame(now: number) {
    if (!running) return;
    const realDt = Math.min(0.05, Math.max(0, (now - last) / 1000));
    last = now;
    // Fixed-step accumulator: the physics advances by the same dt whatever
    // the display refresh rate (60 / 120 / 144 Hz all look identical).
    acc += realDt * FLOW_TIME_SCALE;
    let steps = 0;
    while (acc >= FLOW_MAX_SUBSTEP_DT && steps < FLOW_MAX_STEPS_PER_FRAME) {
      step(FLOW_MAX_SUBSTEP_DT);
      acc -= FLOW_MAX_SUBSTEP_DT;
      steps++;
    }
    if (steps === FLOW_MAX_STEPS_PER_FRAME) acc = 0;
    // Read the probe every 4th frame: a GPU->CPU readback stalls the
    // pipeline, and ~15 samples/s is plenty for a ~2 s shedding period
    // (crossing times are interpolated, see createStrouhalMeter).
    if (steps > 0 && ++frameCount % 4 === 0) sampleProbe();
    drawFrame();
    raf = requestAnimationFrame(frame);
  }

  function start() {
    if (running || gl.isContextLost()) return;
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
    targetFracY = clamp(1 - (event.clientY - rect.top) / Math.max(rect.height, 1), marginY, 1 - marginY);
    hovering = true;
  };
  const onPointerLeave = () => {
    hovering = false;
  };
  const onVisibilityChange = () => {
    if (document.hidden) stop();
    else if (isPlayingRef.current) start();
  };
  const onContextLost = (event: Event) => {
    event.preventDefault();
    stop();
    progs = null;
    velocity = pressure = dye = null;
    velHat = divergence = dyeHat = null;
  };
  const onContextRestored = () => {
    if (!setup()) return;
    resize();
    if (isPlayingRef.current) start();
  };

  if (!setup()) return null;
  resize();

  window.addEventListener("resize", resize);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerleave", onPointerLeave);
  canvas.addEventListener("webglcontextlost", onContextLost);
  canvas.addEventListener("webglcontextrestored", onContextRestored);
  document.addEventListener("visibilitychange", onVisibilityChange);

  return {
    start,
    stop,
    setView(next: FlowView) {
      view = next;
      if (!running) drawFrame();
    },
    getStats: () => ({ re: FLOW_RE, st: meter.value() }),
    destroy() {
      stop();
      window.removeEventListener("resize", resize);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerleave", onPointerLeave);
      canvas.removeEventListener("webglcontextlost", onContextLost);
      canvas.removeEventListener("webglcontextrestored", onContextRestored);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      if (!gl.isContextLost()) {
        freeGrid();
        if (progs) for (const p of Object.values(progs)) gl.deleteProgram(p.program);
        gl.deleteBuffer(quad);
      }
    },
  };
}
