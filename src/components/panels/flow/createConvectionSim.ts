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
import type { FlowController } from "./types";

/**
 * Full-viewport Boussinesq natural-convection background: a fixed heat
 * source (a disk on the "floor") drives a buoyant plume through an
 * otherwise-quiescent domain — no background wind, unlike the flagship
 * flow panel. Same Stable Fluids projection method underneath, plus one
 * extra pass: buoyancy force proportional to (T - T_ambient), applied to
 * velocity before each projection.
 *
 * COORDINATE CONVENTION (read this before touching boundary conditions):
 * gridPos = vUv * uGridSize renders, on the default framebuffer, with
 * gridPos.y ≈ 0 at the physical BOTTOM of the visible canvas and
 * gridPos.y ≈ NY at the physical TOP — this is WebGL's clip-space
 * convention (viewport row 0 = bottom-left), not a bug. So: the floor
 * and heat source sit near gridPos.y = 0; the open "chimney" outflow is
 * at gridPos.y = NY. (This is exactly the inversion that had to be fixed
 * in the mouse-tracked flagship panel — here we just design around it
 * from the start instead of fighting it.)
 *
 * GPU-only: no CPU fallback. This is a decorative, always-on background,
 * and a JS for-loop version running continuously behind page content is a
 * much worse trade than simply not rendering it on unsupported browsers.
 */

const BASE_NY = 140;
const MIN_NX = 140;
const MAX_NX = 380;
const PROJECT_ITERATIONS = 40;

const BASE_TIME_SCALE = 30;
const MAX_SUBSTEP_DT = 0.16;

const BUOYANCY = 3.2;
const AMBIENT_TEMP = 0.0;
const SOURCE_TEMP = 1.0;
const SOURCE_RADIUS_FRAC = 0.045; // fraction of min(NX, NY)
const SOURCE_Y_FRAC = 0.06;       // near gridPos.y = 0 → visual bottom

const VERT_SRC = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const BOUNDARY_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uVel;
uniform vec2 uTexel;
uniform vec2 uGridSize;
uniform vec2 uSourceCenterGrid;
uniform float uSourceRadiusGrid;
void main() {
  vec2 gridPos = vUv * uGridSize;
  vec2 vel = texture(uVel, vUv).xy;

  // Left / right walls: no-slip.
  if (gridPos.x < 1.0 || gridPos.x > uGridSize.x - 1.0) {
    vel = vec2(0.0);
  }
  // gridPos.y ~ 0 is the physical BOTTOM of the canvas — the floor.
  if (gridPos.y < 1.0) {
    vel = vec2(0.0);
  }
  // gridPos.y ~ NY is the physical TOP — open chimney, zero-gradient.
  if (gridPos.y > uGridSize.y - 1.0) {
    vel = texture(uVel, vUv - vec2(0.0, uTexel.y)).xy;
  }
  // Heat source disk: solid, no-slip.
  if (distance(gridPos, uSourceCenterGrid) < uSourceRadiusGrid) {
    vel = vec2(0.0);
  }
  outColor = vec4(vel, 0.0, 1.0);
}`;

const BUOYANCY_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uVel;
uniform sampler2D uTemp;
uniform float uDt;
uniform float uBuoyancy;
uniform float uAmbientTemp;
void main() {
  vec2 vel = texture(uVel, vUv).xy;
  float t = texture(uTemp, vUv).r;
  // "Up" is toward the physical TOP of the canvas, i.e. toward LARGER
  // gridPos.y (see file header) — so buoyant lift INCREASES v.y.
  vel.y += uBuoyancy * (t - uAmbientTemp) * uDt;
  outColor = vec4(vel, 0.0, 1.0);
}`;

