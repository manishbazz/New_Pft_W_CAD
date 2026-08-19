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
 * Full-viewport Boussinesq natural-convection background: the entire
 * floor is a heated wall, driving a buoyant sheet of "smoke" up through
 * an otherwise-quiescent domain. No obstacle, no pointer tracking — heat
 * injection happens directly in the temperature boundary condition
 * (see ADVECT_TEMP_FRAG). Same Stable Fluids projection method
 * underneath, plus one extra pass: buoyancy force proportional to
 * (T - T_ambient), applied to velocity before each projection.
 *
 * COORDINATE CONVENTION (read this before touching boundary conditions):
 * gridPos = vUv * uGridSize renders, on the default framebuffer, with
 * gridPos.y ≈ 0 at the physical BOTTOM of the visible canvas and
 * gridPos.y ≈ NY at the physical TOP — this is WebGL's clip-space
 * convention (viewport row 0 = bottom-left), not a bug. So: the heated
 * floor sits at gridPos.y = 0; the open "chimney" outflow is at
 * gridPos.y = NY.
 *
 * RENDER: plain white smoke (alpha follows temperature — cold is fully
 * transparent, hot is opaque white) instead of a color gradient, with a
 * velocity-weighted blur: the render pass takes a few extra taps of the
 * temperature field along the local flow direction, spread further apart
 * where the flow is faster, so fast-moving smoke smears while still
 * smoke stays sharp — rather than a single fixed blur radius everywhere.
 *
 * GPU-only: no CPU fallback. This is a decorative, always-on background,
 * and a JS for-loop version running continuously behind page content is a
 * much worse trade than simply not rendering it on unsupported browsers.
 */

// Deliberately coarse — this is a soft, ambient background element, not
// a detailed sim, so a small grid keeps it cheap even at full-viewport
// resolution and full DPR.
const BASE_NY = 48;
const MIN_NX = 48;
const MAX_NX = 140;
const PROJECT_ITERATIONS = 28;

const BASE_TIME_SCALE = 30;
const MAX_SUBSTEP_DT = 0.16;

