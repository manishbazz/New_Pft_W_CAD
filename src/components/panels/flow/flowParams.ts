/**
 * Shared physical/numerical parameters for the About-page cylinder-wake
 * simulation. Both backends (GPU: createGpuFlowSim.ts, CPU:
 * createCpuFlowSim.ts) read these, so they solve the same problem.
 *
 * Units are grid units: dx = 1 cell, free-stream speed U = 1 cell per time
 * unit. The Reynolds number is therefore set explicitly through the
 * kinematic viscosity, nu = U * D / Re, instead of being whatever the
 * numerical diffusion of the advection scheme happens to give.
 *
 * Parameters were chosen with an offline NumPy replica of this exact
 * pipeline (cell-centred grid, bilinear clamp-to-edge sampling like WebGL,
 * MacCormack advection, red-black SOR with an outlet p = 0). Results on a
 * 200 x 72 grid, D = 12 cells:
 *   - MacCormack, Re 150:   Strouhal 0.192, same with 30 or 80 SOR passes
 *     (so the shedding is physical, not an artefact of an unconverged
 *     pressure solve).
 *   - plain semi-Lagrangian, Re 150: Strouhal 0.144 — the first-order
 *     scheme's numerical viscosity drags the effective Re down a lot.
 *   - Experiment (Williamson 1996, unconfined) at Re 150: St ~ 0.18; the
 *     17 % blockage here raises it slightly, so ~0.19 is the right answer.
 */
export const FLOW_NY = 72;
export const FLOW_MIN_NX = 120;
export const FLOW_MAX_NX = 260;

/** Cylinder diameter in cells. 12 / 72 rows = 17 % blockage. */
export const FLOW_DIAMETER = 12;
export const FLOW_U_INF = 1.0;
export const FLOW_RE = 150;
export const FLOW_NU = (FLOW_U_INF * FLOW_DIAMETER) / FLOW_RE;

/** Pressure solve: red-black SOR, passes counted one colour per pass. */
export const FLOW_SOR_PASSES = 30;
export const FLOW_SOR_OMEGA = 1.8;

/** Simulation time units advanced per real second, and max substep. */
export const FLOW_TIME_SCALE = 35;
export const FLOW_MAX_SUBSTEP_DT = 0.4;
/** Fixed-step accumulator cap, so a slow frame can't spiral. */
export const FLOW_MAX_STEPS_PER_FRAME = 4;

/** Dye stripes injected at the inlet. */
export const FLOW_STRIPE_SPACING = 3;
export const FLOW_STRIPE_WIDTH = 2;
export const FLOW_SMOKE_BAND_MARGIN = 4;

/** Wake probe for the live Strouhal readout (in cylinder diameters). */
export const FLOW_PROBE_DX = 2.5;
export const FLOW_PROBE_DY = 0.6;

/** Default cylinder position (fraction of the domain). */
export const FLOW_BODY_X = 0.28;
export const FLOW_BODY_Y = 0.5;

export type FlowStats = {
  re: number;
  /** Measured Strouhal number, null until enough periods are seen. */
  st: number | null;
};

/**
 * Measures the shedding frequency from the transverse velocity at a wake
 * probe: counts upward zero crossings (with hysteresis) and averages the
 * last few periods. Strouhal = f * D / U.
 */
export function createStrouhalMeter() {
  let prev = 0;
  let prevTime = 0;
  let armed = false;
  const crossings: number[] = [];
  let st: number | null = null;
  return {
    reset() {
      crossings.length = 0;
      st = null;
      armed = false;
      prev = 0;
    },
    push(simTime: number, v: number) {
      const hyst = 0.02;
      if (v < -hyst) armed = true;
      if (armed && prev <= 0 && v > 0) {
        // Linear interpolation of the crossing time between samples, so the
        // probe can be read only every few frames without losing accuracy.
        const tc = prevTime + ((simTime - prevTime) * -prev) / (v - prev);
        crossings.push(tc);
        armed = false;
        if (crossings.length > 6) crossings.shift();
        if (crossings.length >= 3) {
          const n = crossings.length - 1;
          const period = (crossings[n] - crossings[0]) / n;
          st = period > 0 ? FLOW_DIAMETER / (period * FLOW_U_INF) : null;
        }
      }
      prev = v;
      prevTime = simTime;
    },
    value: () => st,
  };
}
