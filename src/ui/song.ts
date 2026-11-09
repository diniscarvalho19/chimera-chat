/** A chat song → the notes the engine sings: each line's syllables paired with its notes. */
import { lyricsToSyllables } from "../wasm/engine.ts";
import type { SungNote, Syllable } from "../wasm/types.ts";
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
 * and its last note repeats (a miscount still sings). A line whose notes are all one length (a
 * small model often writes no rhythm) gets the stress rhythm instead. Each line ends a phrase.
 */
export function songNotes(song: Song, shift: number): SungNote[] {
  return song.lines.flatMap((l) => {
    // whole words, not the hyphenated pieces: the dictionary only knows words ("ge-cko" alone is
    // "ge" and "cko", sung by letter rules); it splits the syllables itself
    const lyrics = l.lyrics.replace(/([a-z'])-(?=[a-z])/gi, "$1");
    const syl = lyricsToSyllables(/[,.!?;:]$/.test(lyrics) ? lyrics : `${lyrics},`);
    const notes = l.notes.length ? l.notes : [{ midi: 60, beats: 1 }];
    const even = notes.every((n) => n.beats === notes[0].beats);
    return syl.map((s, i) => {
      const n = notes[Math.min(i, notes.length - 1)];
      return { midi: n.midi + shift, beats: even ? sungBeats(s, i === syl.length - 1) : n.beats, syl: s };
    });
  });
}
