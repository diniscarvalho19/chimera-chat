/**
 * Builds the songbook (public/songs/: index.json and one .mxl score per song) from PDMX, the
 * MuseScore scores marked public domain or CC0 (zenodo.org/records/15571083, CC BY 4.0).
 *
 *   bun tools/build-songbook.ts <candidates.json> <pdmx root> [max songs] [--instrumental]
 *
 * candidates.json: PDMX.csv's rows to try, most viewed first, as [{mxl, song_name, title,
 * artist_name, composer_name}]
 * (`mxl` is the score's path in mxl.tar.gz, relative to <pdmx root>). Each is kept only if the
 * browser's converter (src/ui/musicxml.ts) sings at least two lines of it and its words are a
 * language the voice sings: English (nine in ten words in the English dictionary), or Italian or
 * Portuguese (by their commonest words, told apart from Spanish, French, German and Latin). Of a song's scores (same
 * title and artist) the fullest is kept: the most choir parts, then the most viewed. Needs `bun run wasm`.
 *
 * --instrumental: the candidates are sung as pieces with no words (their tune on "la"): instrumentals,
 * and scores whose words can't be sung (another language, or not words at all); they replace
 * the songbook's instrumentals and keep everything else, leaving out a piece whose title is already
 * a song's (its words are better). A pass of songs with words keeps the instrumentals.
 */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { gunzipSync } from "node:zlib";
import { initChimera } from "../src/wasm/chimera.ts";

const instrumental = process.argv.includes("--instrumental");
const [candidatesPath, root, maxArg] = process.argv.slice(2).filter((a) => a !== "--instrumental");
if (!candidatesPath || !root) throw new Error("usage: bun tools/build-songbook.ts <candidates.json> <pdmx root> [max songs] [--instrumental]");
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
const index: { id: string; title: string; artist: string; voices?: number; lang?: "it" | "pt"; instrumental?: true }[] = [];
// the songbook as it is: what this pass doesn't rebuild is kept
let before: { id: string; title: string; lang?: string; instrumental?: boolean; byHand?: boolean }[] = [];
try {
  before = JSON.parse(readFileSync(join(out, "index.json"), "utf8"));
} catch {
  // no songbook yet
}
// a pass of songs with words keeps the instrumentals and the songs added by hand (marked byHand),
// and replaces the rest; an instrumental pass keeps the songs. A title a kept song has isn't added again
const kept = before.filter((e) => (instrumental ? !e.instrumental : e.instrumental || e.byHand));
const keptTitles = new Set(kept.filter((e) => !e.instrumental).map((e) => e.title.toLowerCase()));
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
  if (keptTitles.has(title.toLowerCase())) {
    skip("already a song with words");
    continue;
  }
  const key = `${title}|${artist}`.toLowerCase();
  songs.set(key, [...(songs.get(key) ?? []), c]);
}

