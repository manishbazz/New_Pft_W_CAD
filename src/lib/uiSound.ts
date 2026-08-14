"use client";

// Lightweight synthesized UI sounds (no audio files to host/load).
// A single shared AudioContext is created lazily on first user gesture,
// since browsers block audio until the page has been interacted with.

let ctx: AudioContext | null = null;

function getContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const AudioCtx =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  if (!AudioCtx) return null;
  if (!ctx) ctx = new AudioCtx();
  if (ctx.state === "suspended") void ctx.resume();
  return ctx;
}

function tone(
  frequency: number,
  durationMs: number,
  peakGain: number,
  type: OscillatorType = "sine",
) {
  const audio = getContext();
  if (!audio) return;

  const osc = audio.createOscillator();
  const gain = audio.createGain();
  osc.type = type;
  osc.frequency.value = frequency;

  const now = audio.currentTime;
  const duration = durationMs / 1000;

  gain.gain.setValueAtTime(0, now);
  gain.gain.linearRampToValueAtTime(peakGain, now + 0.005);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);

  osc.connect(gain).connect(audio.destination);
  osc.start(now);
  osc.stop(now + duration + 0.02);
}

/** Soft, quiet tick for hover — fires often, must stay unobtrusive. */
export function playHoverTick() {
  tone(1200, 35, 0.03);
}

/** Slightly fuller click confirmation — fires rarely, can be a touch louder. */
export function playClickTick() {
  tone(420, 70, 0.06, "triangle");
}
