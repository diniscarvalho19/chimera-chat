/** A chat song → the notes the engine sings: each line's syllables paired with its notes. */
import { lyricsToSyllables } from "../wasm/engine.ts";
import type { SungNote } from "../wasm/types.ts";
import type { Song } from "./chatText.ts";

/**
 * One note per syllable, line by line. A line with too many notes drops the extra ones; too few,
 * and its last note repeats (a miscount still sings). Each line ends a phrase (a breath).
 */
export function songNotes(song: Song, shift: number): SungNote[] {
  return song.lines.flatMap((l) => {
    const syl = lyricsToSyllables(/[,.!?;:]$/.test(l.lyrics) ? l.lyrics : `${l.lyrics},`);
    const notes = l.notes.length ? l.notes : [{ midi: 60, beats: 1 }];
    return syl.map((s, i) => {
      const n = notes[Math.min(i, notes.length - 1)];
      return { midi: n.midi + shift, beats: n.beats, syl: s };
    });
  });
}