const ADVECT_VEL_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uVel;
uniform vec2 uTexel;
uniform vec2 uGridSize;
uniform float uDt;
uniform vec2 uSourceCenterGrid;
uniform float uSourceRadiusGrid;
void main() {
  vec2 gridPos = vUv * uGridSize;
  vec2 vel = texture(uVel, vUv).xy;
  vec2 backUv = clamp(vUv - vel * uTexel * uDt, vec2(0.0), vec2(1.0));
  vec2 newVel = texture(uVel, backUv).xy;

  if (gridPos.x < 1.0 || gridPos.x > uGridSize.x - 1.0) newVel = vec2(0.0);
  if (gridPos.y < 1.0) newVel = vec2(0.0);
  if (gridPos.y > uGridSize.y - 1.0) {
    newVel = texture(uVel, vUv - vec2(0.0, uTexel.y)).xy;
  }
  if (distance(gridPos, uSourceCenterGrid) < uSourceRadiusGrid) {
    newVel = vec2(0.0);
  }
  outColor = vec4(newVel, 0.0, 1.0);
}`;

const DIVERGENCE_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uVel;
uniform vec2 uTexel;
uniform vec2 uGridSize;
uniform vec2 uSourceCenterGrid;
uniform float uSourceRadiusGrid;
void main() {
  vec2 gridPos = vUv * uGridSize;
  if (distance(gridPos, uSourceCenterGrid) < uSourceRadiusGrid) {
    outColor = vec4(0.0);
    return;
  }
  float L = texture(uVel, vUv - vec2(uTexel.x, 0.0)).x;
  float R = texture(uVel, vUv + vec2(uTexel.x, 0.0)).x;
  float B = texture(uVel, vUv - vec2(0.0, uTexel.y)).y;
  float T = texture(uVel, vUv + vec2(0.0, uTexel.y)).y;
  float d = -0.5 * ((R - L) + (T - B));
  outColor = vec4(d, 0.0, 0.0, 1.0);
}`;

const JACOBI_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uPressure;
uniform sampler2D uDivergence;
uniform vec2 uTexel;
uniform vec2 uGridSize;
uniform vec2 uSourceCenterGrid;
uniform float uSourceRadiusGrid;
bool isSolid(vec2 g) { return distance(g, uSourceCenterGrid) < uSourceRadiusGrid; }
float pAt(vec2 uv, float selfP) {
  vec2 g = uv * uGridSize;
  if (isSolid(g)) return selfP;
  return texture(uPressure, uv).r;
}
void main() {
  vec2 gridPos = vUv * uGridSize;
  if (isSolid(gridPos)) { outColor = vec4(0.0); return; }
  float self = texture(uPressure, vUv).r;
  float div = texture(uDivergence, vUv).r;
  float L = pAt(vUv - vec2(uTexel.x, 0.0), self);
  float R = pAt(vUv + vec2(uTexel.x, 0.0), self);
  float B = pAt(vUv - vec2(0.0, uTexel.y), self);
  float T = pAt(vUv + vec2(0.0, uTexel.y), self);
  outColor = vec4((div + L + R + B + T) * 0.25, 0.0, 0.0, 1.0);
}`;

const GRADIENT_SUBTRACT_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uVel;
uniform sampler2D uPressure;
uniform vec2 uTexel;
uniform vec2 uGridSize;
uniform vec2 uSourceCenterGrid;
uniform float uSourceRadiusGrid;
bool isSolid(vec2 g) { return distance(g, uSourceCenterGrid) < uSourceRadiusGrid; }
float pAt(vec2 uv, float selfP) {
  vec2 g = uv * uGridSize;
  if (isSolid(g)) return selfP;
  return texture(uPressure, uv).r;
}
void main() {
  vec2 gridPos = vUv * uGridSize;
  if (isSolid(gridPos)) { outColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
  vec2 vel = texture(uVel, vUv).xy;
  float self = texture(uPressure, vUv).r;
  float L = pAt(vUv - vec2(uTexel.x, 0.0), self);
  float R = pAt(vUv + vec2(uTexel.x, 0.0), self);
  float B = pAt(vUv - vec2(0.0, uTexel.y), self);
  float T = pAt(vUv + vec2(0.0, uTexel.y), self);
  vel.x -= 0.5 * (R - L);
  vel.y -= 0.5 * (T - B);
  outColor = vec4(vel, 0.0, 1.0);
}`;

