/** A chat song → the notes the engine sings: each line's syllables paired with its notes. */
import { lyricsToSyllables, lyricsToSyllablesPt } from "../wasm/engine.ts";
import { italianSyllables } from "./italian.ts";
import type { SungNote, Syllable } from "../wasm/types.ts";

/** a sung note, and the beats of silence before it (a rest: R in the song) */
export type RestedNote = SungNote & { rest: number; line: number };
import type { PartNote, Song } from "./chatText.ts";

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

/**
 * Backing singers for a song that has none of its own (asked for: "with harmony"): up to `n` lines
 * under the tune, singing its words. Each note takes a tone of the chord sounding with it (from the
 * song's other parts, else its line's chords) a third to a sixth under the line above, the one
 * nearest the singer's last note; with no chord to go by, a third under (major or minor, whichever
 * the tune itself uses).
 */
// ponytail: chord tones only, no voice-leading rules (parallels, resolutions); a real harmonizer if it sounds naive
export function harmonize(song: Song, n = 2): { name: string; song: Song }[] {
  // the chord's pitch classes at a time (beats from the song's start)
  const lineSpans: { t0: number; t1: number; chords: number[][] }[] = [];
  let t = 0;
  for (const l of song.lines) {
    const len = l.notes.reduce((s, x) => s + x.beats, 0);
    lineSpans.push({ t0: t, t1: t + len, chords: l.chords });
    t += len;
  }
  const chordAt = (at: number): Set<number> | null => {
    const sounding = (song.parts ?? []).filter((p) => p.t <= at + 1e-6 && at < p.t + p.beats - 1e-6);
    if (sounding.length) return new Set(sounding.map((p) => ((p.midi % 12) + 12) % 12));
    const span = lineSpans.find((s) => at >= s.t0 - 1e-6 && at < s.t1 - 1e-6);
    if (!span?.chords.length) return null;
    const k = Math.min(span.chords.length - 1, Math.floor(((at - span.t0) / (span.t1 - span.t0)) * span.chords.length));
    return new Set(span.chords[k]);
  };
  const tunePcs = new Set(song.lines.flatMap((l) => l.notes.flatMap((x) => (x.midi === null ? [] : [((x.midi % 12) + 12) % 12]))));
  const third = (m: number) => (tunePcs.has((((m - 4) % 12) + 12) % 12) ? m - 4 : m - 3);

  const singers: { name: string; song: Song }[] = [];
  let above = song.lines; // the line each singer harmonizes under
  for (let s = 0; s < n; s++) {
    let last: number | null = null;
    let at = 0;
    const lines = above.map((l) => ({
      ...l,
      chords: [],
      notes: l.notes.map((x) => {
        const start = at;
        at += x.beats;
        if (x.midi === null) return x;
        const top = x.midi;
        const chord = chordAt(start);
        const options: number[] = [];
        if (chord) for (let m = top - 9; m <= top - 3; m++) if (chord.has(((m % 12) + 12) % 12)) options.push(m);
        const prev: number = last ?? third(top);
        const midi = options.length ? options.reduce((a, b) => (Math.abs(b - prev) < Math.abs(a - prev) ? b : a)) : third(top);
        last = midi;
        return { midi, beats: x.beats };
      }),
    }));
    const harmony: Song = { bpm: song.bpm, lines, ...(song.exact ? { exact: true } : {}), ...(song.lang ? { lang: song.lang } : {}) };
    singers.push({ name: `Harmony ${s + 1}`, song: harmony });
    above = lines;
  }
  return singers;
}

/**
 * A song sung a cappella (asked for): no band. The voices take its instruments' parts: a bass on
 * the lowest note sounding at each moment ("bom", "bum", "dum"), a backing voice on the highest ("doo",
 * "ooh" on a long one) and a middle voice on the one between ("dah", "ah"), each moved by octaves
 * into a singer's range; and, with `beat` (the score had drums, or a beatbox was asked for), a
 * beatboxer keeps the beat. A song with chords and no parts
 * (the model's own) gets them from its chords: the bass on each root, the backing on a chord tone;
 * with neither, harmony under the tune.
 * The song's own sung parts stay first; these are added after them.
 * With `band` (more voices asked for, not a cappella) the band keeps playing under them, no beatboxer.
 */
