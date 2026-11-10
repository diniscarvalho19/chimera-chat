/**
 * A MusicXML score (.mxl or .musicxml) → a chat song (chatText's Song), in the browser: the sung
 * part's melody, its lyrics as whole words, the score's chord symbols for the band. A browser
 * port of upstream's tools/musicxml-to-notes.ts (PR #24), made to cope instead of stop, since
 * these are scores found for the chat, not ones prepared for a show:
 *
 *  - the part sung is the top one with nearly the most lyrics (the tune), and in it the voice with
 *    the most lyrics; the other parts and voices are the accompaniment;
 *  - repeats and 1st/2nd endings are written out, each pass singing its own verse line; D.C., D.S.,
 *    To Coda and Fine are ignored (it sings straight through);
 *  - it starts where the singing starts and sings to the end (or for `maxBars` sung bars),
 *    ending at the end of a line;
 *  - tied notes are one note, a chord sings its top note, grace and cue notes are skipped, a note
 *    with no lyric holds the previous vowel (~);
 *  - each word is joined back up ("to-ge-ther") and fitted to its notes by the dictionary: fewer
 *    syllables than notes hold the last vowel; more, and the score's own pieces are sung;
 *  - the melody moves by octaves into the voice's range; tempo is the first one given.
 */
import { chordTones, type PartNote, type Song, type SongLine } from "./chatText.ts";
import { syllablesFor } from "./song.ts";

const STEP: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const KIND: Record<string, string> = {
  major: "", minor: "m", dominant: "7", "major-seventh": "maj7", "minor-seventh": "m7", diminished: "dim", augmented: "aug",
  "suspended-fourth": "sus4", "suspended-second": "sus2", "major-sixth": "6", "minor-sixth": "m6", power: "5",
};

