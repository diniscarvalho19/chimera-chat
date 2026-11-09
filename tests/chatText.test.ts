import { expect, test } from "bun:test";
import { blocks, extractSongs, moodBlocks, noteMidi, parseSong, toSpeech } from "../src/ui/chatText.ts";
import { isMood, moodOf } from "../src/ui/mood.ts";

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
  expect(s).toEqual({ bpm: 96, lines: [{ lyrics: "Twin-kle star", notes: [{ midi: 60, beats: 1 }, { midi: 60, beats: 0.5 }, { midi: 67, beats: 2 }], chords: [] }] });
});

test("a song block shows as its lyrics, in a paragraph of its own", () => {
  const { display, songs } = extractSongs("Here goes:\n```song\nbpm 90\nLa la | C4 D4\n```\nThanks!");
  expect(display).toBe("Here goes:\n\n♪ La la\n\nThanks!");
  expect(songs.length).toBe(1);
  expect(blocks(display).length).toBe(3);
});

test("mood tags: stripped, one per paragraph, carried forward; a tag alone moves to the next paragraph; other stage directions dropped", () => {
  const { text, blocks: b } = moodBlocks("[happy] Yay!\n\nStill glad.\n\n[sad]\n\n♪ La la\n\n[angry] grr\n\nA [Link] stays.", isMood);
  expect(text).toBe("Yay!\n\nStill glad.\n\n♪ La la\n\ngrr\n\nA [Link] stays.");
  expect(b.map((x) => [text.slice(x.start, x.end), x.mood])).toEqual([["Yay!", "happy"], ["Still glad.", "happy"], ["♪ La la", "sad"], ["grr", "sad"], ["A [Link] stays.", "sad"]]);
});

test("a tag near a mood's name is that mood: [interested] is curious", () => {
  const { text, blocks: b } = moodBlocks("Think about choirs. [interested] Queen layered theirs.", moodOf);
  expect(text).toBe("Think about choirs. Queen layered theirs.");
  expect(b.map((x) => x.mood)).toEqual(["neutral", "curious"]);
});

test("mood tags anywhere: a tag sets the mood of what follows; a trailing one is its paragraph's; closing tags dropped", () => {
  const { text, blocks: b } = moodBlocks("Hi there! [happy]\n\nI love it. [sad] But it ends. [/sad]\n\n[excited]Yes! [concerned]", isMood);
  expect(text).toBe("Hi there!\n\nI love it. But it ends.\n\nYes!");
  expect(b.map((x) => [text.slice(x.start, x.end), x.mood])).toEqual([["Hi there!", "happy"], ["I love it.", "happy"], ["But it ends.", "sad"], ["Yes!", "excited"]]);
});

test("a model's sloppy notes still sing: commas, hyphens, ♯, and no octave (nearest the last note)", () => {
  const midis = (l: string) => parseSong(l).lines[0].notes.map((n) => n.midi);
  expect(midis("Hel-lo my friend | C E G E/2")).toEqual([60, 64, 67, 64]);
  expect(midis("Hel-lo my friend | C4, E4, G4, E4/2")).toEqual([60, 64, 67, 64]);
  expect(midis("Hel-lo my friend | C♯4-E4-G4-R-E4")).toEqual([61, 64, 67, null, 64]);
  expect(midis("Up and down | A4 C B G")).toEqual([69, 72, 71, 67]);
});

test("a song line's chords: after a second bar, as pitch classes root first; junk skipped", () => {
  const s = parseSong("To-day | C4 D4/2 | Em G7 D/F# Xyz Cadd9");
  expect(s.lines[0].chords).toEqual([[4, 7, 11], [7, 11, 2, 5], [2, 6, 9], [0, 4, 7, 2]]);
  expect(s.lines[0].notes).toHaveLength(2);
});

test("a line of notes with no words is sung on 'la', not the note names", () => {
  const s = parseSong("♪ C4 C4 G4/2 R/1\nA4 B4 | Em G");
  expect(s.lines.map((l) => [l.lyrics, l.notes.length, l.chords.length])).toEqual([["la la la", 4, 0], ["la la", 2, 2]]);
});
