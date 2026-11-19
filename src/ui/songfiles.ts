/**
 * Songs from the visitor's own files, sung in their browser and never uploaded: MusicXML (.mxl,
 * .musicxml, .xml, the songbook's own format), UltraStar karaoke (.txt) and karaoke MIDI (.kar,
 * .mid with lyrics). And a medley's cut of a song: its chorus.
 */
import type { Song } from "./chatText.ts";
import { eventsToSong, scoreToSong, scoreXml, type Ev } from "./musicxml.ts";

export const SONG_FILES = ".mxl,.musicxml,.xml,.txt,.kar,.mid,.midi";

/** A song file → its title and the song; throws with a reason the visitor can read. */
export async function songFromFile(file: File): Promise<{ title: string; song: Song }> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const name = file.name.replace(/\.[^.]+$/, "");
  const ext = file.name.split(".").pop()!.toLowerCase();
  if (ext === "txt") return ultraStar(decode(bytes), name);
  if (ext === "kar" || ext === "mid" || ext === "midi") return { title: name, song: karaoke(bytes) };
  const xml = await scoreXml(bytes);
  const title = /<work-title>([^<]*)/.exec(xml)?.[1] || /<movement-title>([^<]*)/.exec(xml)?.[1] || name;
  return { title, song: scoreToSong(xml) };
}

/** UTF-8, or Windows-1252 (many karaoke files) when it isn't */
function decode(b: Uint8Array): string {
  const s = new TextDecoder().decode(b);
  return s.includes("�") ? new TextDecoder("windows-1252").decode(b) : s;
}

/** seconds kept, the tempo moved by octaves into 50-200 */
function tempo(bpm: number, evs: Ev[], parts: { t: number; beats: number }[] = []): number {
  let k = 1;
  while (bpm * k > 200) k /= 2;
  while (bpm * k < 50) k *= 2;
  for (const x of [...evs, ...parts]) {
    x.t *= k;
    x.beats *= k;
  }
  for (const e of evs) e.bar = Math.floor(e.t / 4);
  return bpm * k;
}

/**
 * Notes with their pieces of words → events: rests between, each piece's place in its word
 * (a piece starts a word after a space, or a line break), a line break ending the phrase.
 */
function events(notes: { t: number; beats: number; midi: number; text: string; br: boolean }[]): Ev[] {
  const evs: Ev[] = [];
  const sung = notes.filter((n) => n.text.trim() && n.text.trim() !== "~");
  const starts = sung.map((n, i) => i === 0 || n.br || /^\s/.test(n.text) || /\s$/.test(sung[i - 1].text));
  let at = notes[0]?.t ?? 0;
  for (const n of notes) {
    if (n.t > at + 1e-6) evs.push({ t: at, midi: null, beats: n.t - at, bar: 0 });
    const i = sung.indexOf(n);
    const e: Ev = { t: n.t, midi: n.midi, beats: n.beats, bar: 0 };
    if (i >= 0) {
      const begins = starts[i], ends = i === sung.length - 1 || starts[i + 1];
      // a line break after it: the phrase ends here
      const next = notes[notes.indexOf(n) + 1];
      e.text = n.text.trim().replace(/^-|-$/g, "") + (next?.br && !/[,.;:!?]$/.test(n.text.trim()) ? "," : "");
      e.syllabic = begins && ends ? "single" : begins ? "begin" : ends ? "end" : "middle";
    }
    evs.push(e);
    at = Math.max(at, n.t + n.beats);
  }
  return evs;
}

/**
 * UltraStar: "#BPM:" (a beat is a quarter of it), then ": start length pitch text" a note (pitch 0
 * is C4; "*" golden, "F" spoken, "R"/"G" rap: all sung), "- start" a line break, "E" the end.
 * A duet's second singer ("P2") is left out.
 */
