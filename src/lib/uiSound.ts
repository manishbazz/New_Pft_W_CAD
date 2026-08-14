"use client";

// Lightweight synthesized UI sounds (no audio files to host/load).
// A single shared AudioContext is created lazily on first user gesture,
// since browsers block audio until the page has been interacted with.

let ctx: AudioContext | null = null;
let noiseBuffer: AudioBuffer | null = null;

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

/** Call from within a real user gesture (click/tap/keydown) as early as
 * possible on the page, so hover sounds work right away afterward instead
 * of only unlocking on whichever element happens to be clicked first. */
export function unlockAudio() {
  getContext();
}

function getNoiseBuffer(audio: AudioContext): AudioBuffer {
  if (noiseBuffer) return noiseBuffer;
  const length = Math.floor(audio.sampleRate * 0.08);
  const buffer = audio.createBuffer(1, length, audio.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
  noiseBuffer = buffer;
  return buffer;
}

function noiseBurst(
  audio: AudioContext,
  startAt: number,
  durationMs: number,
  peakGain: number,
  filterFreq: number,
  filterType: BiquadFilterType = "bandpass",
) {
  const noise = audio.createBufferSource();
  noise.buffer = getNoiseBuffer(audio);
  const filter = audio.createBiquadFilter();
  filter.type = filterType;
  filter.frequency.value = filterFreq;
  filter.Q.value = 0.8;
  const gain = audio.createGain();
  const duration = durationMs / 1000;
  gain.gain.setValueAtTime(peakGain, startAt);
  gain.gain.exponentialRampToValueAtTime(0.0001, startAt + duration);
  noise.connect(filter).connect(gain).connect(audio.destination);
  noise.start(startAt);
  noise.stop(startAt + duration + 0.02);
}

function tone(
  audio: AudioContext,
  startAt: number,
  freqFrom: number,
  freqTo: number,
  durationMs: number,
  peakGain: number,
  type: OscillatorType,
) {
  const osc = audio.createOscillator();
  const gain = audio.createGain();
  osc.type = type;
  const duration = durationMs / 1000;
  osc.frequency.setValueAtTime(freqFrom, startAt);
  osc.frequency.exponentialRampToValueAtTime(
    Math.max(freqTo, 1),
    startAt + duration,
  );
  gain.gain.setValueAtTime(0, startAt);
  gain.gain.linearRampToValueAtTime(peakGain, startAt + 0.004);
  gain.gain.exponentialRampToValueAtTime(0.0001, startAt + duration);
  osc.connect(gain).connect(audio.destination);
  osc.start(startAt);
  osc.stop(startAt + duration + 0.02);
}

/** Dry, percussive cursor tick — arcade-fighting-game menu feel. */
export function playHoverTick() {
  const audio = getContext();
  if (!audio) return;
  const now = audio.currentTime;
  noiseBurst(audio, now, 18, 0.05, 3200, "highpass");
  tone(audio, now, 1400, 1100, 22, 0.03, "square");
}

/** Punchy select "stab": bright noise snap + a descending synth hit. */
export function playClickTick() {
  const audio = getContext();
  if (!audio) return;
  const now = audio.currentTime;
  noiseBurst(audio, now, 30, 0.07, 2400, "bandpass");
  tone(audio, now, 620, 190, 100, 0.08, "sawtooth");
  tone(audio, now, 140, 90, 90, 0.05, "sine"); // sub weight
}

/** Slow logo-landing sting: a soft bass swell rising into a gentle shimmer. */
export function playIntroChime() {
  const audio = getContext();
  if (!audio) return;
  const now = audio.currentTime;

  const swell = audio.createOscillator();
  const swellGain = audio.createGain();
  swell.type = "sine";
  swell.frequency.setValueAtTime(70, now);
  swell.frequency.exponentialRampToValueAtTime(52, now + 0.9);
  swellGain.gain.setValueAtTime(0, now);
  swellGain.gain.linearRampToValueAtTime(0.14, now + 0.5);
  swellGain.gain.exponentialRampToValueAtTime(0.0001, now + 1.15);
  swell.connect(swellGain).connect(audio.destination);
  swell.start(now);
  swell.stop(now + 1.2);

  const shimmer = audio.createOscillator();
  const shimmerGain = audio.createGain();
  shimmer.type = "triangle";
  shimmer.frequency.setValueAtTime(260, now + 0.5);
  shimmer.frequency.exponentialRampToValueAtTime(720, now + 1.15);
  shimmerGain.gain.setValueAtTime(0, now + 0.5);
  shimmerGain.gain.linearRampToValueAtTime(0.045, now + 0.75);
  shimmerGain.gain.exponentialRampToValueAtTime(0.0001, now + 1.35);
  shimmer.connect(shimmerGain).connect(audio.destination);
  shimmer.start(now + 0.5);
  shimmer.stop(now + 1.4);
}