const tag = (xml: string, name: string): string | null => xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`))?.[1].trim() ?? null;
const has = (xml: string, name: string): boolean => new RegExp(`<${name}[\\s/>]`).test(xml);
const unescape = (s: string): string => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
const attrsOf = (s: string): Record<string, string> => Object.fromEntries([...s.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map((a) => [a[1], unescape(a[2] ?? a[3])]));
const attrs = (xml: string, name: string): Record<string, string>[] => [...xml.matchAll(new RegExp(`<${name}(\\s[^>]*)?>`, "g"))].map((m) => attrsOf(m[1] ?? ""));

/** an .mxl (a zip) → its score's XML; a plain .musicxml's bytes pass through */
export async function scoreXml(bytes: Uint8Array): Promise<string> {
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) return new TextDecoder().decode(bytes);
  const files = unzip(bytes);
  const container = files.get("META-INF/container.xml");
  const root = container ? (await container()).match(/full-path="([^"]+)"/)?.[1] : [...files.keys()].find((k) => /\.(musicxml|xml)$/.test(k) && !k.startsWith("META-INF"));
  const file = root && files.get(root);
  if (!file) throw new Error("no score in the .mxl");
  return file();
}

/** a zip's files by name, each read on demand (stored or deflated; that's all .mxl uses) */
function unzip(b: Uint8Array): Map<string, () => Promise<string>> {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let eocd = b.length - 22;
  while (eocd >= 0 && v.getUint32(eocd, true) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error("not a zip");
  const out = new Map<string, () => Promise<string>>();
  let p = v.getUint32(eocd + 16, true);
  for (let n = v.getUint16(eocd + 10, true); n > 0; n--) {
    const method = v.getUint16(p + 10, true), size = v.getUint32(p + 20, true);
    const nameLen = v.getUint16(p + 28, true), extra = v.getUint16(p + 30, true), comment = v.getUint16(p + 32, true);
    const local = v.getUint32(p + 42, true);
    const name = new TextDecoder().decode(b.subarray(p + 46, p + 46 + nameLen));
    const start = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
    const data = b.subarray(start, start + size);
    out.set(name, async () => {
      if (method === 0) return new TextDecoder().decode(data);
      if (method !== 8) throw new Error(`zip method ${method}`);
      return new Response(new Blob([data.slice()]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).text();
    });
    p += 46 + nameLen + extra + comment;
  }
  return out;
}

/** a note (or rest) of a part, at its time in the play order */
interface Note {
  /** beats from the start of the play order */
  t: number;
  beats: number;
  /** null: a rest */
  midi: number | null;
  voice: string;
  /** a note sounding with the one before it (a chord); grace and cue notes are left out */
  chord: boolean;
  ties: Set<string>;
  /** the lyric for this pass through a repeat (the <lyric> element's content), if any */
  lyric?: string;
  bar: number;
}

/** one sounding note or rest of the sung voice, in play order */
interface Ev {
  t: number;
  midi: number | null;
  beats: number;
  /** the lyric piece on it, and how it joins its word (single, begin, middle, end); none: a held vowel */
  text?: string;
  syllabic?: string;
  /** which bar of the play order */
  bar: number;
}

/** a part's notes and chord symbols in play order, each at its time (voices, chords and backups placed) */
function walk(part: string): { notes: Note[]; harmony: { t: number; bar: number; tones: number[] }[]; barStarts: number[]; beatsPerBar: number } {
  const measures = [...part.matchAll(/<measure(\s[^>]*)?>([\s\S]*?)<\/measure>/g)].map((m) => m[2]);
  const notes: Note[] = [], harmony: { t: number; bar: number; tones: number[] }[] = [], barStarts: number[] = [];
  let beatsPerBar = 0;
  let divisions = 1, barStart = 0;
  // a transposing part (a tenor in treble clef, a B♭ clarinet) is written at another pitch than it sounds
  let transpose = 0;
  playOrder(measures).forEach(({ xml: m, pass }, bar) => {
    let pos = 0, longest = 0, lastStart = 0; // in beats from the bar's start
    barStarts.push(barStart);
    for (const e of m.matchAll(/<(attributes|note|harmony|backup|forward)\b[^>]*>([\s\S]*?)<\/\1>/g)) {
      const [, kind, x] = e;
      const dur = Number(tag(x, "duration")) / divisions || 0;
      if (kind === "attributes") {
        divisions = Number(tag(x, "divisions")) || divisions;
        const time = tag(x, "time");
        if (time && !beatsPerBar) beatsPerBar = (Number(tag(time, "beats")) * 4) / Number(tag(time, "beat-type")) || 0;
        const tr = tag(x, "transpose");
        if (tr) transpose = Number(tag(tr, "chromatic") ?? 0) + 12 * Number(tag(tr, "octave-change") ?? 0);
      }
      else if (kind === "backup") pos -= dur;
      else if (kind === "forward") pos += dur;
      else if (kind === "harmony") {
        const step = tag(x, "root-step"), alter = Number(tag(x, "root-alter") ?? 0), k = tag(x, "kind") ?? "major";
        const tones = step ? chordTones(step + (alter > 0 ? "#" : alter < 0 ? "b" : "") + (KIND[k] ?? (k.startsWith("minor") ? "m" : ""))) : null;
        if (tones) harmony.push({ t: barStart + pos, bar, tones });
      } else {
        if (has(x, "grace") || has(x, "cue")) continue;
        const chord = has(x, "chord");
        const at = chord ? lastStart : pos;
        if (!chord) {
          lastStart = pos;
          pos += dur;
        }
        const pitch = tag(x, "pitch");
        if (!(dur > 0) || (!pitch && !has(x, "rest"))) continue; // unpitched (drums): not played
        const midi = pitch ? 12 * (Number(tag(pitch, "octave")) + 1) + STEP[tag(pitch, "step") ?? "C"] + Math.round(Number(tag(pitch, "alter") ?? 0)) + transpose : null;
        const lyrics = [...x.matchAll(/<lyric(\s[^>]*)?>([\s\S]*?)<\/lyric>/g)];
        const lyric = (lyrics.find((l) => attrsOf(l[1] ?? "").number === String(pass)) ?? lyrics[0])?.[2];
        notes.push({ t: barStart + at, beats: dur, midi, voice: tag(x, "voice") ?? "1", chord, ties: new Set(attrs(x, "tie").map((t) => t.type)), lyric, bar });
      }
      longest = Math.max(longest, pos);
    }
    barStart += longest;
  });
  return { notes, harmony, barStarts, beatsPerBar: beatsPerBar || 4 };
}

/**
 * The score's sung melody as a chat song, and its other parts as the accompaniment. `maxBars` caps
 * the excerpt (sung bars, from the first lyric); `count` gives a word's syllables as the voice will
 * sing it (in the score's `lang`: the engine's dictionary for English).
 */
export function scoreToSong(xml: string, o: { maxBars?: number; count?: (word: string) => number; lang?: Song["lang"] } = {}): Song {
  const maxBars = o.maxBars ?? Infinity;
  const sylls = syllablesFor(o.lang);
  const count = o.count ?? ((w: string) => sylls(w).filter((s) => !s.melisma).length);
  const lang = o.lang ? { lang: o.lang } : {};
  const names = new Map([...xml.matchAll(/<score-part\s[^>]*id="([^"]+)"[^>]*>([\s\S]*?)<\/score-part>/g)].map((m) => [m[1], unescape(tag(m[2], "part-name") ?? "").replace(/\s+/g, " ").toLowerCase()]));
  const parts = [...xml.matchAll(/<part(\s[^>]*)?>([\s\S]*?)<\/part>/g)].map((m) => ({ id: attrsOf(m[1] ?? "").id, xml: m[2], lyrics: m[2].match(/<lyric/g)?.length ?? 0 }));
  // the melody: the first part (scores list it on top) with nearly the most lyrics; a choir's
  // tenor may have a few more words than its soprano, but it isn't the tune
  const most = Math.max(0, ...parts.map((p) => p.lyrics));
  const main = parts.find((p) => p.lyrics >= 0.8 * most);
  if (!main?.lyrics) throw new Error("the score has no lyrics");
  const tempo = attrs(xml, "sound").find((a) => a.tempo)?.tempo ?? tag(xml, "per-minute");
  const bpm = Math.min(200, Math.max(40, Number(tempo) || 100));

  const { notes, harmony, barStarts, beatsPerBar } = walk(main.xml);
  const voice = lyricVoice(notes);
  const evs = sungEvents(notes, voice);

  // the excerpt: from the first lyric, for maxBars bars (ended at a word's end)
  const first = evs.findIndex((e) => e.text);
  if (first < 0) throw new Error("the sung part has no lyrics");
  const lastBar = evs[first].bar + maxBars;
  let end = first;
  for (; end < evs.length; end++) {
    const e = evs[end];
    if (e.bar >= lastBar && (e.midi === null || e.syllabic === "single" || e.syllabic === "begin")) break;
  }
  const sung = evs.slice(first, end);
  while (sung.length && sung[sung.length - 1].midi === null) sung.pop();
  const t0 = sung[0].t, t1 = sung[sung.length - 1].t + sung[sung.length - 1].beats;

  // into the voice's range: the median note between C4 and B4 (the male voice sings it an octave down)
  const pitches = sung.flatMap((e) => (e.midi === null ? [] : [e.midi])).sort((a, b) => a - b);
  const shift = 12 * Math.round((66 - pitches[pitches.length >> 1]) / 12);

  // the other sung parts (a choir's alto, tenor, bass): sung too, by their own voices, each from
  // where the excerpt starts (a word begun before it is left out) to where it ends
  const voices: { name: string; song: Song; id: string }[] = [];
  for (const p of parts) {
    if (p === main || p.lyrics < 0.3 * main.lyrics) continue;
    const ns = walk(p.xml).notes;
    const win = within(sungEvents(ns, lyricVoice(ns)), t0, t1);
    const lines = win.some((e) => e.text) ? toLines(win, 0, count, []) : [];
    if (!lines.some((l) => l.lyrics.trim())) continue;
    const name = names.get(p.id) || `Voice ${voices.length + 2}`;
    voices.push({ id: p.id, name: name[0].toUpperCase() + name.slice(1), song: { bpm, exact: true, lines, ...lang } });
  }

  // the accompaniment: every other part, and the sung part's other voices, under the excerpt
  const under: PartNote[] = [];
  const add = (ns: Note[], vocal: (n: Note) => boolean, skip: (n: Note) => boolean) => {
    const held = new Map<string, PartNote>(); // tied notes, by voice and pitch
    for (const n of ns) {
      if (n.midi === null || skip(n) || n.t + n.beats <= t0 || n.t >= t1) continue;
      const key = `${n.voice}:${n.midi}`, prev = held.get(key);
      if (prev && n.ties.has("stop") && Math.abs(prev.t + prev.beats - (n.t - t0)) < 1e-3) prev.beats += n.beats;
      else {
        const t = Math.max(0, n.t - t0);
        const note = { midi: n.midi, t, beats: Math.min(n.t + n.beats, t1) - t0 - t, vocal: vocal(n) };
        under.push(note);
        if (n.ties.has("start")) held.set(key, note);
      }
    }
  };
  // the sung part's other voices: sung lines if they have lyrics of their own (a piano written in
  // the singer's part has none); other parts: sung if they have lyrics or a singer's name
  const lyricVoices = new Set(notes.flatMap((n) => (n.lyric ? [n.voice] : [])));
  add(notes, (n) => lyricVoices.has(n.voice), (n) => n.voice === voice && !n.chord);
  for (const p of parts) {
    if (p === main || voices.some((v) => v.id === p.id)) continue;
    const name = names.get(p.id) ?? "";
    const sung = p.lyrics > 0 || (/voice|vocal|sopran|alto|tenor|bass(?!o)|bariton|choir|singer|vox/.test(name) && !/guitar|piano/.test(name));
    add(walk(p.xml).notes, () => sung, () => false);
  }
  under.sort((a, b) => a.t - b.t);

  const chordsAt = harmony.map((h) => ({ bar: h.bar, tones: h.tones }));
  return {
    bpm,
    exact: true,
    ...lang,
    lines: toLines(sung, shift, count, chordsAt),
    ...(under.length ? { parts: under.slice(0, 3000) } : {}),
    ...(voices.length ? { voices: voices.map(({ name, song }) => ({ name, song })) } : {}),
    meter: { beats: beatsPerBar, at: t0 - (barStarts[sung[0].bar] ?? t0) },
  };
}

/** the voice of a part with the most lyrics */
function lyricVoice(notes: Note[]): string {
  const byVoice = new Map<string, number>();
  for (const n of notes) if (n.lyric) byVoice.set(n.voice, (byVoice.get(n.voice) ?? 0) + 1);
  return [...byVoice].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "1";
}

/** one voice's notes in order: ties joined, gaps (another voice's turn) made rests */
function sungEvents(notes: Note[], voice: string): Ev[] {
  const evs: Ev[] = [];
  let tieOpen = false, cursor = 0;
  for (const n of notes) {
    if (n.voice !== voice || n.chord) continue;
    if (n.t > cursor + 1e-6) evs.push({ t: cursor, midi: null, beats: n.t - cursor, bar: n.bar });
    cursor = Math.max(cursor, n.t + n.beats);
    const last = evs[evs.length - 1];
    if (n.midi === null) {
      if (last?.midi === null) last.beats += n.beats;
      else evs.push({ t: n.t, midi: null, beats: n.beats, bar: n.bar });
      tieOpen = false;
      continue;
    }
    if (tieOpen && n.ties.has("stop") && last?.midi === n.midi) {
      last.beats += n.beats;
      tieOpen = n.ties.has("start");
      continue;
    }
    tieOpen = n.ties.has("start");
    const text = n.lyric ? unescape([...n.lyric.matchAll(/<text[^>]*>([\s\S]*?)<\/text>/g)].map((t) => t[1]).join("")).replace(/’/g, "'").trim() : "";
    evs.push({ t: n.t, midi: n.midi, beats: n.beats, bar: n.bar, ...(text ? { text, syllabic: tag(n.lyric!, "syllabic") ?? "single" } : {}) });
  }
  return evs;
}

/** a voice's events from t0 to t1 (beats), starting with a rest up to its first; a word begun before t0 is silent */
function within(evs: Ev[], t0: number, t1: number): Ev[] {
  const out: Ev[] = [];
  let started = false;
  for (const e of evs) {
    if (e.t < t0 - 1e-6 || e.t >= t1 - 1e-6) continue;
    const x = { ...e, beats: Math.min(e.beats, t1 - e.t) };
    if (!started && x.midi !== null && !(x.text && (x.syllabic === "single" || x.syllabic === "begin"))) {
      out.push({ t: x.t, midi: null, beats: x.beats, bar: x.bar });
      continue;
    }
    started ||= x.midi !== null;
    out.push(x);
  }
  if (out.length && out[0].t > t0 + 1e-6) out.unshift({ t: t0, midi: null, beats: out[0].t - t0, bar: out[0].bar });
  while (out.length && out[out.length - 1].midi === null) out.pop();
  return out;
}

/** the measures in play order: repeats and voltas written out; `pass` is the time through a repeat */
function playOrder(measures: string[]): { xml: string; pass: number }[] {
  const order: { xml: string; pass: number }[] = [];
  let start = 0, pass = 1, jumped = false;
  let ending: number[] | null = null;
  for (let i = 0; i < measures.length && order.length < 2000; ) {
    const m = measures[i];
    const repeats = attrs(m, "repeat"), endings = attrs(m, "ending");
    if (repeats.some((r) => r.direction === "forward") && !jumped) {
      start = i;
      pass = 1;
    }
    jumped = false;
    const begins = endings.find((e) => e.type === "start");
    if (begins) ending = (begins.number ?? "").split(/[\s,]+/).filter(Boolean).map(Number);
    const play = !ending || ending.includes(pass);
    if (endings.some((e) => e.type === "stop" || e.type === "discontinue")) ending = null;
    if (!play) {
      i++;
      continue;
    }
    order.push({ xml: m, pass });
    const back = repeats.find((r) => r.direction === "backward");
    if (back && pass < Number(back.times ?? 2)) {
      pass++;
      i = start;
      jumped = true;
      ending = null;
      continue;
    }
    if (back) {
      start = i + 1;
      pass = 1;
    }
    i++;
  }
  return order;
}

/**
 * Words and lines: each word's pieces joined and fitted to its notes; a new line at a rest of a
 * beat or more, after a word ending a phrase (, . ; : ! ?), or once the line has four bars.
 */
function toLines(evs: Ev[], shift: number, count: (w: string) => number, chordsAt: { bar: number; tones: number[] }[]): SongLine[] {
  const lines: SongLine[] = [];
  let line = null as SongLine | null, lineBar = 0; // (a cast: the closures assign it)
  let phraseEnd = false;
  const open = (bar: number): SongLine => {
    if (!line) {
      line = { lyrics: "", notes: [], chords: [] };
      lineBar = bar;
    }
    return line;
  };
  const close = (lastBar: number) => {
    if (!line) return;
    if (line.lyrics.trim()) {
      const chords = chordsAt.filter((c) => c.bar >= lineBar && c.bar <= lastBar).map((c) => c.tones);
      line.chords = chords.filter((c, i) => i === 0 || c.join() !== chords[i - 1].join()).slice(0, 6);
      lines.push(line);
    }
    line = null;
  };
  for (let i = 0; i < evs.length; ) {
    const e = evs[i];
    if (e.midi === null) {
      if (e.beats >= 1 && line?.lyrics) close(e.bar);
      open(e.bar).notes.push({ midi: null, beats: e.beats });
      i++;
      continue;
    }
    // a word: its pieces to the piece that ends it, and the held notes after each
    const notes: Ev[] = [];
    const pieces: string[] = [];
    do {
      const n = evs[i++];
      if (n.text !== undefined) pieces.push(n.text);
      notes.push(n);
      if (n.syllabic === "single" || n.syllabic === "end") break;
    } while (i < evs.length && evs[i].midi !== null && (evs[i].text === undefined || (evs[i].syllabic !== "single" && evs[i].syllabic !== "begin")));
    while (i < evs.length && evs[i].midi !== null && evs[i].text === undefined) notes.push(evs[i++]);
    if (!pieces.length) {
      // notes with no lyric not straight after a sung one (after a rest, a fill): not sung; else held
      const prev = line?.notes[line.notes.length - 1];
      if (line?.lyrics && prev && prev.midi !== null) {
        line.lyrics += " ~".repeat(notes.length);
        for (const x of notes) line.notes.push({ midi: x.midi! + shift, beats: x.beats });
      } else open(e.bar).notes.push({ midi: null, beats: notes.reduce((b, x) => b + x.beats, 0) }); // silent, in time
      continue;
    }
    if (line?.lyrics && (phraseEnd || e.bar - lineBar >= 4)) close(e.bar - 1);
    phraseEnd = /[,.;:!?]["')]*$/.test(pieces[pieces.length - 1]);
    const ln = open(e.bar);
    const word = pieces.join("").replace(/[^\p{L}']/gu, ""); // any letters: ã, é, Hangul, Han
    const n = word ? count(word) : 0;
    let sung: string[];
    if (!word) sung = [];
    else if (n >= 1 && n <= notes.length) sung = [word, ...Array<string>(notes.length - n).fill("~")];
    else sung = notes.map((x, k) => (x.text?.replace(/[^\p{L}']/gu, "") || (k ? "~" : "la")));
    if (!sung.length) {
      ln.notes.push({ midi: null, beats: notes.reduce((b, x) => b + x.beats, 0) }); // a lyric with no letters: silent, in time
      continue;
    }
    ln.lyrics += (ln.lyrics ? " " : "") + sung.join(" ");
    for (const x of notes) ln.notes.push({ midi: x.midi! + shift, beats: x.beats });
  }
  close(evs[evs.length - 1]?.bar ?? 0);
  return lines;
}