// each language's commonest words: a song is Italian or Portuguese if its words are mostly theirs
const MARKERS: Record<string, Set<string>> = Object.fromEntries(
  Object.entries({
    it: "il che di non gli della del sono per mi ti io ma questo questa nel alla cuore amore più perché cosa sei ho hai ci anche lo è mia mio bella sempre addio ancor",
    pt: "não você do da os das dos em um uma meu minha eu é com mais coração pra sou vou nos seu sua ao também deus jesus senhor",
    es: "el los las y yo es por pero muy está con una corazón porque del qué más mí también señor dios tú eres pueblo ti",
    fr: "le les et je est une des pas dans pour qui mon vous nous avec sur au ce du",
    de: "der die und das ist ich nicht ein eine du mit zu den dem auf sich wir",
    la: "et in est ad cum dei domine deus gloria sanctus nobis qui quae ave te mea pater dominus christe eleison domino dominum panis angelicus sancta agnus kyrie spiritus sepulto mundi",
  }).map(([k, v]) => [k, new Set(v.split(" "))]),
);
const SOLFEGE = /^((d[oó]|r[eé]|mi|f[aá]|sol|la|si|ti)(b|#|s|d|is|es)?|[a-h](b|#|s|is|es)?)$/; // or letters: "E D E D E B D C A"
/** sung sounds, not words: a backing line's "oo"s say nothing of the language */
const VOCABLES = /^(o+h?|a+h?|u+h?|m+|hm+|la|na|da|doo|ooh|whoa|yeah|hey|ha)$/;
/**
 * The words' language: "en" if four in five are in the English dictionary (a split word, "ne ver",
 * isn't) and no other language's common words are among the rest; else the one whose common words
 * they mostly are.
 */
function language(all: string[]): string | null {
  const words = all.filter((w) => !VOCABLES.test(w));
  if (!words.length) return null;
  // a solfège exercise's "words" are its notes' names (do re mi, or E D C): its tune is an instrumental's
  if (words.filter((w) => SOLFEGE.test(w)).length >= 0.5 * words.length) return "solfège";
  const foreign = words.filter((w) => !english.has(w) && Object.values(MARKERS).some((m) => m.has(w))).length;
  if (words.filter((w) => english.has(w)).length >= 0.8 * words.length && foreign < 0.1 * words.length) return "en";
  const score = Object.entries(MARKERS)
    .map(([k, m]) => [k, words.filter((w) => m.has(w)).length / words.length + (k === "pt" ? 0.05 * +/ão|õe|ç/.test(words.join(" ")) : 0)] as const)
    .sort((a, b) => b[1] - a[1]);
  const [[best, s1], [, s2]] = score;
  return s1 >= 0.18 && s1 >= 2 * s2 ? best : null;
}

/** a score's choir parts and its words' language ("it", "pt"; none for English), or null if the converter can't sing it */
async function voicesOf(path: string): Promise<{ voices: number; lang?: "it" | "pt" } | null> {
  let bytes: Uint8Array;
  try {
    bytes = readFileSync(path);
  } catch {
    skip("not extracted");
    return null;
  }
  try {
    const song = scoreToSong(await scoreXml(bytes), { instrumental });
    const words = song.lines.flatMap((l) => l.lyrics.toLowerCase().split(/\s+/)).filter((w) => w !== "~" && w);
    if (song.lines.length < 2) return skip("under two lines"), null;
    const voices = song.voices?.length ?? 0;
    if (instrumental) return { voices };
    const lang = language(words);
    if (lang !== "en" && lang !== "it" && lang !== "pt") return skip(`not sung: ${lang ?? "unknown"}`), null;
    return lang === "en" ? { voices } : { voices, lang };
  } catch {
    skip("converter failed");
    return null;
  }
}

// of a song's scores, the fullest (the most choir parts); of those, the most viewed. The song
// sits where its first score the converter sings is (the most viewed of those)
const picked: { at: number; c: (typeof candidates)[number]; voices: number; lang?: "it" | "pt" }[] = [];
const at = new Map(candidates.map((c, i) => [c, i]));
for (const scores of songs.values()) {
  let best: (typeof picked)[number] | null = null;
  for (const c of scores) {
    const got = await voicesOf(join(root, c.mxl));
    if (got === null) continue;
    if (!best) best = { at: at.get(c)!, c, ...got };
    else if (got.voices > best.voices) best = { ...best, c, ...got };
  }
  if (best) picked.push(best);
}
for (const { c, voices, lang } of picked.sort((a, b) => a.at - b.at).slice(0, max)) {
  const id = basename(c.mxl, ".mxl").slice(0, 16);
  copyFileSync(join(root, c.mxl), join(out, `${id}.mxl`));
  // voices: how many other sung parts it has (a choir's), for telling the model what it can sing
  index.push({ id, title: tidy(c.song_name) || tidy(c.title), artist: tidy(c.artist_name) || tidy(c.composer_name), ...(voices ? { voices } : {}), ...(lang ? { lang } : {}), ...(instrumental ? { instrumental: true as const } : {}) });
}
// the other pass's songs kept: the songs with words first (most popular first), then the instrumentals
const ids = new Set(index.map((e) => e.id));
const rest = kept.filter((e) => !ids.has(e.id));
writeFileSync(join(out, "index.json"), JSON.stringify(instrumental ? [...rest, ...index] : [...index, ...rest]));
console.log(`${index.length} songs; skipped:`, Object.fromEntries(why));