// ponytail: three lines (top, middle and bottom of the accompaniment) and one groove for every song
export function acappella(song: Song, band = false, beat = !!song.drums): Song {
  let parts: PartNote[] = (song.parts ?? []).filter((p) => !p.vocal);
  if (!parts.length) {
    // from the chords, each spread over its line as the band would play them
    let t = 0;
    for (const l of song.lines) {
      const len = l.notes.reduce((s, x) => s + x.beats, 0);
      l.chords.forEach((c, k) => {
        const t0 = t + (k * len) / l.chords.length, beats = len / l.chords.length;
        parts.push({ midi: 36 + c[0], t: t0, beats, vocal: false }, { midi: 60 + c[Math.min(1, c.length - 1)], t: t0, beats, vocal: false });
      });
      t += len;
    }
  }
  const lines = song.lines.map((l) => ({ ...l, chords: [] }));
  if (!parts.length) {
    // nothing to take the voices from (no instruments, no chords): harmony under the tune instead
    const own = song.voices?.length ?? 0;
    return { ...song, lines, beatbox: beat, parts: (song.parts ?? []).filter((p) => p.vocal), voices: [...(song.voices ?? []), ...(own < 2 ? harmonize(song, 2 - own) : [])] };
  }
  // the lowest and the highest note at each onset, each line one note at a time
  const onsets = [...new Set(parts.map((p) => p.t))].sort((a, b) => a - b);
  const line = (pick: (ns: PartNote[]) => PartNote | null): PartNote[] => onsets.flatMap((t) => pick(parts.filter((p) => Math.abs(p.t - t) < 1e-6)) ?? []);
  const bass = line((ns) => ns.reduce((a, b) => (b.midi < a.midi ? b : a)));
  const top = line((ns) => ns.reduce((a, b) => (b.midi > a.midi ? b : a)));
  // the middle of three or more (two have no middle: that moment it rests)
  const middle = line((ns) => (ns.length < 3 ? null : [...ns].sort((a, b) => a.midi - b.midi)[ns.length >> 1]));
  const voice = (ns: PartNote[], lo: number, hi: number, sound: (beats: number, i: number) => string, name: string) => {
    const mid = [...ns].sort((a, b) => a.midi - b.midi)[ns.length >> 1].midi;
    const shift = mid < lo ? 12 * Math.ceil((lo - mid) / 12) : mid > hi ? -12 * Math.ceil((mid - hi) / 12) : 0;
    // each note until the next one starts (a held chord is one note), rests between; lines of up to four bars
    const out: Song["lines"] = [];
    let cur: Song["lines"][number] = { lyrics: "", notes: [], chords: [] }, at = 0, start = 0;
    ns.forEach((n, i) => {
      const end = Math.min(n.t + n.beats, ns[i + 1]?.t ?? Infinity);
      if (n.t > at + 1e-6) cur.notes.push({ midi: null, beats: n.t - at });
      if (cur.lyrics && n.t - start >= 16) {
        out.push(cur);
        cur = { lyrics: "", notes: [], chords: [] };
        start = n.t;
      }
      if (!cur.lyrics) start = n.t;
      cur.notes.push({ midi: n.midi + shift, beats: end - n.t });
      cur.lyrics += (cur.lyrics ? " " : "") + sound(end - n.t, i);
      at = end;
    });
    if (cur.lyrics) out.push(cur);
    return { name, song: { bpm: song.bpm, exact: true, lines: out } };
  };
  const sung = [
    voice(bass, 45, 55, (b, i) => (b >= 1.5 ? "bom" : i % 2 ? "dum" : "bum"), "Bass"),
    voice(top, 57, 74, (b) => (b >= 1.5 ? "ooh" : "doo"), "Backing"),
    ...(middle.length >= 4 ? [voice(middle, 52, 64, (b) => (b >= 1.5 ? "ah" : "dah"), "Middle")] : []),
  ];
  if (band) return { ...song, voices: [...(song.voices ?? []), ...sung] };
  return { ...song, lines, beatbox: beat, parts: (song.parts ?? []).filter((p) => p.vocal), voices: [...(song.voices ?? []), ...sung] };
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
