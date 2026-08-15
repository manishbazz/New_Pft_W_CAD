declare module "zzfx" {
  /** Plays a ZzFX sound from up to 20 parameters. Returns the created node. */
  export function zzfx(...parameters: number[]): AudioBufferSourceNode;

  export const ZZFX: {
    audioContext: AudioContext;
    volume: number;
    x: AudioContext;
    play: (...parameters: number[]) => AudioBufferSourceNode;
    buildSamples: (...parameters: number[]) => number[];
    getNote: (semitoneOffset: number, rootNoteFrequency?: number) => number;
    letterNotes: Record<string, number>;
  };
}
