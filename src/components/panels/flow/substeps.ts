/**
 * Splits one display frame's worth of simulation time into equal substeps.
 *
 * Why not a fixed-dt accumulator: with a fixed dt the number of steps per
 * frame changes from frame to frame whenever the frame's sim time isn't a
 * whole multiple of dt. For the About sim at 60 Hz (35 time units/s,
 * dt 0.4) the pattern is 1,2,1,2,... steps per frame, so the flow on
 * screen advances 1x then 2x every other frame: a visible 30 Hz pulse.
 * At 120/144 Hz some frames advance 0 steps. Splitting each frame's time
 * into n equal steps (n = ceil(T / maxDt)) makes the on-screen advance
 * proportional to real elapsed time, so the motion is smooth at any
 * refresh rate, and dt never exceeds maxDt (same stability bound).
 *
 * A frame needing more than maxSteps steps (a hitch, a background tab)
 * runs maxSteps steps of maxDt and drops the rest, as before, so a slow
 * frame can't spiral.
 */
export function planSubsteps(
  frameSimTime: number,
  maxDt: number,
  maxSteps: number,
): { n: number; dt: number } {
  if (!(frameSimTime > 0)) return { n: 0, dt: 0 };
  const n = Math.min(maxSteps, Math.max(1, Math.ceil(frameSimTime / maxDt - 1e-9)));
  return { n, dt: Math.min(maxDt, frameSimTime / n) };
}

/**
 * Per-step fraction for exponential "follow the pointer" smoothing that is
 * independent of the step size: moving a fraction `perRefDt` of the
 * remaining distance every `refDt` time units, expressed for a step `dt`.
 */
export function followFraction(perRefDt: number, refDt: number, dt: number): number {
  return 1 - Math.pow(1 - perRefDt, dt / refDt);
}
