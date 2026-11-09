import { expect, test } from "bun:test";
import { initEngine } from "./harness.ts";
import { parseSong } from "../src/ui/chatText.ts";

await initEngine();
const { songNotes } = await import("../src/ui/song.ts");

test("one note per syllable: extra notes dropped, missing ones repeat the line's last", () => {
  const few = songNotes(parseSong("Twin-kle twin-kle | C4 G4"), 0);
  expect(few.map((n) => n.syl.text.toLowerCase())).toEqual(["twin", "kle", "twin", "kle"]);
  expect(few.map((n) => n.midi)).toEqual([60, 67, 67, 67]);
  const many = songNotes(parseSong("star | E4 F4 G4"), -12);
  expect(many.map((n) => n.midi)).toEqual([52]);
  expect(many[0].syl.phraseEnd).toBe(true);
});
