import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { initEngine } from "./harness.ts";

await initEngine();
const { scoreToSong, scoreXml } = await import("../src/ui/musicxml.ts");
const { songNotes } = await import("../src/ui/song.ts");
const { EnglishG2P } = await import("../src/wasm/engine.ts");
new EnglishG2P().setDictionaryText(gunzipSync(readFileSync(new URL("../public/data/cmudict.txt.gz", import.meta.url))).toString());

const note = (step: string, oct: number, dur: number, o: { lyric?: string; syl?: string; tie?: string; voice?: number; verse2?: string } = {}) =>
  `<note><pitch><step>${step}</step><octave>${oct}</octave></pitch><duration>${dur}</duration><voice>${o.voice ?? 1}</voice>${o.tie ? `<tie type="${o.tie}"/>` : ""}${
    o.lyric ? `<lyric number="1"><syllabic>${o.syl ?? "single"}</syllabic><text>${o.lyric}</text></lyric>` : ""
  }${o.verse2 ? `<lyric number="2"><syllabic>single</syllabic><text>${o.verse2}</text></lyric>` : ""}</note>`;
const rest = (dur: number) => `<note><rest/><duration>${dur}</duration><voice>1</voice></note>`;

// bar 1: an intro rest; bars 2-3 repeated, verse 1 then 2; bar 4: "to-ge-ther" (one word, three
// notes) then a held note, a tie, and a second voice that must not be sung
const bass = (step: string, oct: number, dur: number) => `<note><pitch><step>${step}</step><octave>${oct}</octave></pitch><duration>${dur}</duration><voice>1</voice></note>`;
const PIANO = `<part id="P2">
<measure number="1"><attributes><divisions>2</divisions></attributes>${bass("G", 2, 8)}</measure>
<measure number="2"><barline location="left"><repeat direction="forward"/></barline>${bass("C", 3, 8)}</measure>
<measure number="3">${bass("A", 2, 8)}<barline location="right"><repeat direction="backward"/></barline></measure>
<measure number="4">${bass("F", 2, 8)}</measure>
<measure number="5">${bass("G", 2, 4)}</measure>
<measure number="6">${bass("C", 3, 8)}</measure>
</part>`;
const XML = `<score-partwise><part-list><score-part id="P1"><part-name>Voice</part-name></score-part><score-part id="P2"><part-name>Piano</part-name></score-part></part-list>
<part id="P1">
<measure number="1"><attributes><divisions>2</divisions></attributes><sound tempo="90"/>${rest(8)}</measure>
<measure number="2"><barline location="left"><repeat direction="forward"/></barline>
  <harmony><root><root-step>C</root-step></root><kind>major</kind></harmony>
  ${note("C", 5, 2, { lyric: "sing", verse2: "dance" })}${note("D", 5, 2, { lyric: "with" })}${note("E", 5, 4, { lyric: "me" })}</measure>
<measure number="3"><harmony><root><root-step>A</root-step></root><kind>minor</kind></harmony>
  ${note("G", 5, 8, { lyric: "now," })}<barline location="right"><repeat direction="backward"/></barline></measure>
<measure number="4">${note("C", 5, 2, { lyric: "to", syl: "begin" })}${note("D", 5, 2, { lyric: "ge", syl: "middle" })}${note("E", 5, 2, { lyric: "ther", syl: "end" })}${note("D", 5, 2)}
  <backup><duration>8</duration></backup>${note("C", 4, 8, { voice: 2, lyric: "hum" })}</measure>
<measure number="5">${note("C", 5, 4, { lyric: "home", tie: "start" })}</measure>
<measure number="6">${note("C", 5, 4, { tie: "stop" })}${rest(4)}</measure>
</part>${PIANO}</score-partwise>`;

test("a score's sung melody: repeats with their verses, whole words, holds, ties, chords, one voice, moved into range", async () => {
  const song = scoreToSong(await scoreXml(new TextEncoder().encode(XML)));
  expect(song.bpm).toBe(90);
  expect(song.exact).toBe(true);
  const lyrics = song.lines.map((l) => l.lyrics).join(" / ");
  expect(lyrics).toBe("sing with me now / dance with me now / together ~ home");
  // C5 and up sung an octave down (the median goes between C4 and B4); the tie is one 4-beat note
  const n = songNotes(song, 0);
  expect(n.map((x) => x.midi)).toEqual([60, 62, 64, 67, 60, 62, 64, 67, 60, 62, 64, 62, 60]);
  expect(n.map((x) => x.beats)).toEqual([1, 1, 2, 4, 1, 1, 2, 4, 1, 1, 1, 1, 4]);
  expect(song.lines[0].chords).toEqual([[0, 4, 7], [9, 0, 4]]);
});

test("the other parts (and the sung part's other voice, as an ooh) play under the excerpt in time: the intro left out, the repeat played twice, the end cut where the singing ends", async () => {
  const song = scoreToSong(await scoreXml(new TextEncoder().encode(XML)));
  expect(song.parts?.map((n) => [n.midi, n.t, n.beats, n.vocal])).toEqual([
    [48, 0, 4, false], [45, 4, 4, false], [48, 8, 4, false], [45, 12, 4, false], [60, 16, 4, true], [41, 16, 4, false], [43, 20, 2, false], [48, 22, 2, false],
  ]);
  // the voice's own timeline lands on the same beats: "together" starts the fifth bar sung, at 16
  const n = songNotes(song, 0);
  const at = n.map((_, i) => n.slice(0, i).reduce((s, x) => s + x.beats + x.rest, 0) + n[i].rest);
  expect(at[8]).toBe(16);
  expect(at[12]).toBe(20);
});

test("an .mxl (a zip) is opened in the browser's way, with the container naming the score", async () => {
  // a stored (uncompressed) zip with the container and the score
  const files: [string, string][] = [["META-INF/container.xml", `<container><rootfiles><rootfile full-path="s.xml"/></rootfiles></container>`], ["s.xml", XML]];
  const enc = new TextEncoder(), parts: Uint8Array<ArrayBuffer>[] = [], central: Uint8Array<ArrayBuffer>[] = [];
  let off = 0;
  for (const [name, text] of files) {
    const n = enc.encode(name), d = enc.encode(text);
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true);
    h.setUint32(18, d.length, true);
    h.setUint32(22, d.length, true);
    h.setUint16(26, n.length, true);
    parts.push(new Uint8Array(h.buffer), n, d);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true);
    c.setUint32(20, d.length, true);
    c.setUint32(24, d.length, true);
    c.setUint16(28, n.length, true);
    c.setUint32(42, off, true);
    central.push(new Uint8Array(c.buffer), n);
    off += 30 + n.length + d.length;
  }
  const cdSize = central.reduce((s, x) => s + x.length, 0);
  const e = new DataView(new ArrayBuffer(22));
  e.setUint32(0, 0x06054b50, true);
  e.setUint16(10, files.length, true);
  e.setUint32(12, cdSize, true);
  e.setUint32(16, off, true);
  const zip = new Uint8Array(await new Blob([...parts, ...central, new Uint8Array(e.buffer)]).arrayBuffer());
  expect(scoreToSong(await scoreXml(zip)).lines[0].lyrics).toBe("sing with me now");
});
