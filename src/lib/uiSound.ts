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

function getNoiseBuffer(audio: AudioContext): AudioBuffer {
  if (noiseBuffer) return noiseBuffer;
  const length = Math.floor(audio.sampleRate * 0.05);
  const buffer = audio.createBuffer(1, length, audio.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
  noiseBuffer = buffer;
  return buffer;
}

/** Soft pitch-bent tick, quiet enough for frequent hover firing. */
export function playHoverTick() {
  const audio = getContext();
  if (!audio) return;

  const osc = audio.createOscillator();
  const gain = audio.createGain();
  osc.type = "sine";

  const now = audio.currentTime;
  osc.frequency.setValueAtTime(1500, now);
  osc.frequency.exponentialRampToValueAtTime(1050, now + 0.05);

  gain.gain.setValueAtTime(0, now);
  gain.gain.linearRampToValueAtTime(0.025, now + 0.004);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.055);

  osc.connect(gain).connect(audio.destination);
  osc.start(now);
  osc.stop(now + 0.07);
}

/** Fuller click: a short filtered noise transient layered with a warm low tone. */
export function playClickTick() {
  const audio = getContext();
  if (!audio) return;
  const now = audio.currentTime;

  // Transient "snap" — filtered noise burst.
  const noise = audio.createBufferSource();
  noise.buffer = getNoiseBuffer(audio);
  const noiseFilter = audio.createBiquadFilter();
  noiseFilter.type = "bandpass";
  noiseFilter.frequency.value = 2200;
  noiseFilter.Q.value = 0.7;
  const noiseGain = audio.createGain();
  noiseGain.gain.setValueAtTime(0.05, now);
  noiseGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.02);
  noise.connect(noiseFilter).connect(noiseGain).connect(audio.destination);
  noise.start(now);
  noise.stop(now + 0.03);

  // Body "thock" — low triangle tone giving it warmth.
  const osc = audio.createOscillator();
  osc.type = "triangle";
  osc.frequency.setValueAtTime(220, now);
  osc.frequency.exponentialRampToValueAtTime(140, now + 0.09);
  const oscGain = audio.createGain();
  oscGain.gain.setValueAtTime(0, now);
  oscGain.gain.linearRampToValueAtTime(0.05, now + 0.006);
  oscGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.1);
  osc.connect(oscGain).connect(audio.destination);
  osc.start(now);
  osc.stop(now + 0.12);
}
