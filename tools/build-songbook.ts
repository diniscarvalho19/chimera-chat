/**
 * Builds the songbook (public/songs/: index.json and one .mxl score per song) from PDMX, the
 * MuseScore scores marked public domain or CC0 (zenodo.org/records/15571083, CC BY 4.0).
 *
 *   bun tools/build-songbook.ts <candidates.json> <pdmx root> [max songs]
 *
 * candidates.json: PDMX.csv's rows to try, most viewed first, as [{mxl, song_name, title,
 * artist_name, composer_name}]
 * (`mxl` is the score's path in mxl.tar.gz, relative to <pdmx root>). Each is kept only if the
 * browser's converter (src/ui/musicxml.ts) sings at least two lines of it and nine in ten of its
 * words are in the English dictionary (the voice only speaks English). Of a song's scores (same
 * title and artist) the fullest is kept: the most choir parts, then the most viewed. Needs `bun run wasm`.
 */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { gunzipSync } from "node:zlib";
import { initChimera } from "../src/wasm/chimera.ts";

const [candidatesPath, root, maxArg] = process.argv.slice(2);
if (!candidatesPath || !root) throw new Error("usage: bun tools/build-songbook.ts <candidates.json> <pdmx root> [max songs]");
const max = Number(maxArg ?? 1500);

await initChimera(readFileSync(new URL("../src/wasm/chimera.wasm", import.meta.url)));
const { EnglishG2P } = await import("../src/wasm/engine.ts");
const { scoreToSong, scoreXml } = await import("../src/ui/musicxml.ts");
const dict = gunzipSync(readFileSync(new URL("../public/data/cmudict.txt.gz", import.meta.url))).toString();
new EnglishG2P().setDictionaryText(dict);
const english = new Set(dict.split("\n").map((l) => l.split(/\s/)[0].replace(/\(\d+\)$/, "").toLowerCase()));

const out = new URL("../public/songs/", import.meta.url).pathname;
mkdirSync(out, { recursive: true });
const candidates: { mxl: string; song_name: string; title: string; artist_name: string; composer_name: string }[] = JSON.parse(readFileSync(candidatesPath, "utf8"));
const index: { id: string; title: string; artist: string; voices?: number }[] = [];
const why = new Map<string, number>();
const skip = (reason: string) => why.set(reason, (why.get(reason) ?? 0) + 1);
const tidy = (s: string) => (s === "NA" ? "" : s.trim());

// a song's scores, by title and artist, in the order the first of each appears (the most viewed)
const songs = new Map<string, typeof candidates>();
for (const c of candidates) {
  const title = tidy(c.song_name) || tidy(c.title), artist = tidy(c.artist_name) || tidy(c.composer_name);
  if (!title) {
    skip("no title");
    continue;
  }
  const key = `${title}|${artist}`.toLowerCase();
  songs.set(key, [...(songs.get(key) ?? []), c]);
}

/** a score's choir parts, or null if the converter can't sing it */
async function voicesOf(path: string): Promise<number | null> {
  let bytes: Uint8Array;
  try {
    bytes = readFileSync(path);
  } catch {
    skip("not extracted");
    return null;
  }
  try {
    const song = scoreToSong(await scoreXml(bytes));
    const words = song.lines.flatMap((l) => l.lyrics.toLowerCase().split(/\s+/)).filter((w) => w !== "~" && w);
    if (song.lines.length < 2) return skip("under two lines"), null;
    if (words.filter((w) => english.has(w)).length < 0.9 * words.length) return skip("not English"), null;
    return song.voices?.length ?? 0;
  } catch {
    skip("converter failed");
    return null;
  }
}

// of a song's scores, the fullest (the most choir parts); of those, the most viewed. The song
// sits where its first score the converter sings is (the most viewed of those)
const picked: { at: number; c: (typeof candidates)[number]; voices: number }[] = [];
for (const scores of songs.values()) {
  let best: (typeof picked)[number] | null = null;
  for (const c of scores) {
    const voices = await voicesOf(join(root, c.mxl));
    if (voices === null) continue;
    if (!best) best = { at: candidates.indexOf(c), c, voices };
    else if (voices > best.voices) best = { ...best, c, voices };
  }
  if (best) picked.push(best);
}
for (const { c, voices } of picked.sort((a, b) => a.at - b.at).slice(0, max)) {
  const id = basename(c.mxl, ".mxl").slice(0, 16);
  copyFileSync(join(root, c.mxl), join(out, `${id}.mxl`));
  // voices: how many other sung parts it has (a choir's), for telling the model what it can sing
  index.push({ id, title: tidy(c.song_name) || tidy(c.title), artist: tidy(c.artist_name) || tidy(c.composer_name), ...(voices ? { voices } : {}) });
}
// songs in other languages (Italian, Portuguese) were added apart from this English pass: kept
let before: { id: string; lang?: string }[] = [];
try {
  before = JSON.parse(readFileSync(join(out, "index.json"), "utf8"));
} catch {
  // no songbook yet
}
const ids = new Set(index.map((e) => e.id));
index.push(...before.filter((e) => e.lang && !ids.has(e.id)));
writeFileSync(join(out, "index.json"), JSON.stringify(index));
console.log(`${index.length} songs; skipped:`, Object.fromEntries(why));
