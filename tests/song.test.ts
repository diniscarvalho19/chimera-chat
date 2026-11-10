import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { initEngine } from "./harness.ts";
import { parseSong } from "../src/ui/chatText.ts";

await initEngine();
const { songNotes } = await import("../src/ui/song.ts");
const { EnglishG2P } = await import("../src/wasm/engine.ts");
new EnglishG2P().setDictionaryText(gunzipSync(readFileSync(new URL("../public/data/cmudict.txt.gz", import.meta.url))).toString());

const ipa = (n: { syl: { onset: { ipa: string }[]; nucleus: { ipa: string }; coda: { ipa: string }[] } }) => [...n.syl.onset, n.syl.nucleus, ...n.syl.coda].map((s) => s.ipa).join("");

test("hyphenated lyrics are sung as the dictionary's words (ge-cko is not 'cko')", () => {
  const n = songNotes(parseSong("Lit-tle ge-cko | C4 D4 E4 F4/2"), 0);
  expect(n.map(ipa)).toEqual(["lɪ", "təl", "gɛ", "koʊ"]);
});

test("one note per syllable: extra notes dropped, missing ones walk back and forth through the line's", () => {
  expect(songNotes(parseSong("lit-tle ge-cko | C4 G4"), 0).map((n) => n.midi)).toEqual([60, 67, 60, 67]);
  expect(songNotes(parseSong("lit-tle ge-cko on | C4 E4 G4"), 0).map((n) => n.midi)).toEqual([60, 64, 67, 64, 60]);
  const many = songNotes(parseSong("star | E4 F4 G4"), -12);
  expect(many.map((n) => n.midi)).toEqual([52]);
  expect(many[0].syl.phraseEnd).toBe(true);
});

test("a line with no rhythm of its own gets one from the stress: long stressed, short unstressed, the end held", () => {
  // LIT-tle GECK-o on the WALL, all written as one beat
  const n = songNotes(parseSong("Little gecko on the wall | C4 C4 D4 E4 E4 D4 C4"), 0);
  expect(n.map((x) => x.beats)).toEqual([1, 0.5, 1, 0.5, 1, 0.5, 2]);
});

test("a line that has its own rhythm keeps it", () => {
  expect(songNotes(parseSong("Twin-kle star | C4/0.5 C4/1.5 G4/2"), 0).map((n) => n.beats)).toEqual([0.5, 1.5, 2]);
});

test("rests take no syllable: their beats sit before the next sung note, across lines too", () => {
  const n = songNotes(parseSong("star | R/0.5 E4/2 R/2\nshine | G4/2"), 0);
  expect(n.map((x) => [x.midi, x.rest])).toEqual([[64, 0.5], [67, 2]]);
});

test("a cappella: no band, no voices added; a beatboxer only where the score had drums or one is asked for", async () => {
  const { acappella } = await import("../src/ui/song.ts");
  const tune = parseSong("Twin-kle twin-kle lit-tle star | C5 C5 G5 G5 A5 A5 G5/2 | C F C");
  tune.parts = [{ midi: 36, t: 0, beats: 2, vocal: false }, { midi: 64, t: 0, beats: 2, vocal: true }];
  const a = acappella(tune);
  expect(a.parts).toEqual([{ midi: 64, t: 0, beats: 2, vocal: true }]); // the score's own sung part stays
  expect(a.voices).toBeUndefined();
  expect(a.lines.every((l) => l.chords.length === 0)).toBe(true);
  expect(a.beatbox).toBe(false);
  expect(acappella({ ...tune, drums: true }).beatbox).toBe(true);
  expect(acappella(tune, true).beatbox).toBe(true);
});

test("the most voices asked for: every line doubled at the octave, across the female/male split", async () => {
  const { ensemble } = await import("../src/ui/song.ts");
  const line = (midi: number) => ({ lyrics: "la la", notes: [{ midi, beats: 1 }, { midi: null, beats: 1 }], chords: [[0, 4, 7]] });
  const song = { bpm: 100, exact: true, lines: [line(64)], voices: [{ name: "Alto", song: { bpm: 100, lines: [line(60)] } }, { name: "Bass", song: { bpm: 100, lines: [line(48)] } }] };
  const e = ensemble(song);
  expect(e.voices!.map((v) => v.name)).toEqual(["Alto", "Bass", "Lead", "Alto", "Bass"]); // the score's own first
  expect(e.voices!.map((v) => v.song.lines[0].notes[0].midi)).toEqual([60, 48, 52, 48, 60]);
  expect(e.voices![2].song.lines[0].notes[1].midi).toBeNull(); // rests stay rests
  expect(e.voices![2].song.lines[0].chords).toEqual([]); // a double plays no band
  expect(e.lines).toBe(song.lines); // the lead itself unchanged
});
