// Perch's sounds: short tones synthesized with Web Audio. No audio files; every sound is original.
type Note = [freq: number, at: number, dur: number];
type Sound = { notes: Note[]; wave?: OscillatorType; gain?: number };

const SOUNDS = {
  open: { notes: [[660, 0, 0.08], [990, 0.05, 0.12]] },
  close: { notes: [[880, 0, 0.07], [587, 0.05, 0.12]], gain: 0.7 },
  approval: { notes: [[784, 0, 0.12], [1046, 0.12, 0.2]], wave: "triangle" },
  question: { notes: [[659, 0, 0.09], [880, 0.09, 0.09], [1175, 0.18, 0.16]], wave: "triangle" },
  allow: { notes: [[880, 0, 0.06], [1320, 0.05, 0.12]] },
  deny: { notes: [[440, 0, 0.08], [330, 0.07, 0.14]], wave: "triangle" },
  finish: { notes: [[523, 0, 0.09], [659, 0.08, 0.09], [784, 0.16, 0.09], [1046, 0.24, 0.24]] },
  error: { notes: [[311, 0, 0.14], [233, 0.12, 0.24]], wave: "triangle" },
  poke: { notes: [[520, 0, 0.05], [390, 0.04, 0.08]] },
  dizzy: { notes: [[700, 0, 0.1], [620, 0.08, 0.1], [700, 0.16, 0.1], [560, 0.24, 0.1], [480, 0.32, 0.18]], wave: "triangle" },
  peek: { notes: [[988, 0, 0.06], [1318, 0.06, 0.1]], gain: 0.6 },
} satisfies Record<string, Sound>;
export type SoundName = keyof typeof SOUNDS;

let ctx: AudioContext | null = null;
let enabled = true;
let volume = 0.5;

export function configureSound(o: { sound: boolean; volume: number }) {
  enabled = o.sound;
  volume = o.volume;
}

export function play(name: SoundName) {
  if (!enabled || volume <= 0) return;
  try {
    ctx ??= new AudioContext();
    if (ctx.state === "suspended") void ctx.resume();
    const s: Sound = SOUNDS[name];
    const t0 = ctx.currentTime + 0.01;
    const peak = 0.12 * volume * (s.gain ?? 1);
    for (const [freq, at, dur] of s.notes) {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = s.wave ?? "sine";
      osc.frequency.value = freq;
      g.gain.setValueAtTime(0, t0 + at);
      g.gain.linearRampToValueAtTime(peak, t0 + at + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + at + dur);
      osc.connect(g).connect(ctx.destination);
      osc.start(t0 + at);
      osc.stop(t0 + at + dur + 0.02);
    }
  } catch {
    // no audio device: stay silent
  }
}
