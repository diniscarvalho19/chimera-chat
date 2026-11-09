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
  notes: { midi: number; beats: number }[];
}

export interface Song {
  bpm: number;
  lines: SongLine[];
}

const STEP: Record<string, number> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };

/** "C4" → 60, "F#4" → 66, "Bb3" → 58; null if it isn't a note */
export function noteMidi(name: string): number | null {
  const m = /^([a-gA-G])([#b]?)(-?\d)$/.exec(name);
  if (!m) return null;
  return 12 * (Number(m[3]) + 1) + STEP[m[1].toLowerCase()] + (m[2] === "#" ? 1 : m[2] === "b" ? -1 : 0);
}

export function parseSong(src: string): Song {
  let bpm = 100;
  const lines: SongLine[] = [];
  for (const raw of src.split("\n")) {
    const line = raw.trim();
    const b = /^bpm\s*:?\s*(\d+(?:\.\d+)?)$/i.exec(line);
    if (b) {
      bpm = Math.min(240, Math.max(40, Number(b[1])));
      continue;
    }
    const bar = line.lastIndexOf("|");
    if (bar < 0) continue;
    const lyrics = line.slice(0, bar).trim();
    const notes = line
      .slice(bar + 1)
      .trim()
      .split(/\s+/)
      .flatMap((tok) => {
        const [n, len] = tok.split("/");
        const midi = noteMidi(n);
        const beats = len ? Number(len) : 1;
        return midi === null || !(beats > 0) ? [] : [{ midi, beats: Math.min(beats, 8) }];
      });
    if (lyrics) lines.push({ lyrics, notes });
  }
  return { bpm, lines };
}

/** What the chat shows for a song: its lyrics as words (the syllable hyphens are for the notes), a ♪ per phrase */
export function songDisplay(song: Song): string {
  return song.lines.map((l) => `♪ ${l.lyrics.replace(/([a-z'])-(?=[a-z])/gi, "$1")}`).join("\n");
}

/** The reply as shown (each song block replaced by its lyrics, set apart as its own paragraph) and its songs, in order. */
export function extractSongs(text: string): { display: string; songs: Song[] } {
  const songs: Song[] = [];
  const display = text
    .replace(/```song[^\n]*\n([\s\S]*?)(?:```|$)/g, (_, body: string) => {
      const song = parseSong(body);
      if (!song.lines.length) return "";
      songs.push(song);
      return `\n\n${songDisplay(song)}\n\n`;
    })
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { display, songs };
}

// ---- moods: a paragraph may start with a tag, "[happy] ..."; a tag alone carries to the next one

export type MoodBlock = Block & { mood: string };

/**
 * Strip the mood tags off the paragraphs (only the known ones: `known`), giving the text to show
 * and its paragraphs with their moods. A paragraph without a tag keeps the one before it.
 */
export function moodBlocks(text: string, known: (s: string) => boolean): { text: string; blocks: MoodBlock[] } {
  const out: string[] = [], res: MoodBlock[] = [];
  let mood = "neutral", pos = 0;
  for (const b of blocks(text)) {
    let para = text.slice(b.start, b.end).replace(/\n+$/, "");
    const m = /^\s*\[([a-z]+)\]\s*/i.exec(para);
    if (m && known(m[1].toLowerCase())) {
      mood = m[1].toLowerCase();
      para = para.slice(m[0].length);
    }
    if (!para.trim()) continue;
    if (out.length) pos += 2;
    out.push(para);
    res.push({ start: pos, end: pos + para.length, mood });
    pos += para.length;
  }
  return { text: out.join("\n\n"), blocks: res };
}
