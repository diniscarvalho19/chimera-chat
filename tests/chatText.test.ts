import { expect, test } from "bun:test";
import { blocks, extractSongs, moodBlocks, noteMidi, parseSong, toSpeech } from "../src/ui/chatText.ts";
import { isMood } from "../src/ui/mood.ts";

test("paragraphs split on blank lines, never inside a code fence", () => {
  const t = "Hello there.\n\n```js\nconst a = 1;\n\nconst b = 2;\n```\n\nBye.";
  const b = blocks(t).map((x) => t.slice(x.start, x.end));
  expect(b).toEqual(["Hello there.\n", "```js\nconst a = 1;\n\nconst b = 2;\n```\n", "Bye."]);
});

test("speech drops code and markdown marks", () => {
  expect(toSpeech("```js\nx()\n```\n")).toBe("");
  expect(toSpeech("- See **the [docs](http://x)** for `foo`.")).toBe("See   the docs   for  foo .");
});

test("note names", () => {
  expect([noteMidi("C4"), noteMidi("F#4"), noteMidi("Bb3"), noteMidi("A4"), noteMidi("H2")]).toEqual([60, 66, 58, 69, null]);
});

test("a song: bpm, lines of lyrics | notes with lengths; junk lines and notes are skipped", () => {
  const s = parseSong("bpm 96\nTwin-kle star | C4 C4/0.5 G4/2 X9\nno bar here\n");
  expect(s).toEqual({ bpm: 96, lines: [{ lyrics: "Twin-kle star", notes: [{ midi: 60, beats: 1 }, { midi: 60, beats: 0.5 }, { midi: 67, beats: 2 }] }] });
});

test("a song block shows as its lyrics, in a paragraph of its own", () => {
  const { display, songs } = extractSongs("Here goes:\n```song\nbpm 90\nLa la | C4 D4\n```\nThanks!");
  expect(display).toBe("Here goes:\n\n♪ La la\n\nThanks!");
  expect(songs.length).toBe(1);
  expect(blocks(display).length).toBe(3);
});

test("mood tags: stripped, one per paragraph, carried forward; a tag alone moves to the next paragraph; unknown tags stay", () => {
  const { text, blocks: b } = moodBlocks("[happy] Yay!\n\nStill glad.\n\n[sad]\n\n♪ La la\n\n[angry] grr", isMood);
  expect(text).toBe("Yay!\n\nStill glad.\n\n♪ La la\n\n[angry] grr");
  expect(b.map((x) => [text.slice(x.start, x.end), x.mood])).toEqual([["Yay!", "happy"], ["Still glad.", "happy"], ["♪ La la", "sad"], ["[angry] grr", "sad"]]);
});
