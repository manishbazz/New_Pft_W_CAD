"use client";

import type { FlowController } from "./types";

/**
 * WebGL2 (GPU) backend — same physics/pipeline as the CPU version, but
 * every pass (boundary, divergence, pressure Jacobi, advection) runs as a
 * fragment shader over the whole grid at once instead of a JS for-loop.
 *
 * Must only be constructed after supportsGpuFlowSim() has confirmed
 * WebGL2 + float-render-target support on a throwaway canvas — calling
 * getContext('webgl2') on `canvas` here permanently commits it to WebGL.
 */

const BASE_NY = 120;
const MIN_NX = 140;
const MAX_NX = 340;
const PROJECT_ITERATIONS = 40;

const BASE_TIME_SCALE = 55;
const MAX_SUBSTEP_DT = 0.16;
const DYE_SPEED_MULTIPLIER = 1.5;

const SMOKE_BAND_MARGIN = 3;
const STRIPE_SPACING = 3;
const STRIPE_WIDTH = 2;

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
uniform vec2 uObstacleCenterGrid;
uniform float uObstacleRadiusGrid;
void main() {
  vec2 gridPos = vUv * uGridSize;
  vec2 vel = texture(uVel, vUv).xy;
  if (gridPos.x < 1.5) {
    vel = vec2(1.0, 0.0);
  } else if (gridPos.x > uGridSize.x - 1.5) {
    vel = texture(uVel, vUv - vec2(uTexel.x, 0.0)).xy;
  }
  if (gridPos.y < 1.0 || gridPos.y > uGridSize.y - 1.0) {
    vel.y = 0.0;
  }
  if (distance(gridPos, uObstacleCenterGrid) < uObstacleRadiusGrid) {
    vel = vec2(0.0);
  }
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
uniform vec2 uObstacleCenterGrid;
uniform float uObstacleRadiusGrid;
void main() {
  vec2 gridPos = vUv * uGridSize;
  vec2 vel = texture(uVel, vUv).xy;
  vec2 backUv = clamp(vUv - vel * uTexel * uDt, vec2(0.0), vec2(1.0));
  vec2 newVel = texture(uVel, backUv).xy;

  if (gridPos.x < 1.5) {
    newVel = vec2(1.0, 0.0);
  } else if (gridPos.x > uGridSize.x - 1.5) {
    newVel = texture(uVel, vUv - vec2(uTexel.x, 0.0)).xy;
  }
  if (gridPos.y < 1.0 || gridPos.y > uGridSize.y - 1.0) {
    newVel.y = 0.0;
  }
  if (distance(gridPos, uObstacleCenterGrid) < uObstacleRadiusGrid) {
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
uniform vec2 uObstacleCenterGrid;
uniform float uObstacleRadiusGrid;
void main() {
  vec2 gridPos = vUv * uGridSize;
  if (distance(gridPos, uObstacleCenterGrid) < uObstacleRadiusGrid) {
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
uniform vec2 uObstacleCenterGrid;
uniform float uObstacleRadiusGrid;
bool isSolid(vec2 g) { return distance(g, uObstacleCenterGrid) < uObstacleRadiusGrid; }
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
uniform vec2 uObstacleCenterGrid;
uniform float uObstacleRadiusGrid;
bool isSolid(vec2 g) { return distance(g, uObstacleCenterGrid) < uObstacleRadiusGrid; }
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

const ADVECT_DYE_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uDye;
uniform sampler2D uVel;
uniform vec2 uTexel;
uniform vec2 uGridSize;
uniform float uDt;
uniform float uDyeSpeedMult;
uniform vec2 uObstacleCenterGrid;
uniform float uObstacleRadiusGrid;
uniform float uStripeSpacing;
uniform float uStripeWidth;
uniform float uBandMargin;
void main() {
  vec2 gridPos = vUv * uGridSize;
  if (distance(gridPos, uObstacleCenterGrid) < uObstacleRadiusGrid) {
    outColor = vec4(0.0);
    return;
  }
  vec2 vel = texture(uVel, vUv).xy;
  vec2 backUv = clamp(vUv - vel * uTexel * uDt * uDyeSpeedMult, vec2(0.0), vec2(1.0));
  float d = texture(uDye, backUv).r;

  if (gridPos.x < 2.0) {
    float centerY = uGridSize.y * 0.5;
    float bandHalf = uObstacleRadiusGrid + uBandMargin;
    if (abs(gridPos.y - centerY) <= bandHalf) {
      float band = mod(floor(gridPos.y), uStripeSpacing);
      if (band < uStripeWidth) d = 1.0;
    }
  }
  if (gridPos.y < 1.0 || gridPos.y > uGridSize.y - 1.0) {
    d = 0.0;
  }
  outColor = vec4(d, 0.0, 0.0, 1.0);
}`;

const RENDER_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uDye;
uniform vec2 uGridSize;
uniform vec2 uObstacleCenterGrid;
uniform float uObstacleRadiusGrid;
void main() {
  float a = clamp(texture(uDye, vUv).r, 0.0, 1.0);
  vec3 bg = vec3(7.0, 8.0, 9.0) / 255.0;
  vec3 fg = vec3(143.0, 163.0, 176.0) / 255.0;
  vec3 col = mix(bg, fg, a);

  vec2 gridPos = vUv * uGridSize;
  float d = distance(gridPos, uObstacleCenterGrid);
  if (d < uObstacleRadiusGrid) {
    col = bg;
  }
  float edge =
    smoothstep(uObstacleRadiusGrid - 0.8, uObstacleRadiusGrid, d) -
    smoothstep(uObstacleRadiusGrid, uObstacleRadiusGrid + 0.8, d);
  col = mix(col, fg, edge * 0.95);

  outColor = vec4(col, 1.0);
}`;

type Program = {
  program: WebGLProgram;
  uniforms: Record<string, WebGLUniformLocation | null>;
};

type Target = {
  texture: WebGLTexture;
  fbo: WebGLFramebuffer;
};

type DoubleTarget = {
  read: Target;
  write: Target;
  swap: () => void;
};

export function createGpuFlowSim(
  canvas: HTMLCanvasElement,
  isPlayingRef: { current: boolean },
): FlowController | null {
  const gl = canvas.getContext("webgl2", { alpha: false });
  if (!gl) return null;
  const ext = gl.getExtension("EXT_color_buffer_float");
  if (!ext) return null;

  function compile(type: number, src: string): WebGLShader | null {
    const shader = gl!.createShader(type);
    if (!shader) return null;
    gl!.shaderSource(shader, src);
    gl!.compileShader(shader);
    if (!gl!.getShaderParameter(shader, gl!.COMPILE_STATUS)) {
      console.error("Flow sim shader compile error:", gl!.getShaderInfoLog(shader));
      gl!.deleteShader(shader);
      return null;
    }
    return shader;
  }

  function createProgram(fragSrc: string, uniformNames: string[]): Program | null {
    const vs = compile(gl!.VERTEX_SHADER, VERT_SRC);
    const fs = compile(gl!.FRAGMENT_SHADER, fragSrc);
    if (!vs || !fs) return null;
    const program = gl!.createProgram();
    if (!program) return null;
    gl!.attachShader(program, vs);
    gl!.attachShader(program, fs);
    gl!.linkProgram(program);
    if (!gl!.getProgramParameter(program, gl!.LINK_STATUS)) {
      console.error("Flow sim program link error:", gl!.getProgramInfoLog(program));
      return null;
    }
    const uniforms: Record<string, WebGLUniformLocation | null> = {};
    for (const name of uniformNames) {
      uniforms[name] = gl!.getUniformLocation(program, name);
    }
    return { program, uniforms };
  }

  // Fullscreen quad, shared by every pass.
  const quadBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
    gl.STATIC_DRAW,
  );

  function bindQuad(program: WebGLProgram) {
    const loc = gl!.getAttribLocation(program, "aPos");
    gl!.bindBuffer(gl!.ARRAY_BUFFER, quadBuffer);
    gl!.enableVertexAttribArray(loc);
    gl!.vertexAttribPointer(loc, 2, gl!.FLOAT, false, 0, 0);
  }

  function createTarget(
    w: number,
    h: number,
    internalFormat: number,
    format: number,
  ): Target | null {
    const texture = gl!.createTexture();
    if (!texture) return null;
    gl!.bindTexture(gl!.TEXTURE_2D, texture);
    gl!.texImage2D(gl!.TEXTURE_2D, 0, internalFormat, w, h, 0, format, gl!.HALF_FLOAT, null);
    gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_MIN_FILTER, gl!.LINEAR);
    gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_MAG_FILTER, gl!.LINEAR);
    gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_WRAP_S, gl!.CLAMP_TO_EDGE);
    gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_WRAP_T, gl!.CLAMP_TO_EDGE);

    const fbo = gl!.createFramebuffer();
    if (!fbo) return null;
    gl!.bindFramebuffer(gl!.FRAMEBUFFER, fbo);
    gl!.framebufferTexture2D(gl!.FRAMEBUFFER, gl!.COLOR_ATTACHMENT0, gl!.TEXTURE_2D, texture, 0);
    gl!.bindFramebuffer(gl!.FRAMEBUFFER, null);
    return { texture, fbo };
  }

  function createDoubleTarget(w: number, h: number, internalFormat: number, format: number): DoubleTarget | null {
    const a = createTarget(w, h, internalFormat, format);
    const b = createTarget(w, h, internalFormat, format);
    if (!a || !b) return null;
    const state: DoubleTarget = {
      read: a,
      write: b,
      swap() {
        const tmp = state.read;
        state.read = state.write;
        state.write = tmp;
      },
    };
    return state;
  }

  const boundaryProg = createProgram(BOUNDARY_FRAG, [
    "uVel", "uTexel", "uGridSize", "uObstacleCenterGrid", "uObstacleRadiusGrid",
  ]);
  const advectVelProg = createProgram(ADVECT_VEL_FRAG, [
    "uVel", "uTexel", "uGridSize", "uDt", "uObstacleCenterGrid", "uObstacleRadiusGrid",
  ]);
  const divergenceProg = createProgram(DIVERGENCE_FRAG, [
    "uVel", "uTexel", "uGridSize", "uObstacleCenterGrid", "uObstacleRadiusGrid",
  ]);
  const jacobiProg = createProgram(JACOBI_FRAG, [
    "uPressure", "uDivergence", "uTexel", "uGridSize", "uObstacleCenterGrid", "uObstacleRadiusGrid",
  ]);
  const gradientProg = createProgram(GRADIENT_SUBTRACT_FRAG, [
    "uVel", "uPressure", "uTexel", "uGridSize", "uObstacleCenterGrid", "uObstacleRadiusGrid",
  ]);
  const advectDyeProg = createProgram(ADVECT_DYE_FRAG, [
    "uDye", "uVel", "uTexel", "uGridSize", "uDt", "uDyeSpeedMult",
    "uObstacleCenterGrid", "uObstacleRadiusGrid", "uStripeSpacing", "uStripeWidth", "uBandMargin",
  ]);
  const renderProg = createProgram(RENDER_FRAG, [
    "uDye", "uGridSize", "uObstacleCenterGrid", "uObstacleRadiusGrid",
  ]);

  if (
    !boundaryProg || !advectVelProg || !divergenceProg ||
    !jacobiProg || !gradientProg || !advectDyeProg || !renderProg
  ) {
    return null;
  }

  let NX = MIN_NX;
  let NY = BASE_NY;

  let velocity: DoubleTarget | null = null;
  let pressure: DoubleTarget | null = null;
  let divergence: Target | null = null;
  let dye: DoubleTarget | null = null;

  let width = 0;
  let height = 0;
  let dpr = 1;

  let bodyFracX = 0.42;
  let bodyFracY = 0.5;
  let targetFracX = bodyFracX;
  let targetFracY = bodyFracY;
  let bodyRadiusGrid = 1;
  let hovering = false;
  let raf = 0;
  let running = false;
  let last = performance.now();

  const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

  function allocateGrid(nx: number, ny: number) {
    NX = nx;
    NY = ny;
    velocity = createDoubleTarget(NX, NY, gl!.RG16F, gl!.RG);
    pressure = createDoubleTarget(NX, NY, gl!.R16F, gl!.RED);
    divergence = createTarget(NX, NY, gl!.R16F, gl!.RED);
    dye = createDoubleTarget(NX, NY, gl!.R16F, gl!.RED);
  }

  function runPass(prog: Program, target: Target | null, setup: () => void) {
    gl!.useProgram(prog.program);
    bindQuad(prog.program);
    gl!.bindFramebuffer(gl!.FRAMEBUFFER, target ? target.fbo : null);
    gl!.viewport(0, 0, target ? NX : canvas.width, target ? NY : canvas.height);
    setup();
    gl!.drawArrays(gl!.TRIANGLE_STRIP, 0, 4);
  }

  function bindTex(unit: number, tex: WebGLTexture) {
    gl!.activeTexture(gl!.TEXTURE0 + unit);
    gl!.bindTexture(gl!.TEXTURE_2D, tex);
  }

  function obstacleUniforms(u: Record<string, WebGLUniformLocation | null>) {
    gl!.uniform2f(u.uObstacleCenterGrid, bodyFracX * NX, bodyFracY * NY);
    gl!.uniform1f(u.uObstacleRadiusGrid, bodyRadiusGrid);
  }

  function applyBoundary() {
    if (!velocity) return;
    const { uniforms } = boundaryProg!;
    runPass(boundaryProg!, velocity.write, () => {
      bindTex(0, velocity!.read.texture);
      gl!.uniform1i(uniforms.uVel, 0);
      gl!.uniform2f(uniforms.uTexel, 1 / NX, 1 / NY);
      gl!.uniform2f(uniforms.uGridSize, NX, NY);
      obstacleUniforms(uniforms);
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
      obstacleUniforms(dUniforms);
    });

    const jUniforms = jacobiProg!.uniforms;
    // Clear pressure read buffer to 0 before iterating, matching the CPU
    // version resetting p[] each project() call.
    gl!.bindFramebuffer(gl!.FRAMEBUFFER, pressure.read.fbo);
    gl!.viewport(0, 0, NX, NY);
    gl!.clearColor(0, 0, 0, 1);
    gl!.clear(gl!.COLOR_BUFFER_BIT);

    for (let i = 0; i < PROJECT_ITERATIONS; i++) {
      runPass(jacobiProg!, pressure.write, () => {
        bindTex(0, pressure!.read.texture);
        bindTex(1, divergence!.texture);
        gl!.uniform1i(jUniforms.uPressure, 0);
        gl!.uniform1i(jUniforms.uDivergence, 1);
        gl!.uniform2f(jUniforms.uTexel, 1 / NX, 1 / NY);
        gl!.uniform2f(jUniforms.uGridSize, NX, NY);
        obstacleUniforms(jUniforms);
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
      obstacleUniforms(gUniforms);
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
      obstacleUniforms(uniforms);
    });
    velocity.swap();
  }

  function advectDye(dt: number) {
    if (!dye || !velocity) return;
    const { uniforms } = advectDyeProg!;
    runPass(advectDyeProg!, dye.write, () => {
      bindTex(0, dye!.read.texture);
      bindTex(1, velocity!.read.texture);
      gl!.uniform1i(uniforms.uDye, 0);
      gl!.uniform1i(uniforms.uVel, 1);
      gl!.uniform2f(uniforms.uTexel, 1 / NX, 1 / NY);
      gl!.uniform2f(uniforms.uGridSize, NX, NY);
      gl!.uniform1f(uniforms.uDt, dt);
      gl!.uniform1f(uniforms.uDyeSpeedMult, DYE_SPEED_MULTIPLIER);
      gl!.uniform1f(uniforms.uStripeSpacing, STRIPE_SPACING);
      gl!.uniform1f(uniforms.uStripeWidth, STRIPE_WIDTH);
      gl!.uniform1f(uniforms.uBandMargin, SMOKE_BAND_MARGIN);
      obstacleUniforms(uniforms);
    });
    dye.swap();
  }

  function drawFrame() {
    if (!dye) return;
    const { uniforms } = renderProg!;
    runPass(renderProg!, null, () => {
      bindTex(0, dye!.read.texture);
      gl!.uniform1i(uniforms.uDye, 0);
      gl!.uniform2f(uniforms.uGridSize, NX, NY);
      obstacleUniforms(uniforms);
    });
  }

  function simStep(dt: number) {
    if (hovering) {
      bodyFracX += (targetFracX - bodyFracX) * 0.12;
      bodyFracY += (targetFracY - bodyFracY) * 0.12;
    }
    applyBoundary();
    project();
    applyBoundary();
    advectVelocity(dt);
    project();
    advectDye(dt);
  }

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    width = canvas.clientWidth;
    height = canvas.clientHeight;
    canvas.width = Math.max(1, Math.round(width * dpr));
    canvas.height = Math.max(1, Math.round(height * dpr));

    const aspect = height > 0 ? width / height : 2;
    const nextNX = clamp(Math.round(BASE_NY * aspect), MIN_NX, MAX_NX);
    const nextNY = BASE_NY;

    if (nextNX !== NX || nextNY !== NY || !velocity) {
      allocateGrid(nextNX, nextNY);
    }
    bodyRadiusGrid = Math.max(4, Math.min(NX, NY) * 0.14);

    gl!.viewport(0, 0, canvas.width, canvas.height);
    gl!.clearColor(7 / 255, 8 / 255, 9 / 255, 1);
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

  const onPointerMove = (event: PointerEvent) => {
    const rect = canvas.getBoundingClientRect();
    const marginX = (bodyRadiusGrid + 2) / NX;
    const marginY = (bodyRadiusGrid + 2) / NY;
    targetFracX = clamp((event.clientX - rect.left) / Math.max(rect.width, 1), marginX, 1 - marginX);
    targetFracY = clamp(
      1 - (event.clientY - rect.top) / Math.max(rect.height, 1),
      marginY,
      1 - marginY,
    );
    hovering = true;
  };
  const onVisibilityChange = () => {
    if (document.hidden) stop();
    else if (isPlayingRef.current) start();
  };

  resize();
  applyBoundary();
  project();
  drawFrame();

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
