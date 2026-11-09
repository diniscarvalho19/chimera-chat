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
 * words are in the English dictionary (the voice only speaks English). Needs `bun run wasm`.
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
const seen = new Set<string>();
const why = new Map<string, number>();
const skip = (reason: string) => why.set(reason, (why.get(reason) ?? 0) + 1);
const tidy = (s: string) => (s === "NA" ? "" : s.trim());

for (const c of candidates) {
  if (index.length >= max) break;
  const title = tidy(c.song_name) || tidy(c.title), artist = tidy(c.artist_name) || tidy(c.composer_name);
  const key = `${title}|${artist}`.toLowerCase();
  if (!title || seen.has(key)) {
    skip("no title or a repeat");
    continue;
  }
  const path = join(root, c.mxl);
  let bytes: Uint8Array;
  try {
    bytes = readFileSync(path);
  } catch {
    skip("not extracted");
    continue;
  }
  let voices = 0;
  try {
    const song = scoreToSong(await scoreXml(bytes));
    voices = song.voices?.length ?? 0;
    const words = song.lines.flatMap((l) => l.lyrics.toLowerCase().split(/\s+/)).filter((w) => w !== "~" && w);
    if (song.lines.length < 2) {
      skip("under two lines");
      continue;
    }
    if (words.filter((w) => english.has(w)).length < 0.9 * words.length) {
      skip("not English");
      continue;
    }
  } catch {
    skip("converter failed");
    continue;
  }
  seen.add(key);
  const id = basename(c.mxl, ".mxl").slice(0, 16);
  copyFileSync(path, join(out, `${id}.mxl`));
  // voices: how many other sung parts it has (a choir's), for telling the model what it can sing
  index.push({ id, title, artist, ...(voices ? { voices } : {}) });
}
writeFileSync(join(out, "index.json"), JSON.stringify(index));
console.log(`${index.length} songs; skipped:`, Object.fromEntries(why));
