/** Main-thread speech planning: text/IPA → phrases → gestural plan → worklet. */
import type { BodyMix } from "../wasm/types.ts";
import { EnglishG2P, type Phrase } from "../wasm/engine.ts";
import { tokenizeIpa } from "../wasm/engine.ts";
import { parseBeat, planPhrases, planSong, type Plan, type Segment } from "../wasm/engine.ts";
import { songNotes } from "./song.ts";
import { playBacking, playParts, stopBacking, type ChordSpan } from "./backing.ts";
import type { PartNote, Song } from "./chatText.ts";
import { nearestBody } from "./body.ts";
import { engine } from "../audio/AudioEngine.ts";
import type { Gesture } from "../wasm/types.ts";
import { wordSpans, type WordSpan } from "./words.ts";

export const g2p = new EnglishG2P();

export interface SpokenPlan {
  plan: Plan;
  /** worklet-clock offset of the plan's time 0 (set when the worklet confirms) */
  offset: number | null;
  id: number;
  transcription: string;
  /** each word's span in the plan */
  words: WordSpan[];
}

let current: SpokenPlan | null = null;
const listeners = new Set<(p: SpokenPlan | null) => void>();
engine.onPlanned((m) => {
  if (current && m.id === current.id) {
    current = { ...current, offset: m.t0 };
    for (const l of listeners) l(current);
  }
});