// ponytail: a duet sings its first part only; the second as a choir head if duets are wanted
export function ultraStar(text: string, name = "Song"): { title: string; song: Song } {
  const head: Record<string, string> = {};
  const notes: { t: number; beats: number; midi: number; text: string; br: boolean }[] = [];
  let off = 0, br = false, started = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/^﻿/, "");
    if (line.startsWith("#")) {
      const i = line.indexOf(":");
      if (i > 0) head[line.slice(1, i).trim().toUpperCase()] = line.slice(i + 1).trim();
      continue;
    }
    if (/^E\b/.test(line) || (started && /^P\s*[2-9]/.test(line))) break;
    if (/^P\s*1/.test(line)) started = true;
    if (line.startsWith("-")) {
      const [a, b] = line.slice(1).trim().split(/\s+/).map(Number);
      if (/yes/i.test(head.RELATIVE ?? "")) off += (b ?? a) || 0;
      br = true;
      continue;
    }
    const m = /^([:*FRG])\s+(-?\d+)\s+(\d+)\s+(-?\d+)\s?(.*)$/.exec(line);
    if (!m) continue;
    notes.push({ t: (off + Number(m[2])) / 4, beats: Number(m[3]) / 4, midi: 60 + Number(m[4]), text: m[5], br });
    br = false;
  }
  const bpm = Number((head.BPM ?? "").replace(",", "."));
  if (!notes.length || !bpm) throw new Error("it isn't an UltraStar song (no #BPM or no notes)");
  notes.sort((a, b) => a.t - b.t);
  const evs = events(notes);
  const song = eventsToSong(evs, tempo(bpm, evs));
  const title = [head.TITLE, head.ARTIST].filter(Boolean).join(" - ") || name;
  return { title, song };
}

/**
 * Karaoke MIDI: the tune is the part whose notes start where the words do (lyric events, or a
 * .kar's text events: "\" a new verse, "/" a new line, "@" its header), the other parts are the
 * band (channel 10's are drums). The first tempo holds.
 */
// ponytail: one tempo for the whole song; follow tempo changes if a file drifts out of time
export function karaoke(bytes: Uint8Array): Song {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const str = (at: number, n: number) => new TextDecoder("windows-1252").decode(bytes.subarray(at, at + n));
  if (str(0, 4) !== "MThd") throw new Error("it isn't a MIDI file");
  const ntracks = dv.getUint16(10), div = dv.getUint16(12);
  if (div & 0x8000) throw new Error("its timing (SMPTE) isn't supported");
  type N = { tick: number; end: number; midi: number; key: string };
  const notes: N[] = [];
  const lyrics: { tick: number; text: string }[] = [], texts: { tick: number; text: string }[] = [];
  let usPerBeat = 500000, tempoSet = false;
  let p = 8 + dv.getUint32(4);
  for (let tr = 0; tr < ntracks && p + 8 <= bytes.length; tr++) {
    const len = dv.getUint32(p + 4), end = p + 8 + len;
    if (str(p, 4) !== "MTrk") break;
    p += 8;
    let tick = 0, status = 0;
    const open = new Map<string, N[]>();
    const vlq = () => {
      let v = 0, b;
      do {
        b = bytes[p++];
        v = (v << 7) | (b & 0x7f);
      } while (b & 0x80 && p < end);
      return v;
    };
    while (p < end) {
      tick += vlq();
      let s = bytes[p];
      if (s & 0x80) p++;
      else s = status; // running status
      if (s === 0xff) {
        const type = bytes[p++], n = vlq();
        if (type === 0x51 && !tempoSet) {
          usPerBeat = (bytes[p] << 16) | (bytes[p + 1] << 8) | bytes[p + 2];
          tempoSet = true;
        } else if (type === 0x05) lyrics.push({ tick, text: str(p, n) });
        else if (type === 0x01) texts.push({ tick, text: str(p, n) });
        p += n;
      } else if (s === 0xf0 || s === 0xf7) p += vlq();
      else {
        status = s;
        const kind = s & 0xf0, ch = s & 0x0f, a = bytes[p], b = bytes[p + 1];
        p += kind === 0xc0 || kind === 0xd0 ? 1 : 2;
        const key = `${tr}:${ch}:${a}`;
        if (kind === 0x90 && b > 0) {
          const n = { tick, end: tick, midi: a, key: `${tr}:${ch}` };
          notes.push(n);
          open.set(key, [...(open.get(key) ?? []), n]);
        } else if (kind === 0x80 || (kind === 0x90 && b === 0)) {
          const n = open.get(key)?.shift();
          if (n) n.end = tick;
        }
      }
    }
    p = end;
  }
  // the words: lyric events, or a .kar's text events (not its "@" header lines), whichever has more
  const kar = texts.filter((t) => !t.text.startsWith("@"));
  const words = (lyrics.length >= kar.length ? lyrics : kar).filter((w) => w.text.trim() || /[\\/]/.test(w.text));
  if (!words.length) throw new Error("it has no lyrics in it");
  // the tune: the part whose notes start on the words' ticks
  const near = div / 8;
  const parts = new Map<string, N[]>();
  for (const n of notes) if (!n.key.endsWith(":9")) parts.set(n.key, [...(parts.get(n.key) ?? []), n]);
  let tune: N[] = [], best = -1;
  for (const ns of parts.values()) {
    const hits = words.filter((w) => ns.some((n) => Math.abs(n.tick - w.tick) <= near)).length;
    if (hits > best) [best, tune] = [hits, ns];
  }
  // one note at a time: the highest at an onset, each cut at the next
  const onsets = [...new Map(tune.map((n) => [n.tick, n])).keys()].sort((a, b) => a - b);
  const line = onsets.map((t) => tune.filter((n) => n.tick === t).reduce((a, b) => (b.midi > a.midi ? b : a)));
  const sungNotes = line.map((n, i) => {
    const w = words.filter((x) => Math.abs(x.tick - n.tick) <= near);
    const raw = w.map((x) => x.text).join("");
    const br = /^[\\/\r\n]/.test(raw);
    const end = Math.min(n.end > n.tick ? n.end : n.tick + div / 2, line[i + 1]?.tick ?? Infinity);
    return { t: n.tick / div, beats: (end - n.tick) / div, midi: n.midi, text: raw.replace(/[\\/\r\n]/g, ""), br };
  });
  // a line break written on the next piece's own event, before any note
  for (const w of words) if (/[\\/]/.test(w.text) && !line.some((n) => Math.abs(n.tick - w.tick) <= near)) {
    const next = sungNotes.find((n) => n.t * div > w.tick);
    if (next) next.br = true;
  }
  const evs = events(sungNotes);
  const band = notes.filter((n) => !tune.includes(n) && !n.key.endsWith(":9")).map((n) => ({ midi: n.midi, t: n.tick / div, beats: Math.max(1, n.end - n.tick) / div, vocal: false }));
  band.sort((a, b) => a.t - b.t);
  const bpm = tempo(60e6 / usPerBeat, evs, band);
  return eventsToSong(evs, bpm, { parts: band, drums: notes.some((n) => n.key.endsWith(":9")) });
}

