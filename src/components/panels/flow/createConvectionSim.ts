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
 * underneath, plus two extra passes: buoyancy force proportional to
 * (T - T_ambient), applied to velocity before each projection; and an
 * implicit diffuse step (viscosity on velocity, thermal diffusivity on
 * temperature) — the classic middle step of Stam's
 * forces->diffuse->project->advect pipeline. See diffuseVelocity /
 * diffuseTemperature below.
 *
 * COORDINATE CONVENTION (read this before touching boundary conditions):
 * gridPos = vUv * uGridSize renders, on the default framebuffer, with
 * gridPos.y ≈ 0 at the physical BOTTOM of the visible canvas and
 * gridPos.y ≈ NY at the physical TOP — this is WebGL's clip-space
 * convention (viewport row 0 = bottom-left), not a bug. So: the heated
 * floor sits at gridPos.y = 0; the open "chimney" outflow is at
 * gridPos.y = NY.
 *
 * RENDER: velocity-magnitude contour, in the style of a CFD post-processor
 * plot, instead of smoke. Speed is quantized into grayscale bands with a
 * thin isoline at each band edge; alpha follows speed too, so still air
 * is transparent (page shows through) and the plume itself is visible.
 * No directional motion blur — a narrow high-speed core reads as correct
 * for a contour plot, whereas the old smoke render's blur made the same
 * core look like a streaky, unnaturally thin jet.
 *
 * GPU-only: no CPU fallback. This is a decorative, always-on background,
 * and a JS for-loop version running continuously behind page content is a
 * much worse trade than simply not rendering it on unsupported browsers.
 *
 * OPTIONAL OBSTACLE: a single click-and-drag solid, off by default (see
 * setObstacle() on the returned controller / uObstacleHalfSizeGrid below —
 * half-size <= 0 means "no obstacle", which every isSolid() check
 * short-circuits on). Shape is square, circle, or triangle (setObstacleShape()
 * / uObstacleShape — see isSolid() in each pass below), following the same
 * isSolid-per-pass pattern as the circular obstacle in createGpuFlowSim.ts: BOUNDARY, ADVECT_VEL,
 * DIVERGENCE, JACOBI and GRADIENT_SUBTRACT all zero/hold velocity and
 * pressure inside it so the plume actually deflects around it instead of
 * passing straight through. ADVECT_TEMP pins the obstacle's interior back
 * to ambient temperature every frame — the diffuse passes below don't
 * individually re-clamp it (this is a soft decorative element, not a
 * strict solver), so a frame's worth of thermal diffusion can bleed a
 * sliver of heat in, but the next advect pass wipes it before it
 * accumulates into anything visible.
 */

// Deliberately coarse — this is a soft, ambient background element, not
// a detailed sim, so a small grid keeps it cheap even at full-viewport
// resolution and full DPR.
const BASE_NY = 48;
const MIN_NX = 48;
const MAX_NX = 140;
const PROJECT_ITERATIONS = 50;

const BASE_TIME_SCALE = 18;
const MAX_SUBSTEP_DT = 0.1;

const BUOYANCY = 2.0;
const AMBIENT_TEMP = 0.0;
const SOURCE_TEMP = 1.0;

// Implicit diffusion (Stam's "diffuse" step — same Jacobi-relaxation
// pattern as the pressure solve below, just a different stencil weight).
// VISCOSITY damps momentum: it's what lets a boundary layer build up at
// the heated floor so plumes have to overcome drag to detach, instead of
// accelerating into one continuous sheet. THERMAL_DIFFUSIVITY softens
// the temperature field's edges the same way. Both act on grid units
// (dx = 1, matching the rest of this solver). These need to be large
// enough to meaningfully bleed off momentum — buoyancy never turns off,
// so weak diffusion here is what lets velocity build past what a FIXED
// (not convergence-checked) PROJECT_ITERATIONS count can still fully
// project each frame, which is what causes the smooth-then-chaotic blowup.
const VISCOSITY = 0.4;
const THERMAL_DIFFUSIVITY = 0.15;
const DIFFUSE_ITERATIONS = 20;