export function onPlan(l: (p: SpokenPlan | null) => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function currentPlan(): SpokenPlan | null {
  return current;
}

export function ipaToPhrases(text: string): Phrase[] {
  return text
    .split(/[|.?!]+/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => ({ segments: tokenizeIpa(p), intonation: "statement" as const, pause: 0.3, words: [] }));
}

export function transcribe(phrases: { segments: Segment[]; intonation?: string }[]): string {
  return phrases.map((p) => p.segments.map((s) => (s.stress === 1 ? "ˈ" : s.stress === 2 ? "ˌ" : "") + s.ipa + (s.wordEnd ? " " : "")).join("").trim() + (p.intonation === "question" ? "?" : "")).join(" | ");
}

export function speakPhrases(phrases: { segments: Segment[]; intonation?: "statement" | "question" | "flat"; pause?: number; words?: string[] }[], o: { body: BodyMix; rate: number; f0: number }): SpokenPlan {
  const plan = planPhrases(phrases, { body: o.body, t0: 0, rate: o.rate, f0: o.f0 });
  return playPlan(plan, wordSpans(phrases, plan), transcribe(phrases));
}

/** Send a plan to the worklet as the current utterance (spoken or sung): the face and the chat follow it. */
function playPlan(plan: Plan, words: WordSpan[], transcription: string): SpokenPlan {
  stopBacking();
  const id = engine.schedule({ gestures: plan.gestures.map((g: Gesture) => ({ ...g, targets: { ...g.targets } })), segments: plan.segments, end: plan.end });
  current = { plan, offset: null, id, transcription, words };
  for (const l of listeners) l(current);
  return current;
}

/** a song's notes as one sung plan: each run of notes between rests its own phrase; null if it has none */
function sungPlan(song: Song, body: BodyMix, shift: number): { plan: Plan; words: WordSpan[]; lineAt: number[]; end: number } | null {
  const notes = songNotes(song, shift);
  if (!notes.length) return null;
  const beat = 60 / song.bpm;
  const plans: Plan[] = [];
  const words: WordSpan[] = [];
  let t = T0, run: typeof notes = [], runT0 = t;
  const flush = () => {
    if (run.length) plans.push(planSong(run, { body, bpm: song.bpm, t0: runT0, vibrato: 22 }));
    run = [];
  };
  const lineAt: number[] = []; // each line's start (s), its leading rest included
  for (const n of notes) {
    lineAt[n.line] ??= t;
    if (n.rest > 0) {
      flush();
      t += n.rest * beat;
    }
    if (!run.length) runT0 = t;
    run.push(n);
    words.push({ text: n.syl.text, t0: t, t1: t + n.beats * beat });
    t += n.beats * beat;
  }
  flush();
  return { plan: { gestures: plans.flatMap((p) => p.gestures), segments: plans.flatMap((p) => p.segments), end: Math.max(...plans.map((p) => p.end)) }, words, lineAt, end: t };
}

/** a sung part's notes as the band's "ooh" (beats from the song's first note) */
function partNotes(song: Song): PartNote[] {
  let t = 0;
  return song.lines.flatMap((l) =>
    l.notes.flatMap((n) => {
      const at = t;
      t += n.beats;
      return n.midi === null ? [] : [{ midi: n.midi, t: at, beats: n.beats, vocal: true }];
    }),
  );
}

/** the beatboxer's groove (a cappella), by beats in the bar: kick, hat, snare, a sixteenth a step */
const GROOVES: Record<number, string> = {
  2: "B . t . | Pf . t .",
  3: "B . t . | Pf . t . | Pf . t .",
  4: "B . t . | Pf . t . | B . t . | Pf . t .",
};
/** the groove for a song's bar, turned so its first step is where the song starts in its bar */
function groove(meter: Song["meter"]): (import("../wasm/types.ts").BeatStep | null)[] {
  const beats = meter?.beats ?? 4;
  const steps = parseBeat(GROOVES[beats === 1.5 || beats === 3 ? 3 : beats === 2 ? 2 : 4]);
  const k = Math.round(((meter?.at ?? 0) % (steps.length / 4)) * 4) % steps.length;
  return [...steps.slice(k), ...steps.slice(0, k)];
}

/** the song's first note, in plan time (s) */
const T0 = 0.35;

/** a found song's other sung parts, singing with the current plan: their names and words (for their faces) */
export interface ChoirPart {
  name: string;
  words: WordSpan[];
}
let choir: { planId: number; parts: ChoirPart[] } | null = null;
/** the parts singing with the current plan, or null */
export function currentChoir(): ChoirPart[] | null {
  return choir && current && choir.planId === current.id ? choir.parts : null;
}

/**
 * Sing a chat song; each syllable is a "word" (for the reveal and the mouth). Male sings an octave
 * down. A found song's other sung parts are sung with it by voices of their own, at their own pitch
 * (a high part by a female voice, a low one by a male), and its other parts played under them.
 */
export async function singSong(song: Song, body: BodyMix): Promise<SpokenPlan | null> {
  try {
    await g2p.load();
  } catch {
    // the letter-to-sound rules still work
  }
  const lead = sungPlan(song, body, nearestBody(body) === "male" ? -12 : 0);
  if (!lead) return null;
  const { plan, words, lineAt, end } = lead;
  const beat = 60 / song.bpm;
  const ends = song.lines.map((_, i) => lineAt.slice(i + 1).find((x) => x !== undefined) ?? end);
  const chords = song.lines.flatMap((l, i): ChordSpan[] => {
    if (lineAt[i] === undefined || !l.chords.length) return [];
    const span = (ends[i] - lineAt[i]) / l.chords.length;
    return l.chords.map((tones, k) => ({ tones, t0: lineAt[i] - T0 + k * span, t1: lineAt[i] - T0 + (k + 1) * span }));
  });
  if (chords.length) chords[chords.length - 1].t1 += beat; // the last chord rings past the last note
  // as many other singers as the audio thread has room for (each costs about what the lead does);
  // the rest are heard as "ooh"s in the band
  const room = Math.max(0, Math.floor(0.85 / Math.max(engine.load, 0.1)) - 1);
  // a beatboxer (a cappella) takes the place after the bass: the groove before the inner lines
  const all = song.voices ?? [];
  const beatAt = song.beatbox ? Math.min(all.length, all.findIndex((v) => v.name === "Bass") + 1 || all.length) : -1;
  const beatSung = beatAt >= 0 && beatAt < room;
  const sung = all.slice(0, beatSung ? room - 1 : room), hummed = all.slice(beatSung ? room - 1 : room);
  const parts = [...(song.parts ?? []), ...hummed.flatMap((v) => partNotes(v.song))].sort((a, b) => a.t - b.t);
  const voices = sung.flatMap((v) => {
    const pitches = v.song.lines.flatMap((l) => l.notes.flatMap((n) => (n.midi === null ? [] : [n.midi]))).sort((a, b) => a - b);
    const vbody: BodyMix = { female: pitches[pitches.length >> 1] >= 57 ? 1 : 0, child: 0 };
    const p = sungPlan(v.song, vbody, 0);
    return p ? [{ name: v.name, body: vbody, ...p }] : [];
  });
  const sp = playPlan(plan, words.filter((w) => w.text !== "~"), song.lines.map((l) => l.lyrics).join(" | "));
  // the worklets time their plans from when they get them: the other singers and the band start
  // on the same instant (sent in this same task)
  const choirParts: ChoirPart[] = voices.map((v) => ({ name: v.name, words: v.words.filter((w) => w.text !== "~") }));
  const nodes: Parameters<typeof engine.singChoir>[0] = voices.map((v) => ({ plan: v.plan, body: v.body }));
  if (beatSung) {
    const at = Math.min(beatAt, nodes.length);
    const steps = groove(song.meter);
    const step = beat / 4; // sixteenths
    // its "words": the sound on each step, for its face's caption
    const hits: WordSpan[] = [];
    for (let k = 0; T0 + k * step < end; k++) {
      const s = steps[k % steps.length];
      if (s) hits.push({ text: s.id, t0: T0 + k * step, t1: T0 + (k + 1) * step });
    }
    nodes.splice(at, 0, { beat: steps, bpm: song.bpm, start: T0, stop: end + beat, body: { female: 0, child: 0 } });
    choirParts.splice(at, 0, { name: "Beatbox", words: hits });
  }
  engine.singChoir(nodes);
  choir = choirParts.length ? { planId: sp.id, parts: choirParts } : null;
  // a found song plays its own other parts; else the band strums the chords
  if (engine.ctx) {
    if (parts.length) playParts(parts, engine.ctx.currentTime + T0, beat);
    else playBacking(chords, engine.ctx.currentTime + T0, beat); // chord times count from the first note
  }
  return sp;
}

export async function speakText(text: string, o: { ipa: boolean; body: BodyMix; rate: number; f0: number }): Promise<SpokenPlan | null> {
  if (!text.trim()) return null;
  let phrases: Phrase[];
  if (o.ipa) phrases = ipaToPhrases(text);
  else {
    try {
      await g2p.load();
    } catch {
      // dictionary unavailable: the letter-to-sound rules still work
    }
    phrases = g2p.toPhrases(text);
  }
  if (!phrases.length) return null;
  return speakPhrases(phrases, o);
}

export function stopSpeaking(): void {
  engine.stopSpeech();
  engine.stopChoir();
  choir = null;
  stopBacking();
}

/** Plan time now (s), or -1 before the worklet has placed it. */
export function planNow(sp: SpokenPlan | null): number {
  const tele = engine.latest;
  return sp && sp.offset !== null && tele ? tele.t.clock - sp.offset : -1;
}