/**
 * A song's chorus for a medley: from the first time its most repeated line comes, else the first
 * line with a word of its title in it (the hook), else its start; about `beats` long, the band cut
 * with it; no choir (each would need cutting too).
 */
export function chorus(song: Song, title = "", beats = 32): Song {
  const starts: number[] = [];
  let t = 0;
  for (const l of song.lines) {
    starts.push(t);
    t += l.notes.reduce((s, n) => s + n.beats, 0);
  }
  const key = (s: string) => s.toLowerCase().replace(/[^\p{L}]+/gu, " ").trim();
  const seen = new Map<string, number[]>();
  song.lines.forEach((l, i) => {
    const k = key(l.lyrics);
    if (k.length >= 8) seen.set(k, [...(seen.get(k) ?? []), i]);
  });
  let from = 0, most = 1;
  for (const is of seen.values()) if (is.length > most) [most, from] = [is.length, is[0]];
  const named = key(title).split(" ").filter((w) => w.length >= 4);
  if (most === 1 && named.length) from = Math.max(0, song.lines.findIndex((l) => named.some((w) => key(l.lyrics).split(" ").includes(w))));
  let to = from + 1;
  while (to < song.lines.length && starts[to] - starts[from] < beats) to++;
  const a = starts[from], b = starts[to] ?? t;
  const parts = song.parts?.filter((p) => p.t >= a - 1e-6 && p.t < b).map((p) => ({ ...p, t: p.t - a, beats: Math.min(p.beats, b - p.t) }));
  const meter = song.meter && { ...song.meter, at: (song.meter.at + a) % song.meter.beats };
  return { ...song, lines: song.lines.slice(from, to), parts, voices: undefined, meter };
}
