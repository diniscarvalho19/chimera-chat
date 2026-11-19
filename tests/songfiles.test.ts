import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { initEngine } from "./harness.ts";

await initEngine();
const { ultraStar, karaoke, chorus } = await import("../src/ui/songfiles.ts");
const { EnglishG2P } = await import("../src/wasm/engine.ts");
new EnglishG2P().setDictionaryText(gunzipSync(readFileSync(new URL("../public/data/cmudict.txt.gz", import.meta.url))).toString());

const notes = (s: { lines: { notes: { midi: number | null; beats: number }[] }[] }) => s.lines.flatMap((l) => l.notes.filter((n) => n.midi !== null).map((n) => [n.midi, n.beats]));

test("UltraStar: words onto notes (a piece after a space starts a word), its beats a quarter of the BPM's, a line break a phrase", () => {
  const txt = ["#TITLE:Test", "#ARTIST:Me", "#BPM:120", "#GAP:0", ": 0 4 5 Hel", ": 4 4 7 lo", ": 8 8 9  world", "- 20", ": 20 4 5 Sing", ": 24 4 5 ~", "E"].join("\n");
  const { title, song } = ultraStar(txt);
  expect(title).toBe("Test - Me");
  expect(song.bpm).toBe(120);
  expect(song.lines.map((l) => l.lyrics.replace(/[ ~,]+/g, " ").trim().toLowerCase())).toEqual(["hello world", "sing"]);
  // pitch 0 is C4 (this tune sits in the voice's range, so it isn't moved); one beat is four of
  // UltraStar's; "~" holds the word before
  expect(notes(song)).toEqual([[65, 1], [67, 1], [69, 2], [65, 1], [65, 1]]);
});

test("UltraStar: a tempo past 200 is halved with the notes' beats, so the seconds stay", () => {
  const { song } = ultraStar(["#BPM:300", ": 0 4 6 la", ": 4 4 6 la", "E"].join("\n"));
  expect(song.bpm).toBe(150);
  expect(notes(song)).toEqual([[66, 0.5], [66, 0.5]]);
});

/** a type-0 MIDI: a tempo, a two-note tune with lyric events, a bass note on another channel */
function midiFile(): Uint8Array {
  const ev: number[] = [];
  const meta = (type: number, data: number[]) => ev.push(0, 0xff, type, data.length, ...data);
  meta(0x51, [0x07, 0xa1, 0x20]); // 500000 us: 120 bpm
  const text = (s: string) => [...s].map((c) => c.charCodeAt(0));
  meta(0x05, text("Hel"));
  ev.push(0, 0x90, 64, 100, 0, 0x91, 40, 100);
  ev.push(0x83, 0x60, 0x80, 64, 0); // 480 ticks later: off
  meta(0x05, text("lo"));
  ev.push(0, 0x90, 67, 100);
  ev.push(0x83, 0x60, 0x80, 67, 0, 0, 0x81, 40, 0);
  ev.push(0, 0xff, 0x2f, 0);
  const head = [0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, 0x01, 0xe0]; // 480 ticks a beat
  const len = ev.length;
  return new Uint8Array([...head, 0x4d, 0x54, 0x72, 0x6b, (len >> 24) & 255, (len >> 16) & 255, (len >> 8) & 255, len & 255, ...ev]);
}

test("karaoke MIDI: the tune is the part under the words, the rest the band", () => {
  const song = karaoke(midiFile());
  expect(song.bpm).toBe(120);
  expect(song.lines[0].lyrics.replace(/[ ~,]+/g, " ").trim().toLowerCase()).toBe("hello");
  expect(notes(song).map((n) => n[1])).toEqual([1, 1]);
  expect(song.parts).toEqual([{ midi: 40, t: 0, beats: 2, vocal: false }]);
});

test("a medley's cut: from the line sung most, about 32 beats, the band cut with it", () => {
  const line = (lyrics: string, t: number) => ({ lyrics, notes: [{ midi: 60, beats: 8 }], chords: [], t });
  const song = {
    bpm: 100,
    lines: ["verse one goes here", "this is the chorus line", "verse two goes here", "this is the chorus line", "the end of the song"].map(line),
    parts: [0, 8, 16, 24, 32, 40].map((t) => ({ midi: 40, t, beats: 8, vocal: false })),
  };
  const c = chorus(song);
  expect(c.lines.map((l) => l.lyrics)).toEqual(["this is the chorus line", "verse two goes here", "this is the chorus line", "the end of the song"]);
  expect(c.parts!.map((p) => p.t)).toEqual([0, 8, 16, 24]);
});