const BUOYANCY = 3.2;
const AMBIENT_TEMP = 0.0;
const SOURCE_TEMP = 1.0;

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
void main() {
  vec2 gridPos = vUv * uGridSize;
  vec2 vel = texture(uVel, vUv).xy;

  // Left / right walls: no-slip.
  if (gridPos.x < 1.0 || gridPos.x > uGridSize.x - 1.0) {
    vel = vec2(0.0);
  }
  // gridPos.y ~ 0 is the physical BOTTOM of the canvas — the heated floor.
  if (gridPos.y < 1.0) {
    vel = vec2(0.0);
  }
  // gridPos.y ~ NY is the physical TOP — open chimney, zero-gradient.
  if (gridPos.y > uGridSize.y - 1.0) {
    vel = texture(uVel, vUv - vec2(0.0, uTexel.y)).xy;
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
  outColor = vec4(newVel, 0.0, 1.0);
}`;

const DIVERGENCE_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uVel;
uniform vec2 uTexel;
void main() {
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
void main() {
  float self = texture(uPressure, vUv).r;
  float div = texture(uDivergence, vUv).r;
  float L = texture(uPressure, vUv - vec2(uTexel.x, 0.0)).r;
  float R = texture(uPressure, vUv + vec2(uTexel.x, 0.0)).r;
  float B = texture(uPressure, vUv - vec2(0.0, uTexel.y)).r;
  float T = texture(uPressure, vUv + vec2(0.0, uTexel.y)).r;
  outColor = vec4((div + L + R + B + T) * 0.25, 0.0, 0.0, 1.0);
}`;

const GRADIENT_SUBTRACT_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uVel;
uniform sampler2D uPressure;
uniform vec2 uTexel;
void main() {
  vec2 vel = texture(uVel, vUv).xy;
  float L = texture(uPressure, vUv - vec2(uTexel.x, 0.0)).r;
  float R = texture(uPressure, vUv + vec2(uTexel.x, 0.0)).r;
  float B = texture(uPressure, vUv - vec2(0.0, uTexel.y)).r;
  float T = texture(uPressure, vUv + vec2(0.0, uTexel.y)).r;
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
uniform float uSourceTemp;
void main() {
  vec2 gridPos = vUv * uGridSize;
  vec2 vel = texture(uVel, vUv).xy;
  vec2 backUv = clamp(vUv - vel * uTexel * uDt, vec2(0.0), vec2(1.0));
  float t = texture(uTemp, backUv).r;

  // Heat source: the entire floor (gridPos.y ~ 0) is fixed at
  // uSourceTemp — this is the only place T is injected, everywhere else
  // is pure advection of what's already there. Side walls stay ambient.
  if (gridPos.y < 1.0) {
    t = uSourceTemp;
  } else if (gridPos.x < 1.0 || gridPos.x > uGridSize.x - 1.0) {
    t = 0.0;
  }
  outColor = vec4(t, 0.0, 0.0, 1.0);
}`;

const RENDER_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uTemp;
uniform sampler2D uVel;
uniform vec2 uTexel;

const int SAMPLES = 5;

void main() {
  vec2 vel = texture(uVel, vUv).xy;
  float speed = length(vel);

  // Motion blur strength scales with local flow speed — still smoke
  // stays sharp, fast-moving smoke smears along its direction of
  // travel. No fixed/uniform blur radius.
  vec2 dir = speed > 0.0001 ? vel / speed : vec2(0.0, 1.0);
  float blurAmount = clamp(speed * 0.5, 0.0, 5.0);

  float t = 0.0;
  float wSum = 0.0;
  for (int i = 0; i < SAMPLES; i++) {
    float f = (float(i) / float(SAMPLES - 1)) - 0.5; // -0.5 .. 0.5
    vec2 uv = vUv + dir * f * blurAmount * uTexel;
    float w = 1.0 - abs(f) * 0.8;
    t += clamp(texture(uTemp, uv).r, 0.0, 1.0) * w;
    wSum += w;
  }
  t = clamp(t / wSum, 0.0, 1.0);

  // Cold -> transparent (page background shows through). Hot -> white smoke.
  float alpha = smoothstep(0.03, 0.9, t) * 0.8;
  outColor = vec4(vec3(1.0), alpha);
}`;

export function createConvectionSim(canvas: HTMLCanvasElement): FlowController | null {
  const gl = canvas.getContext("webgl2", { alpha: true, premultipliedAlpha: false });
  if (!gl) {
    console.warn("[convection-sim] WebGL2 context unavailable — smoke bg disabled.");
    return null;
  }
  if (!gl.getExtension("EXT_color_buffer_float")) {
    console.warn("[convection-sim] EXT_color_buffer_float unsupported — smoke bg disabled.");
    return null;
  }

  // No blending anywhere in this pipeline: every pass (sim + final render)
  // is a fullscreen quad that fully overwrites its target each frame, so
  // there's nothing to blend with. Leaving BLEND enabled here previously
  // caused the final render-to-canvas draw to get pre-multiplied by alpha
  // on the way in (via SRC_ALPHA blending against a transparent-cleared
  // canvas), while the context is configured with premultipliedAlpha:
  // false — so the browser multiplied by alpha a SECOND time when
  // compositing onto the page, making the smoke fade as alpha^3 instead
  // of alpha. Near-invisible in practice. Blending is simply unnecessary
  // here, so it stays off.
  gl.disable(gl.BLEND);

  const quadBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);

  function bindQuad(loc: number) {
    gl!.bindBuffer(gl!.ARRAY_BUFFER, quadBuffer);
    gl!.enableVertexAttribArray(loc);
    gl!.vertexAttribPointer(loc, 2, gl!.FLOAT, false, 0, 0);
  }

  const boundaryProg = createGLProgram(gl, BOUNDARY_FRAG, ["uVel", "uTexel", "uGridSize"], VERT_SRC);
  const buoyancyProg = createGLProgram(gl, BUOYANCY_FRAG, ["uVel", "uTemp", "uDt", "uBuoyancy", "uAmbientTemp"], VERT_SRC);
  const advectVelProg = createGLProgram(gl, ADVECT_VEL_FRAG, ["uVel", "uTexel", "uGridSize", "uDt"], VERT_SRC);
  const divergenceProg = createGLProgram(gl, DIVERGENCE_FRAG, ["uVel", "uTexel"], VERT_SRC);
  const jacobiProg = createGLProgram(gl, JACOBI_FRAG, ["uPressure", "uDivergence", "uTexel"], VERT_SRC);
  const gradientProg = createGLProgram(gl, GRADIENT_SUBTRACT_FRAG, ["uVel", "uPressure", "uTexel"], VERT_SRC);
  const advectTempProg = createGLProgram(gl, ADVECT_TEMP_FRAG, ["uTemp", "uVel", "uTexel", "uGridSize", "uDt", "uSourceTemp"], VERT_SRC);
  const renderProg = createGLProgram(gl, RENDER_FRAG, ["uTemp", "uVel", "uTexel"], VERT_SRC);

  if (!boundaryProg || !buoyancyProg || !advectVelProg || !divergenceProg || !jacobiProg || !gradientProg || !advectTempProg || !renderProg) {
    console.warn("[convection-sim] one or more shader programs failed to compile/link — smoke bg disabled.");
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

  function applyBoundary() {
    if (!velocity) return;
    const { uniforms } = boundaryProg!;
    runPass(boundaryProg!, velocity.write, () => {
      bindTex(0, velocity!.read.texture);
      gl!.uniform1i(uniforms.uVel, 0);
      gl!.uniform2f(uniforms.uTexel, 1 / NX, 1 / NY);
      gl!.uniform2f(uniforms.uGridSize, NX, NY);
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
    });
    temperature.swap();
  }

  function drawFrame() {
    if (!temperature || !velocity) return;
    gl!.clearColor(0, 0, 0, 0);
    gl!.bindFramebuffer(gl!.FRAMEBUFFER, null);
    gl!.viewport(0, 0, canvas.width, canvas.height);
    gl!.clear(gl!.COLOR_BUFFER_BIT);

    const { uniforms } = renderProg!;
    runPass(renderProg!, null, () => {
      bindTex(0, temperature!.read.texture);
      bindTex(1, velocity!.read.texture);
      gl!.uniform1i(uniforms.uTemp, 0);
      gl!.uniform1i(uniforms.uVel, 1);
      gl!.uniform2f(uniforms.uTexel, 1 / NX, 1 / NY);
    });
  }

  function simStep(dt: number) {
    applyBoundary();
    applyBuoyancy(dt);
    // NOTE: no applyBoundary() here. The floor's no-slip condition still
    // gets enforced (right below, before advectVelocity), but project()
    // needs to see the buoyant impulse at the floor row FIRST — the
    // pressure solve is what actually pushes that momentum into row 1
    // and above. Zeroing the floor velocity before project() (as this
    // used to do) discarded the buoyancy step entirely: heat would stay
    // pinned to the floor row forever with nothing ever rising.
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