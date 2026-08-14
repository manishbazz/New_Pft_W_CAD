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
  type: OscillatorType,
  startAt = 0,
) {
  const audio = getContext();
  if (!audio) return;

  const osc = audio.createOscillator();
  const gain = audio.createGain();
  osc.type = type;
  osc.frequency.value = frequency;

  const now = audio.currentTime + startAt;
  const duration = durationMs / 1000;

  gain.gain.setValueAtTime(0, now);
  gain.gain.linearRampToValueAtTime(peakGain, now + 0.004);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);

  osc.connect(gain).connect(audio.destination);
  osc.start(now);
  osc.stop(now + duration + 0.02);
}

/** Crisp chiptune cursor blip — square wave, short and punchy. */
export function playHoverTick() {
  tone(1046, 30, 0.025, "square"); // C6
}

/** Two-note ascending "confirm" chime, classic JRPG menu-select feel. */
export function playClickTick() {
  tone(784, 55, 0.05, "square"); // G5
  tone(1175, 90, 0.05, "square", 0.045); // D6, slightly overlapping
}

/** Bold logo-impact sting for the home page intro: a bass thump under a rising sweep. */
export function playIntroChime() {
  const audio = getContext();
  if (!audio) return;
  const now = audio.currentTime;

  // Low thump — the "hit".
  const thump = audio.createOscillator();
  const thumpGain = audio.createGain();
  thump.type = "sine";
  thump.frequency.setValueAtTime(150, now);
  thump.frequency.exponentialRampToValueAtTime(45, now + 0.22);
  thumpGain.gain.setValueAtTime(0, now);
  thumpGain.gain.linearRampToValueAtTime(0.22, now + 0.01);
  thumpGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.32);
  thump.connect(thumpGain).connect(audio.destination);
  thump.start(now);
  thump.stop(now + 0.35);

  // Rising sweep — the "shimmer" landing just after the hit.
  const sweep = audio.createOscillator();
  const sweepGain = audio.createGain();
  sweep.type = "sawtooth";
  sweep.frequency.setValueAtTime(320, now + 0.03);
  sweep.frequency.exponentialRampToValueAtTime(1100, now + 0.28);
  sweepGain.gain.setValueAtTime(0, now + 0.03);
  sweepGain.gain.linearRampToValueAtTime(0.05, now + 0.06);
  sweepGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.36);
  sweep.connect(sweepGain).connect(audio.destination);
  sweep.start(now + 0.03);
  sweep.stop(now + 0.4);
}
