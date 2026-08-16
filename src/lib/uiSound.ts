"use client";

// UI sound effects, powered by ZzFX (https://github.com/KilledByAPixel/ZzFX,
// MIT licensed) — a tiny procedural retro-sound synth. Every sound here is
// generated from parameters at runtime, not sourced from any game's audio.
//
// Loaded lazily/dynamically (not imported at module top-level): ZzFX creates
// its shared AudioContext as soon as its module is evaluated, which would
// throw during Next.js's server-side prerender (no AudioContext in Node).

type ZzfxModule = typeof import("zzfx");

let modulePromise: Promise<ZzfxModule> | null = null;

function loadZzfx(): Promise<ZzfxModule> | null {
  if (typeof window === "undefined") return null;
  if (!modulePromise) modulePromise = import("zzfx");
  return modulePromise;
}

/** Call from within a real user gesture (click/tap/keydown) as early as
 * possible on the page, so hover sounds work right away afterward instead
 * of only unlocking on whichever element happens to be clicked first.
 * ZzFX never resumes its own AudioContext, so this does it explicitly. */
export function unlockAudio() {
  loadZzfx()?.then(({ ZZFX }) => {
    if (ZZFX.audioContext.state === "suspended") {
      void ZZFX.audioContext.resume();
    }
  });
}

/** Dry, percussive cursor tick — short retro blip. */
export function playHoverTick() {
  loadZzfx()?.then(({ zzfx }) => {
    // volume, randomness, frequency, attack, sustain, release, shape(triangle)
    zzfx(0.5, 0, 1300, 0, 0.006, 0.03, 1, 1.2, 0, 0, 0, 0, 0, 0.02);
  });
}

/** Punchy select "stab": descending sawtooth hit with a bit of grit. */
export function playClickTick() {
  loadZzfx()?.then(({ zzfx }) => {
    // volume, randomness, freq, attack, sustain, release, shape(saw),
    // shapeCurve, slide(descending), ..., noise, ..., sustainVolume, decay
    zzfx(0.44, 0.05, 340, 0, 0.02, 0.13, 2, 1.1, -28, 0, 0, 0, 0, 0.08, 0, 0, 0, 0.8, 0.05);
  });
}

/** Slow logo-landing sting: soft bass swell rising into a gentle shimmer. */
export function playIntroChime() {
  loadZzfx()?.then(({ zzfx }) => {
    // Bass swell — low sine, long attack/sustain/release.
    zzfx(1.1, 0, 62, 0.15, 0.5, 0.55, 0, 1, 0, -2, 0, 0, 0, 0, 0, 0, 0, 0.9, 0.25);
    // Shimmer, arriving a beat later.
    window.setTimeout(() => {
      zzfx(0.56, 0, 260, 0.05, 0.3, 0.55, 1, 1, 55, 0, 0, 0, 0, 0, 0, 0, 0, 0.7, 0.1);
    }, 480);
  });
}

/** Very short, quiet blip for text unscrambling — fires per-character, must stay light. */
export function playScrambleTick() {
  loadZzfx()?.then(({ zzfx }) => {
    const freq = 900 + Math.random() * 500;
    zzfx(0.28, 0, freq, 0, 0.004, 0.012, 1, 1, 0, 0, 0, 0, 0, 0);
  });
}
