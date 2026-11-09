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

test("one note per syllable: extra notes dropped, missing ones repeat the line's last", () => {
  expect(songNotes(parseSong("lit-tle ge-cko | C4 G4"), 0).map((n) => n.midi)).toEqual([60, 67, 67, 67]);
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
