/** Main-thread speech planning: text/IPA → phrases → gestural plan → worklet. */
import type { BodyMix } from "../wasm/types.ts";
import { EnglishG2P, type Phrase } from "../wasm/engine.ts";
import { tokenizeIpa } from "../wasm/engine.ts";
import { planPhrases, planSong, type Plan, type Segment } from "../wasm/engine.ts";
import { songNotes } from "./song.ts";
import type { Song } from "./chatText.ts";
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
  const id = engine.schedule({ gestures: plan.gestures.map((g: Gesture) => ({ ...g, targets: { ...g.targets } })), segments: plan.segments, end: plan.end });
  current = { plan, offset: null, id, transcription, words };
  for (const l of listeners) l(current);
  return current;
}

/** Sing a chat song; each syllable is a "word" (for the reveal and the mouth). Male sings an octave down. */
export async function singSong(song: Song, body: BodyMix): Promise<SpokenPlan | null> {
  try {
    await g2p.load();
  } catch {
    // the letter-to-sound rules still work
  }
  const notes = songNotes(song, nearestBody(body) === "male" ? -12 : 0);
  if (!notes.length) return null;
  const t0 = 0.35, beat = 60 / song.bpm;
  const plan = planSong(notes, { body, bpm: song.bpm, t0, vibrato: 35 });
  let t = t0;
  const words = notes.map((n): WordSpan => {
    const w = { text: n.syl.text, t0: t, t1: t + n.beats * beat };
    t = w.t1;
    return w;
  });
  return playPlan(plan, words.filter((w) => w.text !== "~"), song.lines.map((l) => l.lyrics).join(" | "));
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
}

/** Plan time now (s), or -1 before the worklet has placed it. */
export function planNow(sp: SpokenPlan | null): number {
  const tele = engine.latest;
  return sp && sp.offset !== null && tele ? tele.t.clock - sp.offset : -1;
}
