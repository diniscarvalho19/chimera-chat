/**
 * A song's backing band, synthesized live in the voice's AudioContext: strummed chords, a root
 * bass and a kick + hi-hat, under the voice. Everything is scheduled up front on the context's
 * clock (cheap: a few hundred short oscillators), so nothing is prepared before the song starts.
 */
import { engine } from "../audio/AudioEngine.ts";
import type { PartNote } from "./chatText.ts";

/** one chord over [t0, t1) seconds of the song */
export interface ChordSpan {
  tones: number[];
  t0: number;
  t1: number;
}

// ponytail: fixed levels and one strum pattern, tuned by ear; per-style patterns if songs ask for them
const LEVEL = 0.5; // about 3 dB over the first 0.35, which sat too far under the voice

let bus: GainNode | null = null;
let noise: AudioBuffer | null = null;

export function stopBacking(): void {
  if (!bus || !engine.ctx) return;
  const b = bus;
  bus = null;
  b.gain.setTargetAtTime(0, engine.ctx.currentTime, 0.03);
  setTimeout(() => b.disconnect(), 300);
}

const hz = (midi: number) => 440 * 2 ** ((midi - 69) / 12);
/** the pitch class's note in [lo, lo + 12) */
const inRange = (pc: number, lo: number) => lo + ((pc - lo) % 12 + 12) % 12;

/** Play the chords; `start` is the song's time 0 on the context clock, `beat` seconds. */
export function playBacking(chords: ChordSpan[], start: number, beat: number): void {
  stopBacking();
  const ctx = engine.ctx;
  if (!ctx || !engine.master || !chords.length) return;
  const out = ctx.createGain();
  out.gain.value = LEVEL;
  out.connect(engine.master);
  bus = out;
  if (!noise) {
    noise = ctx.createBuffer(1, ctx.sampleRate * 0.2, ctx.sampleRate);
    const d = noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }

  const tone = (type: OscillatorType, f: number, t: number, len: number, peak: number, cutoff: number) => {
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.value = f;
    const lp = ctx.createBiquadFilter();
    lp.frequency.value = cutoff;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0005, t + len);
    o.connect(lp).connect(g).connect(out);
    o.start(t);
    o.stop(t + len + 0.02);
  };
  const kick = (t: number) => {
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(120, t);
    o.frequency.exponentialRampToValueAtTime(42, t + 0.12);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.9, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
    o.connect(g).connect(out);
    o.start(t);
    o.stop(t + 0.32);
  };
  const hat = (t: number, peak: number) => {
    const s = ctx.createBufferSource();
    s.buffer = noise;
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 7000;
    const g = ctx.createGain();
    g.gain.setValueAtTime(peak, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
    s.connect(hp).connect(g).connect(out);
    s.start(t);
    s.stop(t + 0.06);
  };

  const now = ctx.currentTime;
  for (const c of chords) {
    const voicing = c.tones.map((pc) => inRange(pc, 52)).sort((a, b) => a - b); // around E3..D#4
    const bass = inRange(c.tones[0], 36);
    // on the eighth-note grid of the whole song, so the band keeps one pulse across chords
    for (let k = Math.ceil(c.t0 / (beat / 2) - 1e-6); k * (beat / 2) < c.t1 - 1e-6; k++) {
      const t = start + k * (beat / 2);
      if (t < now) continue;
      const onBeat = k % 2 === 0;
      const b = Math.floor(k / 2);
      // strum: down on the beat (low to high), a lighter up-strum on the "and"
      const order = onBeat ? voicing : [...voicing].reverse();
      order.forEach((m, i) => tone("sawtooth", hz(m), t + i * 0.012, beat * 0.9, (onBeat ? 0.09 : 0.05) * (b % 2 ? 1.15 : 1), 1600));
      if (onBeat) {
        tone("triangle", hz(bass), t, beat * 0.85, 0.35, 900);
        if (b % 2 === 0) kick(t);
      }
      hat(t, onBeat ? 0.12 : 0.07);
    }
  }
}

/**
 * Play a found song's own accompaniment (its other parts) under the voice; `start` is the song's
 * time 0 on the context clock, `beat` seconds. Each note's level falls with how many sound at once,
 * so a full piano part sits as low as a single line.
 */
// ponytail: one pluck and one "ooh" for every instrument; per-instrument timbres if songs need them
export function playParts(notes: PartNote[], start: number, beat: number): void {
  stopBacking();
  const ctx = engine.ctx;
  if (!ctx || !engine.master || !notes.length) return;
  const out = ctx.createGain();
  out.gain.value = LEVEL;
  out.connect(engine.master);
  bus = out;
  const now = ctx.currentTime;
  // how many notes sound at each note's start (the busiest moments set the level)
  const dense = notes.map((n) => notes.filter((m) => m.t <= n.t + 1e-6 && m.t + m.beats > n.t + 1e-6).length);
  notes.forEach((n, i) => {
    const t = start + n.t * beat, len = Math.max(0.08, n.beats * beat);
    if (t < now) return;
    const peak = 0.5 / Math.sqrt(Math.max(1, dense[i]));
    const g = ctx.createGain();
    const lp = ctx.createBiquadFilter();
    g.connect(out);
    lp.connect(g);
    const oscs = (n.vocal ? ["sine", "triangle"] : ["triangle", "sawtooth"]).map((type, k) => {
      const o = ctx.createOscillator();
      o.type = type as OscillatorType;
      o.frequency.value = hz(n.midi);
      o.detune.value = k ? 6 : -6;
      const og = ctx.createGain();
      og.gain.value = k ? 0.35 : 1;
      o.connect(og).connect(lp);
      return o;
    });
    g.gain.setValueAtTime(0, t);
    if (n.vocal) {
      // a slow swell, held, and let go
      lp.frequency.value = 1400;
      g.gain.linearRampToValueAtTime(peak * 0.7, t + Math.min(0.12, len / 2));
      g.gain.setValueAtTime(peak * 0.7, t + len * 0.85);
      g.gain.linearRampToValueAtTime(0, t + len + 0.08);
    } else {
      // struck, and dying away (brighter at first)
      lp.frequency.setValueAtTime(3200, t);
      lp.frequency.exponentialRampToValueAtTime(700, t + Math.min(len, 1.5));
      g.gain.linearRampToValueAtTime(peak, t + 0.005);
      g.gain.exponentialRampToValueAtTime(peak * 0.25, t + Math.min(len, 0.6));
      g.gain.exponentialRampToValueAtTime(0.0005, t + len + 0.12);
    }
    for (const o of oscs) {
      o.start(t);
      o.stop(t + len + 0.2);
    }
  });
}