const ADVECT_TEMP_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uTemp;
uniform sampler2D uVel;
uniform vec2 uTexel;
uniform vec2 uGridSize;
uniform float uDt;
uniform vec2 uSourceCenterGrid;
uniform float uSourceRadiusGrid;
uniform float uSourceTemp;
void main() {
  vec2 gridPos = vUv * uGridSize;
  vec2 vel = texture(uVel, vUv).xy;
  vec2 backUv = clamp(vUv - vel * uTexel * uDt, vec2(0.0), vec2(1.0));
  float t = texture(uTemp, backUv).r;

  // Heat source: fixed at uSourceTemp, this is the only place T is
  // injected — everywhere else is pure advection of what's already there.
  if (distance(gridPos, uSourceCenterGrid) < uSourceRadiusGrid + 1.0) {
    t = uSourceTemp;
  } else if (gridPos.x < 1.0 || gridPos.x > uGridSize.x - 1.0 || gridPos.y < 1.0) {
    t = 0.0; // walls and floor stay at ambient
  }
  outColor = vec4(t, 0.0, 0.0, 1.0);
}`;

const RENDER_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uTemp;
void main() {
  float t = clamp(texture(uTemp, vUv).r, 0.0, 1.0);
  // Cold -> transparent (page background shows through). Hot -> warm glow.
  vec3 warm = mix(vec3(0.55, 0.16, 0.05), vec3(1.0, 0.62, 0.22), smoothstep(0.05, 1.0, t));
  float alpha = smoothstep(0.03, 0.9, t) * 0.8;
  outColor = vec4(warm, alpha);
}`;

