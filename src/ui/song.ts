/** A chat song → the notes the engine sings: each line's syllables paired with its notes. */
import { lyricsToSyllables, lyricsToSyllablesPt } from "../wasm/engine.ts";
import { italianSyllables } from "./italian.ts";
import type { SungNote, Syllable } from "../wasm/types.ts";

/** a sung note, and the beats of silence before it (a rest: R in the song) */
export type RestedNote = SungNote & { rest: number; line: number };
import type { Song } from "./chatText.ts";

/**
 * A syllable's length when the model gave the line no rhythm of its own: stressed syllables long,
 * unstressed short, the line's last held (beats).
 */
// ponytail: a fixed stress → length table; a real rhythm model (meter, phrase shape) if it sounds mechanical
export function sungBeats(s: Syllable, last: boolean): number {
  if (last) return 2;
  if (s.melisma) return 0.5;
  const stress = s.nucleus.stress ?? 0;
  return stress === 1 ? 1 : stress === 2 ? 0.75 : 0.5;
}

/**
 * One note per syllable, line by line. A line with too many notes drops the extra ones; too few,
 * and the melody walks back and forth through the line's notes (a miscount still sings a tune,
 * not one held pitch). A line whose notes are all one length (a
 * small model often writes no rhythm) gets the stress rhythm instead. Each line ends a phrase.
 * Rests take no syllable: their beats go before the next sung note.
 */
/** lyrics → sung syllables in a song's language */
export const syllablesFor = (lang: Song["lang"]): ((text: string) => Syllable[]) =>
  lang === "it" ? italianSyllables : lang === "pt" ? lyricsToSyllablesPt : lyricsToSyllables;

export function songNotes(song: Song, shift: number): RestedNote[] {
  const syllables = syllablesFor(song.lang);
  let carry = 0; // rests waiting for the next sung note (a line's trailing rests go to the next line)
  return song.lines.flatMap((l, li) => {
    // whole words, not the hyphenated pieces: the dictionary only knows words ("ge-cko" alone is
    // "ge" and "cko", sung by letter rules); it splits the syllables itself
    const lyrics = l.lyrics.replace(/([a-z'])-(?=[a-z])/gi, "$1");
    // the line ends a phrase; a space before the comma, or a last "~," isn't read as a hold
    let syl = syllables(/[,.!?;:]$/.test(lyrics) ? lyrics : `${lyrics} ,`);
    // a score's line with no vowel to sing ("hm"): hummed, so its notes keep their time
    if (song.exact && !syl.length) syl = lyricsToSyllables("hum ,");
    const restBefore: number[] = [];
    const pitched: { midi: number; beats: number }[] = [];
    for (const n of l.notes) {
      if (n.midi === null) carry += n.beats;
      else {
        restBefore.push(carry);
        carry = 0;
        pitched.push({ midi: n.midi, beats: n.beats });
      }
    }
    const notes = pitched.length ? pitched : [{ midi: 60, beats: 1 }];
    const even = !song.exact && notes.every((n) => n.beats === notes[0].beats);
    if (song.exact && pitched.length) {
      // a score's song: every note at its written time, whatever the dictionary made of the words;
      // a syllable short, the last vowel holds; a syllable over, it is dropped
      return pitched.map((n, i) => {
        const s = syl[i] ?? { ...syl[syl.length - 1], text: "~", melisma: true };
        return { midi: n.midi + shift, beats: n.beats, syl: { ...s, phraseEnd: i === pitched.length - 1 }, rest: restBefore[i], line: li };
      });
    }
    return syl.map((s, i) => {
      const period = 2 * (notes.length - 1), k = period ? i % period : 0;
      const n = notes[k < notes.length ? k : period - k];
      const rest = i === 0 && !pitched.length ? carry : (restBefore[i] ?? 0);
      if (i === 0 && !pitched.length) carry = 0;
      return { midi: n.midi + shift, beats: even ? sungBeats(s, i === syl.length - 1) : n.beats, syl: s, rest, line: li };
    });
  });
}

/** A song sung a cappella (asked for): no band, only its own sung parts; with `beat` (the score had
 *  drums, or a beatbox was asked for), a beatboxer keeps the beat. No voices are added. */
export function acappella(song: Song, beat = !!song.drums): Song {
  return { ...song, lines: song.lines.map((l) => ({ ...l, chords: [] })), beatbox: beat, parts: (song.parts ?? []).filter((p) => p.vocal) };
}

/**
 * The most voices asked for: every line sung by two singers an octave apart, like an ensemble. Each
 * choir part gets a second singer an octave below (a high part) or above (a low one), so a female
 * voice doubles a male's and the other way round; the tune gets one an octave below the lead. The
 * doubles come after the song's own voices, so a busy audio thread hums them first.
 */
// ponytail: the lead's double is always an octave down (male); a male lead gets a unison double, pick its octave by the lead's body if that sounds thin
export function ensemble(song: Song): Song {
  const octave = (s: Song, by: number): Song => ({
    ...s,
    lines: s.lines.map((l) => ({ ...l, chords: [], notes: l.notes.map((n) => (n.midi === null ? n : { ...n, midi: n.midi + by })) })),
  });
  const median = (s: Song): number => {
    const ps = s.lines.flatMap((l) => l.notes.flatMap((n) => (n.midi === null ? [] : [n.midi]))).sort((a, b) => a - b);
    return ps[ps.length >> 1] ?? 60;
  };
  const own = song.voices ?? [];
  const lead: Song = { bpm: song.bpm, exact: song.exact, lang: song.lang, meter: song.meter, lines: song.lines };
  // the speech's split into female and male is at A3 (57): the double sits across it
  const doubles = own.map((v) => ({ name: v.name, song: octave(v.song, median(v.song) >= 57 ? -12 : 12) }));
  return { ...song, voices: [...own, { name: "Lead", song: octave(lead, -12) }, ...doubles] };
}