// Extra safety net independent of how well the pressure solve converges:
// a small multiplicative velocity decay applied once per substep (see
// ADVECT_VEL_FRAG). Invisible on slow, smooth flow, but guarantees
// velocity can't grow unbounded even if PROJECT_ITERATIONS ever falls
// short again.
const VELOCITY_DAMPING = 0.99;

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
uniform float uObstacleHalfSizeGrid;
uniform float uObstacleShape;
// uObstacleShape: 0 = square, 1 = circle, 2 = equilateral triangle (apex up
// in grid space). Same shape test is duplicated verbatim across every pass
// below (see obstacleUniforms()) so the solver and the render pass always
// agree on what's solid.
bool isSolid(vec2 g) {
  if (uObstacleHalfSizeGrid <= 0.0) return false;
  vec2 d = g - uObstacleCenterGrid;
  if (uObstacleShape < 0.5) {
    vec2 ad = abs(d);
    return max(ad.x, ad.y) < uObstacleHalfSizeGrid;
  } else if (uObstacleShape < 1.5) {
    return length(d) < uObstacleHalfSizeGrid;
  } else {
    float k = 1.7320508; // sqrt(3)
    vec2 p = d;
    p.x = abs(p.x) - uObstacleHalfSizeGrid;
    p.y = p.y + uObstacleHalfSizeGrid / k;
    if (p.x + k * p.y > 0.0) {
      p = vec2(p.x - k * p.y, -k * p.x - p.y) * 0.5;
    }
    p.x -= clamp(p.x, -2.0 * uObstacleHalfSizeGrid, 0.0);
    return (-length(p) * sign(p.y)) < 0.0;
  }
}
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
  if (isSolid(gridPos)) {
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
uniform float uDamping;
uniform vec2 uObstacleCenterGrid;
uniform float uObstacleHalfSizeGrid;
uniform float uObstacleShape;
// uObstacleShape: 0 = square, 1 = circle, 2 = equilateral triangle (apex up
// in grid space). Same shape test is duplicated verbatim across every pass
// below (see obstacleUniforms()) so the solver and the render pass always
// agree on what's solid.
bool isSolid(vec2 g) {
  if (uObstacleHalfSizeGrid <= 0.0) return false;
  vec2 d = g - uObstacleCenterGrid;
  if (uObstacleShape < 0.5) {
    vec2 ad = abs(d);
    return max(ad.x, ad.y) < uObstacleHalfSizeGrid;
  } else if (uObstacleShape < 1.5) {
    return length(d) < uObstacleHalfSizeGrid;
  } else {
    float k = 1.7320508; // sqrt(3)
    vec2 p = d;
    p.x = abs(p.x) - uObstacleHalfSizeGrid;
    p.y = p.y + uObstacleHalfSizeGrid / k;
    if (p.x + k * p.y > 0.0) {
      p = vec2(p.x - k * p.y, -k * p.x - p.y) * 0.5;
    }
    p.x -= clamp(p.x, -2.0 * uObstacleHalfSizeGrid, 0.0);
    return (-length(p) * sign(p.y)) < 0.0;
  }
}
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
  if (isSolid(gridPos)) newVel = vec2(0.0);
  // Small multiplicative decay, once per substep — a safety net against
  // unbounded velocity growth independent of pressure-solve convergence.
  newVel *= uDamping;
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
uniform float uObstacleHalfSizeGrid;
uniform float uObstacleShape;
// uObstacleShape: 0 = square, 1 = circle, 2 = equilateral triangle (apex up
// in grid space). Same shape test is duplicated verbatim across every pass
// below (see obstacleUniforms()) so the solver and the render pass always
// agree on what's solid.
bool isSolid(vec2 g) {
  if (uObstacleHalfSizeGrid <= 0.0) return false;
  vec2 d = g - uObstacleCenterGrid;
  if (uObstacleShape < 0.5) {
    vec2 ad = abs(d);
    return max(ad.x, ad.y) < uObstacleHalfSizeGrid;
  } else if (uObstacleShape < 1.5) {
    return length(d) < uObstacleHalfSizeGrid;
  } else {
    float k = 1.7320508; // sqrt(3)
    vec2 p = d;
    p.x = abs(p.x) - uObstacleHalfSizeGrid;
    p.y = p.y + uObstacleHalfSizeGrid / k;
    if (p.x + k * p.y > 0.0) {
      p = vec2(p.x - k * p.y, -k * p.x - p.y) * 0.5;
    }
    p.x -= clamp(p.x, -2.0 * uObstacleHalfSizeGrid, 0.0);
    return (-length(p) * sign(p.y)) < 0.0;
  }
}
void main() {
  vec2 gridPos = vUv * uGridSize;
  if (isSolid(gridPos)) {
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
uniform float uObstacleHalfSizeGrid;
uniform float uObstacleShape;
// uObstacleShape: 0 = square, 1 = circle, 2 = equilateral triangle (apex up
// in grid space). Same shape test is duplicated verbatim across every pass
// below (see obstacleUniforms()) so the solver and the render pass always
// agree on what's solid.
bool isSolid(vec2 g) {
  if (uObstacleHalfSizeGrid <= 0.0) return false;
  vec2 d = g - uObstacleCenterGrid;
  if (uObstacleShape < 0.5) {
    vec2 ad = abs(d);
    return max(ad.x, ad.y) < uObstacleHalfSizeGrid;
  } else if (uObstacleShape < 1.5) {
    return length(d) < uObstacleHalfSizeGrid;
  } else {
    float k = 1.7320508; // sqrt(3)
    vec2 p = d;
    p.x = abs(p.x) - uObstacleHalfSizeGrid;
    p.y = p.y + uObstacleHalfSizeGrid / k;
    if (p.x + k * p.y > 0.0) {
      p = vec2(p.x - k * p.y, -k * p.x - p.y) * 0.5;
    }
    p.x -= clamp(p.x, -2.0 * uObstacleHalfSizeGrid, 0.0);
    return (-length(p) * sign(p.y)) < 0.0;
  }
}
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
uniform float uObstacleHalfSizeGrid;
uniform float uObstacleShape;
// uObstacleShape: 0 = square, 1 = circle, 2 = equilateral triangle (apex up
// in grid space). Same shape test is duplicated verbatim across every pass
// below (see obstacleUniforms()) so the solver and the render pass always
// agree on what's solid.
bool isSolid(vec2 g) {
  if (uObstacleHalfSizeGrid <= 0.0) return false;
  vec2 d = g - uObstacleCenterGrid;
  if (uObstacleShape < 0.5) {
    vec2 ad = abs(d);
    return max(ad.x, ad.y) < uObstacleHalfSizeGrid;
  } else if (uObstacleShape < 1.5) {
    return length(d) < uObstacleHalfSizeGrid;
  } else {
    float k = 1.7320508; // sqrt(3)
    vec2 p = d;
    p.x = abs(p.x) - uObstacleHalfSizeGrid;
    p.y = p.y + uObstacleHalfSizeGrid / k;
    if (p.x + k * p.y > 0.0) {
      p = vec2(p.x - k * p.y, -k * p.x - p.y) * 0.5;
    }
    p.x -= clamp(p.x, -2.0 * uObstacleHalfSizeGrid, 0.0);
    return (-length(p) * sign(p.y)) < 0.0;
  }
}
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
uniform float uSourceTemp;
uniform vec2 uObstacleCenterGrid;
uniform float uObstacleHalfSizeGrid;
uniform float uObstacleShape;
// uObstacleShape: 0 = square, 1 = circle, 2 = equilateral triangle (apex up
// in grid space). Same shape test is duplicated verbatim across every pass
// below (see obstacleUniforms()) so the solver and the render pass always
// agree on what's solid.
bool isSolid(vec2 g) {
  if (uObstacleHalfSizeGrid <= 0.0) return false;
  vec2 d = g - uObstacleCenterGrid;
  if (uObstacleShape < 0.5) {
    vec2 ad = abs(d);
    return max(ad.x, ad.y) < uObstacleHalfSizeGrid;
  } else if (uObstacleShape < 1.5) {
    return length(d) < uObstacleHalfSizeGrid;
  } else {
    float k = 1.7320508; // sqrt(3)
    vec2 p = d;
    p.x = abs(p.x) - uObstacleHalfSizeGrid;
    p.y = p.y + uObstacleHalfSizeGrid / k;
    if (p.x + k * p.y > 0.0) {
      p = vec2(p.x - k * p.y, -k * p.x - p.y) * 0.5;
    }
    p.x -= clamp(p.x, -2.0 * uObstacleHalfSizeGrid, 0.0);
    return (-length(p) * sign(p.y)) < 0.0;
  }
}
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
  // The obstacle is treated as a cool solid: pin its interior back to
  // ambient every frame (see file header re: diffuse-pass bleed).
  if (isSolid(gridPos)) {
    t = 0.0;
  }
  outColor = vec4(t, 0.0, 0.0, 1.0);
}`;

const COPY_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uSrc;
void main() { outColor = texture(uSrc, vUv); }`;

// Implicit diffusion, solved by Jacobi relaxation — structurally the same
// as JACOBI_FRAG above, but relaxing toward a fixed "pre-diffusion"
// source (uVel0) each iteration instead of a divergence field. uAlpha =
// diffusionRate * dt, uInvBeta = 1 / (1 + 4 * uAlpha). Vector version for
// velocity/momentum diffusion (viscosity).
const DIFFUSE_VEL_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uVel;
uniform sampler2D uVel0;
uniform vec2 uTexel;
uniform float uAlpha;
uniform float uInvBeta;
void main() {
  vec2 self0 = texture(uVel0, vUv).xy;
  vec2 L = texture(uVel, vUv - vec2(uTexel.x, 0.0)).xy;
  vec2 R = texture(uVel, vUv + vec2(uTexel.x, 0.0)).xy;
  vec2 B = texture(uVel, vUv - vec2(0.0, uTexel.y)).xy;
  vec2 T = texture(uVel, vUv + vec2(0.0, uTexel.y)).xy;
  vec2 result = (self0 + uAlpha * (L + R + B + T)) * uInvBeta;
  outColor = vec4(result, 0.0, 1.0);
}`;

// Same implicit diffusion, scalar version for temperature (thermal
// diffusivity).
const DIFFUSE_TEMP_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uTemp;
uniform sampler2D uTemp0;
uniform vec2 uTexel;
uniform float uAlpha;
uniform float uInvBeta;
void main() {
  float self0 = texture(uTemp0, vUv).r;
  float L = texture(uTemp, vUv - vec2(uTexel.x, 0.0)).r;
  float R = texture(uTemp, vUv + vec2(uTexel.x, 0.0)).r;
  float B = texture(uTemp, vUv - vec2(0.0, uTexel.y)).r;
  float T = texture(uTemp, vUv + vec2(0.0, uTexel.y)).r;
  float result = (self0 + uAlpha * (L + R + B + T)) * uInvBeta;
  outColor = vec4(result, 0.0, 0.0, 1.0);
}`;

const RENDER_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uVel;
uniform vec2 uGridSize;
uniform vec2 uObstacleCenterGrid;
uniform float uObstacleHalfSizeGrid;
uniform float uObstacleShape;

// Reference speed the contour scale is normalized against — tuned to the
// plume's typical peak speed at BUOYANCY = ${BUOYANCY}. Raise it if the
// core of the plume is pinned white/saturated; lower it if the whole
// field looks dim.
const float MAX_SPEED = 5.0;
const float BANDS = 9.0;

void main() {
  // Velocity-magnitude contour, like a CFD post-processor plot, instead
  // of a temperature-driven "smoke" alpha. No directional motion blur:
  // that pass was what made a fast, thin plume core read as a streaky
  // jet. A banded contour doesn't need to look like billowing smoke —
  // a narrow high-speed core in the center of the plume is exactly what
  // a real convection contour plot looks like, so it reads as correct
  // rather than as a rendering artifact.
  float speed = length(texture(uVel, vUv).xy);
  float s = clamp(speed / MAX_SPEED, 0.0, 1.0);

  // Quantize into discrete bands (dark = slow, white = fast).
  float banded = floor(s * BANDS) / BANDS;

  // Thin dark line at each band boundary, like an isoline.
  float edge = abs(fract(s * BANDS) - 0.5) * 2.0;
  float line = 1.0 - smoothstep(0.0, 0.12, edge);
  vec3 col = mix(vec3(banded), vec3(0.0), line * 0.45);

  // Still air -> transparent (page background shows through).
  // Moving air -> visible, capped so it stays a background element.
  float alpha = smoothstep(0.015, 0.2, s) * 0.55;

  // Draggable obstacle: drawn on top regardless of local speed, since it
  // needs to stay visible sitting in otherwise-still air. A soft fill
  // plus a slightly brighter 1px-ish edge line, in the same grayscale
  // palette as the contour so it reads as part of the same plot.
  if (uObstacleHalfSizeGrid > 0.0) {
    vec2 gridPos = vUv * uGridSize;
    vec2 d = gridPos - uObstacleCenterGrid;
    // Signed distance to the obstacle boundary (negative = inside),
    // matching whichever shape isSolid() is using for this frame — see
    // uObstacleShape above the isSolid() definitions in each sim pass.
    float sd;
    if (uObstacleShape < 0.5) {
      vec2 ad = abs(d);
      sd = max(ad.x, ad.y) - uObstacleHalfSizeGrid;
    } else if (uObstacleShape < 1.5) {
      sd = length(d) - uObstacleHalfSizeGrid;
    } else {
      float k = 1.7320508;
      vec2 p = d;
      p.x = abs(p.x) - uObstacleHalfSizeGrid;
      p.y = p.y + uObstacleHalfSizeGrid / k;
      if (p.x + k * p.y > 0.0) {
        p = vec2(p.x - k * p.y, -k * p.x - p.y) * 0.5;
      }
      p.x -= clamp(p.x, -2.0 * uObstacleHalfSizeGrid, 0.0);
      sd = -length(p) * sign(p.y);
    }
    float fill = 1.0 - smoothstep(-0.5, 0.5, sd);
    float outline = (1.0 - smoothstep(0.0, 0.7, abs(sd))) * 0.9;
    if (fill > 0.0 || outline > 0.0) {
      col = mix(col, vec3(0.72), max(fill * 0.5, outline));
      alpha = max(alpha, max(fill * 0.35, outline * 0.6));
    }
  }

  outColor = vec4(col, alpha);
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

  const boundaryProg = createGLProgram(gl, BOUNDARY_FRAG, ["uVel", "uTexel", "uGridSize", "uObstacleCenterGrid", "uObstacleHalfSizeGrid", "uObstacleShape"], VERT_SRC);
  const buoyancyProg = createGLProgram(gl, BUOYANCY_FRAG, ["uVel", "uTemp", "uDt", "uBuoyancy", "uAmbientTemp"], VERT_SRC);
  const advectVelProg = createGLProgram(gl, ADVECT_VEL_FRAG, ["uVel", "uTexel", "uGridSize", "uDt", "uDamping", "uObstacleCenterGrid", "uObstacleHalfSizeGrid", "uObstacleShape"], VERT_SRC);
  const divergenceProg = createGLProgram(gl, DIVERGENCE_FRAG, ["uVel", "uTexel", "uGridSize", "uObstacleCenterGrid", "uObstacleHalfSizeGrid", "uObstacleShape"], VERT_SRC);
  const jacobiProg = createGLProgram(gl, JACOBI_FRAG, ["uPressure", "uDivergence", "uTexel", "uGridSize", "uObstacleCenterGrid", "uObstacleHalfSizeGrid", "uObstacleShape"], VERT_SRC);
  const gradientProg = createGLProgram(gl, GRADIENT_SUBTRACT_FRAG, ["uVel", "uPressure", "uTexel", "uGridSize", "uObstacleCenterGrid", "uObstacleHalfSizeGrid", "uObstacleShape"], VERT_SRC);
  const advectTempProg = createGLProgram(gl, ADVECT_TEMP_FRAG, ["uTemp", "uVel", "uTexel", "uGridSize", "uDt", "uSourceTemp", "uObstacleCenterGrid", "uObstacleHalfSizeGrid", "uObstacleShape"], VERT_SRC);
  const copyProg = createGLProgram(gl, COPY_FRAG, ["uSrc"], VERT_SRC);
  const diffuseVelProg = createGLProgram(gl, DIFFUSE_VEL_FRAG, ["uVel", "uVel0", "uTexel", "uAlpha", "uInvBeta"], VERT_SRC);
  const diffuseTempProg = createGLProgram(gl, DIFFUSE_TEMP_FRAG, ["uTemp", "uTemp0", "uTexel", "uAlpha", "uInvBeta"], VERT_SRC);
  const renderProg = createGLProgram(gl, RENDER_FRAG, ["uVel", "uGridSize", "uObstacleCenterGrid", "uObstacleHalfSizeGrid", "uObstacleShape"], VERT_SRC);

  if (
    !boundaryProg || !buoyancyProg || !advectVelProg || !divergenceProg ||
    !jacobiProg || !gradientProg || !advectTempProg || !copyProg ||
    !diffuseVelProg || !diffuseTempProg || !renderProg
  ) {
    console.warn("[convection-sim] one or more shader programs failed to compile/link — smoke bg disabled.");
    return null;
  }

  let NX = MIN_NX;
  let NY = BASE_NY;

  let velocity: GLDoubleTarget | null = null;
  let pressure: GLDoubleTarget | null = null;
  let divergence: GLTarget | null = null;
  let temperature: GLDoubleTarget | null = null;
  let velocity0: GLTarget | null = null;
  let temperature0: GLTarget | null = null;

  let width = 0;
  let height = 0;
  let dpr = 1;
  let raf = 0;
  let running = false;
  let last = performance.now();

  // Obstacle: off by default (halfSizeGrid <= 0 disables every isSolid()
  // check above). fracX/fracY are DOM viewport fractions (0..1, y-down)
  // set via setObstacle(); converted to grid space (y-up, see file header)
  // fresh each frame so it stays correct across resizes.
  let obstacleEnabled = false;
  let obstacleFracX = 0.5;
  let obstacleFracY = 0.5;
  // 0 = square, 1 = circle, 2 = triangle — kept as a plain number so it can
  // be dropped straight into a uniform1f each frame (see obstacleUniforms).
  let obstacleShape = 0;

  const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

  function obstacleHalfSizeGrid() {
    if (!obstacleEnabled) return 0;
    return Math.max(3, Math.min(NX, NY) * 0.1);
  }

  function obstacleUniforms(u: Record<string, WebGLUniformLocation | null>) {
    const halfSize = obstacleHalfSizeGrid();
    const marginX = halfSize / Math.max(NX, 1);
    const marginY = halfSize / Math.max(NY, 1);
    const cx = clamp(obstacleFracX, marginX, 1 - marginX) * NX;
    // DOM y is down; grid y is up (see coordinate-convention note above).
    const cy = (1 - clamp(obstacleFracY, marginY, 1 - marginY)) * NY;
    gl!.uniform2f(u.uObstacleCenterGrid, cx, cy);
    gl!.uniform1f(u.uObstacleHalfSizeGrid, halfSize);
    gl!.uniform1f(u.uObstacleShape, obstacleShape);
  }

  function setObstacle(xFrac: number | null, yFrac: number | null) {
    if (xFrac == null || yFrac == null) {
      obstacleEnabled = false;
      return;
    }
    obstacleEnabled = true;
    obstacleFracX = clamp(xFrac, 0, 1);
    obstacleFracY = clamp(yFrac, 0, 1);
  }

  function setObstacleShape(shape: "square" | "circle" | "triangle") {
    obstacleShape = shape === "circle" ? 1 : shape === "triangle" ? 2 : 0;
  }

  function freeGrid() {
    deleteGLDoubleTarget(gl!, velocity);
    deleteGLDoubleTarget(gl!, pressure);
    deleteGLTarget(gl!, divergence);
    deleteGLDoubleTarget(gl!, temperature);
    deleteGLTarget(gl!, velocity0);
    deleteGLTarget(gl!, temperature0);
  }

  function allocateGrid(nx: number, ny: number) {
    freeGrid();
    NX = nx;
    NY = ny;
    velocity = createGLDoubleTarget(gl!, NX, NY, gl!.RG16F, gl!.RG);
    pressure = createGLDoubleTarget(gl!, NX, NY, gl!.R16F, gl!.RED);
    divergence = createGLTarget(gl!, NX, NY, gl!.R16F, gl!.RED);
    temperature = createGLDoubleTarget(gl!, NX, NY, gl!.R16F, gl!.RED);
    // Fixed "pre-diffusion" snapshots the implicit diffuse solve relaxes
    // toward each Jacobi iteration (see diffuseVelocity/diffuseTemperature).
    velocity0 = createGLTarget(gl!, NX, NY, gl!.RG16F, gl!.RG);
    temperature0 = createGLTarget(gl!, NX, NY, gl!.R16F, gl!.RED);
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
      obstacleUniforms(uniforms);
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
      obstacleUniforms(dUniforms);
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
      gl!.uniform1f(uniforms.uDamping, VELOCITY_DAMPING);
      obstacleUniforms(uniforms);
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
      obstacleUniforms(uniforms);
    });
    temperature.swap();
  }

  function diffuseVelocity(dt: number) {
    if (!velocity || !velocity0) return;
    // Snapshot the current field as the fixed RHS the Jacobi loop relaxes
    // toward (same role divergence plays for the pressure solve).
    runPass(copyProg!, velocity0, () => {
      bindTex(0, velocity!.read.texture);
      gl!.uniform1i(copyProg!.uniforms.uSrc, 0);
    });
    const alpha = VISCOSITY * dt;
    const invBeta = 1 / (1 + 4 * alpha);
    const { uniforms } = diffuseVelProg!;
    for (let i = 0; i < DIFFUSE_ITERATIONS; i++) {
      runPass(diffuseVelProg!, velocity.write, () => {
        bindTex(0, velocity!.read.texture);
        bindTex(1, velocity0!.texture);
        gl!.uniform1i(uniforms.uVel, 0);
        gl!.uniform1i(uniforms.uVel0, 1);
        gl!.uniform2f(uniforms.uTexel, 1 / NX, 1 / NY);
        gl!.uniform1f(uniforms.uAlpha, alpha);
        gl!.uniform1f(uniforms.uInvBeta, invBeta);
      });
      velocity.swap();
    }
  }

  function diffuseTemperature(dt: number) {
    if (!temperature || !temperature0) return;
    runPass(copyProg!, temperature0, () => {
      bindTex(0, temperature!.read.texture);
      gl!.uniform1i(copyProg!.uniforms.uSrc, 0);
    });
    const alpha = THERMAL_DIFFUSIVITY * dt;
    const invBeta = 1 / (1 + 4 * alpha);
    const { uniforms } = diffuseTempProg!;
    for (let i = 0; i < DIFFUSE_ITERATIONS; i++) {
      runPass(diffuseTempProg!, temperature.write, () => {
        bindTex(0, temperature!.read.texture);
        bindTex(1, temperature0!.texture);
        gl!.uniform1i(uniforms.uTemp, 0);
        gl!.uniform1i(uniforms.uTemp0, 1);
        gl!.uniform2f(uniforms.uTexel, 1 / NX, 1 / NY);
        gl!.uniform1f(uniforms.uAlpha, alpha);
        gl!.uniform1f(uniforms.uInvBeta, invBeta);
      });
      temperature.swap();
    }
  }

  function drawFrame() {
    if (!temperature || !velocity) return;
    gl!.clearColor(0, 0, 0, 0);
    gl!.bindFramebuffer(gl!.FRAMEBUFFER, null);
    gl!.viewport(0, 0, canvas.width, canvas.height);
    gl!.clear(gl!.COLOR_BUFFER_BIT);

    const { uniforms } = renderProg!;
    runPass(renderProg!, null, () => {
      bindTex(0, velocity!.read.texture);
      gl!.uniform1i(uniforms.uVel, 0);
      gl!.uniform2f(uniforms.uGridSize, NX, NY);
      obstacleUniforms(uniforms);
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
    // Diffuse (viscosity) right after advection, same spot Stam's vel_step
    // uses it — then re-enforce walls/floor before the final project(),
    // since the Jacobi relaxation above has no notion of boundaries and
    // will happily diffuse velocity into the floor/walls.
    diffuseVelocity(dt);
    applyBoundary();
    project();
    advectTemperature(dt);
    diffuseTemperature(dt);
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
    setObstacle,
    setObstacleShape,
    destroy() {
      stop();
      window.removeEventListener("resize", resize);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      freeGrid();
    },
  };
}