export function createConvectionSim(canvas: HTMLCanvasElement): FlowController | null {
  const gl = canvas.getContext("webgl2", { alpha: true, premultipliedAlpha: false });
  if (!gl) return null;
  if (!gl.getExtension("EXT_color_buffer_float")) return null;

  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

  const quadBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);

  function bindQuad(loc: number) {
    gl!.bindBuffer(gl!.ARRAY_BUFFER, quadBuffer);
    gl!.enableVertexAttribArray(loc);
    gl!.vertexAttribPointer(loc, 2, gl!.FLOAT, false, 0, 0);
  }

  const boundaryProg = createGLProgram(gl, BOUNDARY_FRAG, ["uVel", "uTexel", "uGridSize", "uSourceCenterGrid", "uSourceRadiusGrid"], VERT_SRC);
  const buoyancyProg = createGLProgram(gl, BUOYANCY_FRAG, ["uVel", "uTemp", "uDt", "uBuoyancy", "uAmbientTemp"], VERT_SRC);
  const advectVelProg = createGLProgram(gl, ADVECT_VEL_FRAG, ["uVel", "uTexel", "uGridSize", "uDt", "uSourceCenterGrid", "uSourceRadiusGrid"], VERT_SRC);
  const divergenceProg = createGLProgram(gl, DIVERGENCE_FRAG, ["uVel", "uTexel", "uGridSize", "uSourceCenterGrid", "uSourceRadiusGrid"], VERT_SRC);
  const jacobiProg = createGLProgram(gl, JACOBI_FRAG, ["uPressure", "uDivergence", "uTexel", "uGridSize", "uSourceCenterGrid", "uSourceRadiusGrid"], VERT_SRC);
  const gradientProg = createGLProgram(gl, GRADIENT_SUBTRACT_FRAG, ["uVel", "uPressure", "uTexel", "uGridSize", "uSourceCenterGrid", "uSourceRadiusGrid"], VERT_SRC);
  const advectTempProg = createGLProgram(gl, ADVECT_TEMP_FRAG, ["uTemp", "uVel", "uTexel", "uGridSize", "uDt", "uSourceCenterGrid", "uSourceRadiusGrid", "uSourceTemp"], VERT_SRC);
  const renderProg = createGLProgram(gl, RENDER_FRAG, ["uTemp"], VERT_SRC);

  if (!boundaryProg || !buoyancyProg || !advectVelProg || !divergenceProg || !jacobiProg || !gradientProg || !advectTempProg || !renderProg) {
    return null;
  }

  let NX = MIN_NX;
  let NY = BASE_NY;

  let velocity: GLDoubleTarget | null = null;
  let pressure: GLDoubleTarget | null = null;
  let divergence: GLTarget | null = null;
  let temperature: GLDoubleTarget | null = null;

  let width = 0;
  let height = 0;
  let dpr = 1;
  let sourceRadiusGrid = 1;
  let raf = 0;
  let running = false;
  let last = performance.now();


  const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

  function freeGrid() {
    deleteGLDoubleTarget(gl!, velocity);
    deleteGLDoubleTarget(gl!, pressure);
    deleteGLTarget(gl!, divergence);
    deleteGLDoubleTarget(gl!, temperature);
  }

  function allocateGrid(nx: number, ny: number) {
    freeGrid();
    NX = nx;
    NY = ny;
    velocity = createGLDoubleTarget(gl!, NX, NY, gl!.RG16F, gl!.RG);
    pressure = createGLDoubleTarget(gl!, NX, NY, gl!.R16F, gl!.RED);
    divergence = createGLTarget(gl!, NX, NY, gl!.R16F, gl!.RED);
    temperature = createGLDoubleTarget(gl!, NX, NY, gl!.R16F, gl!.RED);
  }

  function runPass(prog: GLProgram, target: GLTarget | null, setup: () => void) {
    gl!.useProgram(prog.program);
    bindQuad(prog.aPosLoc);
    gl!.bindFramebuffer(gl!.FRAMEBUFFER, target ? target.fbo : null);
    gl!.viewport(0, 0, target ? NX : canvas.width, target ? NY : canvas.height);
    setup();
    gl!.drawArrays(gl!.TRIANGLE_STRIP, 0, 4);
  }

  function bindTex(unit: number, tex: WebGLTexture) {
    gl!.activeTexture(gl!.TEXTURE0 + unit);
    gl!.bindTexture(gl!.TEXTURE_2D, tex);
  }

  function sourceUniforms(u: Record<string, WebGLUniformLocation | null>) {
    gl!.uniform2f(u.uSourceCenterGrid, NX * 0.5, NY * SOURCE_Y_FRAC);
    gl!.uniform1f(u.uSourceRadiusGrid, sourceRadiusGrid);
  }

  function applyBoundary() {
    if (!velocity) return;
    const { uniforms } = boundaryProg!;
    runPass(boundaryProg!, velocity.write, () => {
      bindTex(0, velocity!.read.texture);
      gl!.uniform1i(uniforms.uVel, 0);
      gl!.uniform2f(uniforms.uTexel, 1 / NX, 1 / NY);
      gl!.uniform2f(uniforms.uGridSize, NX, NY);
      sourceUniforms(uniforms);
    });
    velocity.swap();
  }

  function applyBuoyancy(dt: number) {
    if (!velocity || !temperature) return;
    const { uniforms } = buoyancyProg!;
    runPass(buoyancyProg!, velocity.write, () => {
      bindTex(0, velocity!.read.texture);
      bindTex(1, temperature!.read.texture);
      gl!.uniform1i(uniforms.uVel, 0);
      gl!.uniform1i(uniforms.uTemp, 1);
      gl!.uniform1f(uniforms.uDt, dt);
      gl!.uniform1f(uniforms.uBuoyancy, BUOYANCY);
      gl!.uniform1f(uniforms.uAmbientTemp, AMBIENT_TEMP);
    });
    velocity.swap();
  }

  function project() {
    if (!velocity || !pressure || !divergence) return;
    const dUniforms = divergenceProg!.uniforms;
    runPass(divergenceProg!, divergence, () => {
      bindTex(0, velocity!.read.texture);
      gl!.uniform1i(dUniforms.uVel, 0);
      gl!.uniform2f(dUniforms.uTexel, 1 / NX, 1 / NY);
      gl!.uniform2f(dUniforms.uGridSize, NX, NY);
      sourceUniforms(dUniforms);
    });

    gl!.bindFramebuffer(gl!.FRAMEBUFFER, pressure.read.fbo);
    gl!.viewport(0, 0, NX, NY);
    gl!.clearColor(0, 0, 0, 1);
    gl!.clear(gl!.COLOR_BUFFER_BIT);

    const jUniforms = jacobiProg!.uniforms;
    for (let i = 0; i < PROJECT_ITERATIONS; i++) {
      runPass(jacobiProg!, pressure.write, () => {
        bindTex(0, pressure!.read.texture);
        bindTex(1, divergence!.texture);
        gl!.uniform1i(jUniforms.uPressure, 0);
        gl!.uniform1i(jUniforms.uDivergence, 1);
        gl!.uniform2f(jUniforms.uTexel, 1 / NX, 1 / NY);
        gl!.uniform2f(jUniforms.uGridSize, NX, NY);
        sourceUniforms(jUniforms);
      });
      pressure.swap();
    }

    const gUniforms = gradientProg!.uniforms;
    runPass(gradientProg!, velocity.write, () => {
      bindTex(0, velocity!.read.texture);
      bindTex(1, pressure!.read.texture);
      gl!.uniform1i(gUniforms.uVel, 0);
      gl!.uniform1i(gUniforms.uPressure, 1);
      gl!.uniform2f(gUniforms.uTexel, 1 / NX, 1 / NY);
      gl!.uniform2f(gUniforms.uGridSize, NX, NY);
      sourceUniforms(gUniforms);
    });
    velocity.swap();
  }

  function advectVelocity(dt: number) {
    if (!velocity) return;
    const { uniforms } = advectVelProg!;
    runPass(advectVelProg!, velocity.write, () => {
      bindTex(0, velocity!.read.texture);
      gl!.uniform1i(uniforms.uVel, 0);
      gl!.uniform2f(uniforms.uTexel, 1 / NX, 1 / NY);
      gl!.uniform2f(uniforms.uGridSize, NX, NY);
      gl!.uniform1f(uniforms.uDt, dt);
      sourceUniforms(uniforms);
    });
    velocity.swap();
  }

  function advectTemperature(dt: number) {
    if (!temperature || !velocity) return;
    const { uniforms } = advectTempProg!;
    runPass(advectTempProg!, temperature.write, () => {
      bindTex(0, temperature!.read.texture);
      bindTex(1, velocity!.read.texture);
      gl!.uniform1i(uniforms.uTemp, 0);
      gl!.uniform1i(uniforms.uVel, 1);
      gl!.uniform2f(uniforms.uTexel, 1 / NX, 1 / NY);
      gl!.uniform2f(uniforms.uGridSize, NX, NY);
      gl!.uniform1f(uniforms.uDt, dt);
      gl!.uniform1f(uniforms.uSourceTemp, SOURCE_TEMP);
      sourceUniforms(uniforms);
    });
    temperature.swap();
  }

  function drawFrame() {
    if (!temperature) return;
    gl!.clearColor(0, 0, 0, 0);
    gl!.bindFramebuffer(gl!.FRAMEBUFFER, null);
    gl!.viewport(0, 0, canvas.width, canvas.height);
    gl!.clear(gl!.COLOR_BUFFER_BIT);

    const { uniforms } = renderProg!;
    runPass(renderProg!, null, () => {
      bindTex(0, temperature!.read.texture);
      gl!.uniform1i(uniforms.uTemp, 0);
    });
  }

  function simStep(dt: number) {
    applyBoundary();
    applyBuoyancy(dt);
    applyBoundary();
    project();
    applyBoundary();
    advectVelocity(dt);
    project();
    advectTemperature(dt);
  }

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    width = window.innerWidth;
    height = window.innerHeight;
    canvas.width = Math.max(1, Math.round(width * dpr));
    canvas.height = Math.max(1, Math.round(height * dpr));

    const aspect = height > 0 ? width / height : 2;
    const nextNX = clamp(Math.round(BASE_NY * aspect), MIN_NX, MAX_NX);
    const nextNY = BASE_NY;

    if (nextNX !== NX || nextNY !== NY || !velocity) {
      allocateGrid(nextNX, nextNY);
    }
    sourceRadiusGrid = Math.max(3, Math.min(NX, NY) * SOURCE_RADIUS_FRAC);

    gl!.viewport(0, 0, canvas.width, canvas.height);
    gl!.clearColor(0, 0, 0, 0);
    gl!.clear(gl!.COLOR_BUFFER_BIT);
  }

  function render(now: number) {
    if (!running) return;
    const realDt = Math.min(0.045, Math.max(0.001, (now - last) / 1000));
    last = now;

    const totalDt = realDt * BASE_TIME_SCALE;
    const substeps = Math.max(1, Math.ceil(totalDt / MAX_SUBSTEP_DT));
    const stepDt = totalDt / substeps;
    for (let s = 0; s < substeps; s++) simStep(stepDt);

    drawFrame();
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

  const onVisibilityChange = () => {
    if (document.hidden) stop();
    else start();
  };



  resize();
  applyBoundary();
  project();
  drawFrame(); // static first frame either way

  window.addEventListener("resize", resize);
  document.addEventListener("visibilitychange", onVisibilityChange);
  start();

  return {
    start,
    stop,
    destroy() {
      stop();
      window.removeEventListener("resize", resize);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      freeGrid();
    },
  };
}