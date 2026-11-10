/** Chat replies as the voice says them: paragraphs, and their speakable text. */
export interface Block {
  start: number;
  end: number;
}

/** The text's paragraphs (split on blank lines, never inside a ``` fence), as char ranges. */
export function blocks(text: string): Block[] {
  const out: Block[] = [];
  let start = 0, pos = 0, fence = false;
  for (const line of text.split("\n")) {
    if (/^\s*```/.test(line)) fence = !fence;
    if (!fence && !line.trim()) {
      if (text.slice(start, pos).trim()) out.push({ start, end: pos });
      start = pos + line.length + 1;
    }
    pos += line.length + 1;
  }
  if (text.slice(start).trim()) out.push({ start, end: text.length });
  return out;
}

/**
 * Whether a paragraph is Portuguese, so the voice reads it with Portuguese's rules: a quarter of its
 * words are common Portuguese ones, or it has an ã, õ or ç and at least one.
 */
// ponytail: a word list, not language identification; Spanish may pass for Portuguese
export function isPortuguese(text: string): boolean {
  const words = text.toLowerCase().match(/\p{L}+/gu) ?? [];
  if (!words.length) return false;
  const pt = words.filter((w) => PT_WORDS.has(w)).length;
  return pt / words.length >= 0.25 || (pt > 0 && /[ãõç]/i.test(text));
}
const PT_WORDS = new Set(
  "não sim você vocês eu tu ele ela nós eles elas meu minha seu sua nosso nossa é são está estão estou foi ser estar ter tem tenho tinha fazer faz posso pode quero que de do da dos das em no na nos nas um uma uns umas com para por pra pelo pela mas ou se como mais muito muita bem também já ainda quando onde porque isso isto esse essa este esta aqui ali então olá obrigado obrigada tudo nada coisa vou vai vamos ao aos às".split(" "),
);

/** What the voice says of a paragraph: code blocks dropped, markdown marks stripped. */
export function toSpeech(md: string): string {
  return md
    .replace(/```[\s\S]*?(```|$)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[`*_#>|]/g, " ")
    .replace(/^\s*[-+]\s+/gm, "")
    .trim();
}

// ---- songs: a ```song block, one phrase per line: "Twin-kle twin-kle | C4 C4 G4 G4/2"

export interface SongLine {
  lyrics: string;
  /** midi null = a rest */
  notes: { midi: number | null; beats: number }[];
  /** the backing's chords for this line, spread evenly over it (each a list of pitch classes, root first) */
  chords: number[][];
}

export interface Song {
  bpm: number;
  lines: SongLine[];
  /** the rhythm is the score's (a found song): keep even lines even */
  exact?: boolean;
  /** a found song's other parts, played under the voice instead of the chords */
  parts?: PartNote[];
  /** a found song's other sung parts (a choir's alto, tenor, bass), each sung by a voice of its own */
  voices?: { name: string; song: Song }[];
  /** sung a cappella: a beatboxer keeps the beat (a voice of its own, after the bass) */
  beatbox?: boolean;
  /** the words' language, when not English (one the script doesn't tell): Italian is sung by its
   *  spelling (src/ui/italian.ts), Brazilian Portuguese by the engine's rules */
  lang?: "it" | "pt";
  /** a found song's bar: its length in beats, and how far into one its first note is (a pickup) */
  meter?: { beats: number; at: number };
}

/** a note of a found song's other parts; `t` and `beats` in beats from the song's first sung note */
export interface PartNote {
  midi: number;
  t: number;
  beats: number;
  /** another sung line: played as a soft "ooh"; else plucked, like a piano */
  vocal: boolean;
}

const STEP: Record<string, number> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };

/**
 * "C4" → 60, "F#4" → 66, "Bb3" → 58; null if it isn't a note. Without an octave ("E", a small
 * model's slip) the note goes in the octave nearest `near` (the melody's previous note).
 */
export function noteMidi(name: string, near = 60): number | null {
  const m = /^([a-gA-G])([#b]?)(-?\d)?$/.exec(name);
  if (!m) return null;
  const pc = STEP[m[1].toLowerCase()] + (m[2] === "#" ? 1 : m[2] === "b" ? -1 : 0);
  if (m[3] !== undefined) return 12 * (Number(m[3]) + 1) + pc;
  return near + ((((pc - near) % 12) + 18) % 12) - 6;
}

const QUALITY: Record<string, number[]> = {
  "": [0, 4, 7], m: [0, 3, 7], "7": [0, 4, 7, 10], maj7: [0, 4, 7, 11], m7: [0, 3, 7, 10],
  sus2: [0, 2, 7], sus4: [0, 5, 7], "7sus4": [0, 5, 7, 10], dim: [0, 3, 6], aug: [0, 4, 8], "5": [0, 7], add9: [0, 4, 7, 2], "6": [0, 4, 7, 9], m6: [0, 3, 7, 9],
};

/** "Em", "G7", "Cadd9", "D/F#" (the bass note after / is dropped) → pitch classes, root first; null if not a chord */
export function chordTones(name: string): number[] | null {
  const m = /^([A-G])([#b]?)(maj7|m7|m6|7sus4|sus2|sus4|dim|aug|add9|m|7|5|6)?(?:\/[A-G][#b]?)?$/.exec(name);
  if (!m) return null;
  const root = (STEP[m[1].toLowerCase()] + (m[2] === "#" ? 1 : m[2] === "b" ? -1 : 0) + 12) % 12;
  return QUALITY[m[3] ?? ""].map((i) => (root + i) % 12);
}

/** "C4 D4/2 R/1 E4": only notes and rests */
const isNoteRun = (s: string) => /^\s*(?:(?:[A-Ga-g][#b]?-?\d|[Rr](?:est)?)(?:\/[\d.]+)?\s*)+$/.test(s);

export function parseSong(src: string): Song {
  let bpm = 100, lang: Song["lang"];
  const lines: SongLine[] = [];
  for (const raw of src.split("\n")) {
    const line = raw.trim();
    const b = /^bpm\s*:?\s*(\d+(?:\.\d+)?)$/i.exec(line);
    if (b) {
      bpm = Math.min(240, Math.max(40, Number(b[1])));
      continue;
    }
    const l = /^lang\s*:?\s*(it|italian|pt|pt-br|portuguese)$/i.exec(line);
    if (l) {
      lang = /^it/i.test(l[1]) ? "it" : "pt";
      continue;
    }
    let [lyricsPart, notesPart, chordsPart = ""] = line.replace(/^♪\s*/, "").split("|");
    // a line of notes with no words (a model's slip): sung on "la", not the note names read out
    const wordless = isNoteRun(lyricsPart);
    if (wordless) [lyricsPart, notesPart, chordsPart] = ["", lyricsPart, notesPart ?? ""];
    if (notesPart === undefined) continue;
    let lyrics = lyricsPart.trim();
    const chords = chordsPart.trim().split(/\s+/).flatMap((c) => {
      const t = chordTones(c);
      return t ? [t] : [];
    });
    let prev = 60;
    const notes = notesPart
      .replace(/♯/g, "#")
      .replace(/♭/g, "b")
      .trim()
      // a model may write "C4, E4" or "C4-E4-G4"
      .split(/[\s,;]+|-(?=[A-Ga-gRr])/)
      .flatMap((tok) => {
        const [n, len] = tok.split("/");
        const rest = /^r(est)?$/i.test(n);
        const midi = rest ? null : noteMidi(n, prev);
        if (midi !== null) prev = midi;
        const beats = len ? Number(len) : 1;
        return (!rest && midi === null) || !(beats > 0) ? [] : [{ midi, beats: Math.min(beats, 8) }];
      });
    if (wordless) lyrics = notes.filter((n) => n.midi !== null).map(() => "la").join(" ");
    if (lyrics) lines.push({ lyrics, notes, chords });
  }
  return { bpm, lines, ...(lang ? { lang } : {}) };
}

/** What the chat shows for a song: its lyrics as words (the syllable hyphens are for the notes), a ♪ per phrase */
export function songDisplay(song: Song): string {
  return song.lines.map((l) => `♪ ${l.lyrics.replace(/([a-z'])-(?=[a-z])/gi, "$1").replace(/\s+~(?=\s|$)/g, "")}`).join("\n");
}

const SONG_BLOCK = /```song(-ref)?[^\n]*\n([\s\S]*?)(?:```|$)/g;

/**
 * A chord sheet's line, written outside a song block (a small model's slip; the voice would read
 * the chord names out): words then "| chords", a section header ("(Verse 1)  Em C G D"), or chords alone.
 */
const CHORD = String.raw`[A-G][#b]?(?:maj7|m7|m6|7sus4|sus2|sus4|dim|aug|add9|m|7|5|6)?(?:\/[A-G][#b]?)?`;
const CHORDS = String.raw`(?:${CHORD}\s*)+`;
const CHORD_SHEET_LINE = new RegExp(String.raw`^\s*(?:.*\|\s*${CHORDS}|${CHORDS})$`);
const SECTION = new RegExp(String.raw`^\s*[(\[]?\s*(?:intro|verse|pre-?chorus|chorus|bridge|outro|refrain|hook)\b[^)\]\n]*[)\]]?(?:\s+${CHORD})*\s*$`, "i");
const isChordSheet = (line: string): boolean => CHORD_SHEET_LINE.test(line) || SECTION.test(line);

/** the songs the reply asks for by name (```song-ref blocks: "title - artist"), to look up before extractSongs */
export function songRefs(text: string): string[] {
  return [...text.matchAll(SONG_BLOCK)].flatMap((m) => (m[1] ? [m[2].trim()] : []));
}

/**
 * The reply as shown (each song block replaced by its lyrics, set apart as its own paragraph) and
 * its songs, in order. A song asked for by name sings what `found` has for it; not found, it is
 * said so.
 */
export function extractSongs(text: string, found: ReadonlyMap<string, Song | null> = new Map()): { display: string; songs: Song[] } {
  const songs: Song[] = [];
  // a song asked for by name is the song: one the model also wrote itself (its guess at it) is dropped
  const byName = songRefs(text).length > 0;
  const display = text
    .replace(SONG_BLOCK, (_, ref: string | undefined, body: string) => {
      if (byName && !ref) return "";
      const song = ref ? found.get(body.trim()) : parseSong(body);
      if (ref && !song) return `\n\nI couldn't find the music for ${body.trim().split("\n")[0].replace(/\s+-\s+.*$/, "")}.\n\n`;
      if (!song) return "";
      if (!song.lines.length) return "";
      songs.push(song);
      return `\n\n${songDisplay(song)}\n\n`;
    })
    .split("\n")
    .filter((l) => !isChordSheet(l))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { display, songs };
}

// ---- moods: a tag "[happy]" sets the mood of the words after it, anywhere in a paragraph; a tag
// at a paragraph's end (nothing after it) is that paragraph's if it had none; a tag alone carries
// to the next paragraph; closing tags "[/happy]" are dropped

export type MoodBlock = Block & { mood: string };

/**
 * Strip the mood tags (only the known ones: `known`), giving the text to show and its spans with
 * their moods: one per paragraph, split where a tag changes the mood inside it. Spans of one
 * paragraph are joined with a space, paragraphs with a blank line.
 */
export function moodBlocks(text: string, known: (s: string) => boolean | string | null): { text: string; blocks: MoodBlock[] } {
  let out = "", mood = "neutral";
  const res: MoodBlock[] = [];
  const TAG = /\s*\[\/?([a-z]+)\]\s*/gi;
  for (const b of blocks(text)) {
    const para = text.slice(b.start, b.end).replace(/\n+$/, "");
    // [mood or null for "no tag before it", text] pieces
    const pieces: [string | null, string][] = [];
    let at = 0, tag: string | null = null, opens = 0;
    if (!para.trimStart().startsWith("```"))
      for (const m of para.matchAll(TAG)) {
        const k = known(m[1].toLowerCase());
        // a tag that isn't a mood but reads like a stage direction ("[laughs]") is dropped unsaid
        if (!k && !/^\[\/?[a-z]+\]$/.test(m[0].trim())) continue;
        const name = typeof k === "string" ? k : k ? m[1].toLowerCase() : null;
        pieces.push([tag, para.slice(at, m.index)]);
        at = m.index + m[0].length;
        if (name && !m[0].includes("/")) {
          tag = name;
          opens++;
        }
      }
    pieces.push([tag, para.slice(at)]);
    const spans = pieces.filter(([, t]) => t.trim());
    // the paragraph's one tag, at its end ("Done! [happy]"): the paragraph's mood
    if (opens === 1 && spans.length === 1 && spans[0][0] === null && pieces.length === 2) spans[0][0] = tag;
    if (!spans.length && tag) mood = tag;
    spans.forEach(([t, words], i) => {
      if (t) mood = t;
      if (out) out += i ? " " : "\n\n";
      const w = i ? words.trim() : words.trimEnd();
      res.push({ start: out.length, end: out.length + w.length, mood });
      out += w;
    });
  }
  return { text: out, blocks: res };
}
