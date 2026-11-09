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

test("asked-for harmony: chord tones under the tune, the same words and rhythm; a third under with no chords", async () => {
  const { harmonize } = await import("../src/ui/song.ts");
  const tune = parseSong("Twin-kle twin-kle lit-tle star | C5 C5 G5 G5 A5 A5 G5/2 | C F C");
  tune.exact = true;
  const [h1, h2] = harmonize(tune);
  expect(h1.song.lines[0].lyrics).toBe(tune.lines[0].lyrics);
  expect(h1.song.lines[0].notes.map((n) => n.beats)).toEqual(tune.lines[0].notes.map((n) => n.beats));
  const pcs = (s: typeof tune) => s.lines[0].notes.map((n) => (n.midi! % 12 + 12) % 12);
  // each note a tone of its chord (C: C E G, F: F A C), below the line above it
  const chord = [[0, 4, 7], [0, 4, 7], [0, 4, 7], [5, 9, 0], [5, 9, 0], [0, 4, 7], [0, 4, 7]];
  expect(pcs(h1.song).every((p, i) => chord[i].includes(p))).toBe(true);
  expect(h1.song.lines[0].notes.every((n, i) => n.midi! < tune.lines[0].notes[i].midi!)).toBe(true);
  expect(h2.song.lines[0].notes.every((n, i) => n.midi! < h1.song.lines[0].notes[i].midi!)).toBe(true);
  // no chords: a third under
  const bare = parseSong("la la | C5 E5");
  expect(harmonize(bare, 1)[0].song.lines[0].notes.map((n) => n.midi)).toEqual([69, 72]); // under E, C: the tune uses it
});

test("a cappella: no band; a bass and a backing voice sing the instruments' lowest and highest notes, in range, in time", async () => {
  const { acappella } = await import("../src/ui/song.ts");
  const tune = parseSong("Twin-kle twin-kle lit-tle star | C5 C5 G5 G5 A5 A5 G5/2 | C F C");
  tune.exact = true;
  // a piano: a low C and a chord over it each two beats, the chord changing
  tune.parts = [0, 2, 4, 6].flatMap((t) => [
    { midi: t < 4 ? 36 : 41, t, beats: 2, vocal: false },
    { midi: t < 4 ? 64 : 65, t, beats: 2, vocal: false },
    { midi: t < 4 ? 67 : 69, t, beats: 2, vocal: false },
  ]);
  const a = acappella(tune);
  expect(a.parts).toEqual([]);
  expect(a.lines.every((l) => l.chords.length === 0)).toBe(true);
  const [bass, backing] = a.voices!;
  expect(bass.name).toBe("Bass");
  // the low notes, an octave up into a bass's range; the chord's top note as it is
  expect(bass.song.lines.flatMap((l) => l.notes.map((n) => n.midi))).toEqual([48, 48, 53, 53]);
  expect(backing.song.lines.flatMap((l) => l.notes.map((n) => n.midi))).toEqual([67, 67, 69, 69]);
  expect(bass.song.lines[0].lyrics).toBe("bom bom bom bom"); // two beats each: long
  // each sung note on its beat: 0, 2, 4, 6
  const n = songNotes(bass.song, 0);
  expect(n.map((_, i) => n.slice(0, i).reduce((s, x) => s + x.beats + x.rest, 0) + n[i].rest)).toEqual([0, 2, 4, 6]);
  // no parts, only chords (the model's own song): the voices come from them
  const own = acappella(parseSong("Twin-kle twin-kle | C4 C4 G4 G4 | C G"));
  expect(own.voices!.map((v) => v.song.lines.flatMap((l) => l.notes.map((x) => x.midi)))).toEqual([[48, 55], [64, 71]]);
});
