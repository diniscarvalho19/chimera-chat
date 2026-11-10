/**
 * The songbook: real songs the voice can sing, found by name. public/songs/index.json lists them
 * (built by tools/build-songbook.ts from PDMX, MuseScore scores marked public domain or CC0); each
 * is a MusicXML score (public/songs/<id>.mxl) converted in the browser when it's asked for.
 */
import type { Song } from "./chatText.ts";
import { scoreToSong, scoreXml } from "./musicxml.ts";

export interface SongEntry {
  id: string;
  title: string;
  artist: string;
  /** how many other sung parts it has (a choir's), sung with it by voices of their own */
  voices?: number;
  /** the words' language, when not English */
  lang?: Song["lang"];
  /** added by hand (not from PDMX's build): a well-known song in its language, listed first for it */
  byHand?: boolean;
  /** a piece with no words (a piano piece, a theme), or none that can be sung: its tune sung on "la" */
  instrumental?: boolean;
}

const words = (s: string): string[] =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // accents off
    .replace(/[^a-z0-9' ]+/g, " ")
    .replace(/'/g, "")
    .split(/\s+/)
    .filter((w) => w && !STOP.has(w));
const STOP = new Set(["the", "a", "an", "by", "song", "from", "of"]);

/**
 * The entry that best fits "title", "title - artist" or "title by artist", or null. Every word of
 * the title asked for must be in the entry's title (one may be missing from a long one), and half
 * the entry's title must be asked for ("Happy Birthday" finds "Happy Birthday to You", "Let It Go"
 * doesn't find "Let It Snow"). The artist only settles between matches; the index is most popular
 * first, so a tie goes to the better-known song.
 */
export function findEntry(index: SongEntry[], query: string): SongEntry | null {
  // "title - artist", else "title by artist" at its last "by" (a title may have one: "One by One")
  const m = query.match(/^(.*?)\s+[-–—]\s+(.*)$/) ?? query.match(/^(.*)\s+by\s+(.*)$/i);
  const [rawTitle, artistPart] = m ? [m[1], m[2]] : [query, ""];
  // "Still Alive (Portal)": a bracketed aside names where it's from, not the title
  const titlePart = rawTitle.replace(/\s*[([].*?[)\]]/g, "") || rawTitle;
  const q = words(titlePart), by = new Set(words(artistPart));
  if (!q.length) return null;
  const known = by.size > 0 && index.some((e) => !GENERIC.test(e.artist) && artistName(e.artist).length > 0 && artistName(e.artist).every((w) => by.has(w)));
  let best: SongEntry | null = null, bestScore = 0;
  for (const e of index) {
    const t = new Set(words(e.title));
    const missing = q.filter((w) => !t.has(w)).length;
    const hit = q.length - missing;
    if (missing > (q.length >= 4 ? 1 : 0) || hit / t.size < 0.5) continue;
    // the artist named is one the songbook knows, and this song isn't theirs: not it (a cover of
    // a song by an artist it doesn't know still is)
    if (known && !words(e.artist).some((w) => by.has(w))) continue;
    const score = hit / t.size + words(e.artist).filter((w) => by.has(w)).length;
    if (score > bestScore) [best, bestScore] = [e, score];
  }
  return best;
}

/**
 * The song a message names, if the songbook has it: the title with most words in the message, all
 * of them or its first two or more ("happy birthday" for "Happy Birthday to You"). Only telling
 * words count: "do you know", "can you sing one" name no song; a one-word title only if it's a
 * long word ("home" alone doesn't count), a word said twice once ("Day by Day" is "day"). Its first
 * word alone isn't it ("what's the weather like" doesn't name "The Weather Network Song"). The
 * artist settles a tie.
 */
export function songMentioned(index: SongEntry[], message: string): SongEntry | null {
  const m = new Set(words(message).filter((w) => !COMMON.has(w)));
  let best: SongEntry | null = null, bestScore = 0;
  for (const e of index) {
    const t = [...new Set(words(e.title).filter((w) => !COMMON.has(w)))];
    let lead = 0;
    while (lead < t.length && m.has(t[lead])) lead++;
    const all = t.length > 0 && t.every((w) => m.has(w));
    // all of a title of two words or more (or of one long word); or its first two words
    if (!(all ? t.length > 1 || t[0].length >= 6 : lead >= 2)) continue;
    const score = (all ? t.length : lead) * 10 + words(e.artist).filter((w) => m.has(w)).length;
    if (score > bestScore) [best, bestScore] = [e, score];
  }
  return best;
}

/** words in any request ("can you sing one of them?"): no title is named by them */
const COMMON = new Set(
  "i me my you your we us our it its is are am be was were do does did can could will would should shall may might must have has had to in on at for with about as and or but not no so if this that these those there here what which who how why when where one some any all them they he she his her just very really please sing song songs sang sung know like want let lets get give make say tell something anything everything nothing someone thing".split(" "),
);

/** credits that name no one in particular: a song under them is anyone's */
const GENERIC = /\b(misc|traditional|trad|unknown|anon|anonymous|folk)\b/i;

/** the artist's own name in a credit ("Oasis Arr. Mariette Wilson" → "oasis") */
const artistName = (credit: string): string[] =>
  words(credit.replace(CREDIT_ROLES, "").split(/\s+(?:arr\.?|arranged|feat\.?|ft\.?|&|and|with)\s+/i)[0]);
/** a credit's roles before the name ("Music & Lyrics: Stephen Foster", "Words and Music by …"): not the artist */
const CREDIT_ROLES = /^\s*(?:(?:music|lyrics|words|melody|text|composed|composer|written|arranged|arr\.?)\s*(?:&|and|by|:|,)?\s*)+/i;

/**
 * The artist a message names, if the songbook has songs of theirs, and those songs: every word of
 * the artist's name in the message, one with a word of four letters or more (so "U2" or "Al" alone
 * don't count), the longest name winning. For telling the model what it can sing of theirs; `tunes`
 * are those it has only the tune of (no words, sung on "la").
 */
export function artistMentioned(index: SongEntry[], text: string): { artist: string; titles: string[]; tunes: string[] } | null {
  const m = new Set(words(text));
  const by = new Map<string, { artist: string; titles: string[]; tunes: string[] }>();
  for (const e of index) {
    if (GENERIC.test(e.artist)) continue;
    const name = artistName(e.artist);
    if (!name.length || !name.some((w) => w.length >= 4) || !name.every((w) => m.has(w))) continue;
    const key = name.join(" ");
    const g = by.get(key) ?? { artist: e.artist.split(/\s+arr\.?\s+/i)[0], titles: [], tunes: [] };
    if (g.titles.length < 12) {
      g.titles.push(e.title);
      if (e.instrumental) g.tunes.push(e.title); // only its tune: no words
    }
    by.set(key, g);
  }
  return [...by.entries()].sort((a, b) => b[0].length - a[0].length)[0]?.[1] ?? null;
}

/** a song as the model is told of it: "Title" by Artist, and if it has no words, that it hasn't */
export const songName = (e: SongEntry): string =>
  `"${e.title}"${e.artist && !GENERIC.test(e.artist) ? ` by ${e.artist.split(/\s+arr\.?\s+/i)[0]}` : ""}${e.instrumental ? " (the songbook has only its tune, no words: you sing it on la; say so before singing it)" : ""}`;

/**
 * Songs whose title or artist has a telling word of the message ("christmas", "love", "beatles"),
 * most popular first: for "do you know any christmas songs?".
 */
export function searchSongs(index: SongEntry[], message: string, n = 15): SongEntry[] {
  const q = new Set(words(message).filter((w) => w.length >= 4 && !COMMON.has(w) && !BROWSE.has(w)));
  if (!q.size) return [];
  return index.filter((e) => [...words(e.title), ...words(e.artist)].some((w) => q.has(w))).slice(0, n);
}
/**
 * The language a message asks about ("portuguese music", "sing in italian"), if the songbook has
 * songs in it, and its songs with words, most popular first.
 */
export function languageSongs(index: SongEntry[], message: string, n = 25): { language: string; titles: string[] } | null {
  const lang = words(message).map((w) => LANG_WORDS[w]).find(Boolean);
  if (!lang) return null;
  const songs = index.filter((e) => e.lang === lang && !e.instrumental);
  const titles = [...new Set([...songs.filter((e) => e.byHand), ...songs.filter((e) => !e.byHand)].map((e) => e.title))];
  return { language: lang === "pt" ? "Portuguese" : "Italian", titles: titles.slice(0, n) };
}
/** words naming a language the songbook has songs in */
const LANG_WORDS: Record<string, SongEntry["lang"]> = { portuguese: "pt", brazilian: "pt", brazil: "pt", brasil: "pt", portugal: "pt", italian: "it", italy: "it", italia: "it" };
/** words of asking about the songbook itself, not a topic */
const BROWSE = new Set("list songbook music musics artists artist bands band singers singer choir choirs harmony harmonies voices parts know have sing songs song".split(" "));

/** songs with several singing parts (a choir's), the fullest first, then the most popular */
export const choirSongs = (index: SongEntry[], n = 20): SongEntry[] =>
  index.filter((e) => (e.voices ?? 0) > 0).sort((a, b) => b.voices! - a.voices!).slice(0, n);

/** the songbook in a few words: its size, its artists with the most songs, its best-known songs */
export function songbookOverview(index: SongEntry[]): string {
  const count = new Map<string, number>();
  for (const e of index) if (e.artist && !GENERIC.test(e.artist)) count.set(e.artist.split(/\s+arr\.?\s+/i)[0], (count.get(e.artist.split(/\s+arr\.?\s+/i)[0]) ?? 0) + 1);
  const artists = [...count].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([a, k]) => `${a} (${k})`);
  return `${index.length} songs, ${choirSongs(index, Infinity).length} of them with choir parts. Artists with the most: ${artists.join(", ")}. Some of the best known: ${index.slice(0, 15).map(songName).join(", ")}`;
}

let index: Promise<SongEntry[]> | null = null;
const base = () => `${import.meta.env?.BASE_URL ?? "/"}songs/`;
/** the songbook's list (fetched once, the first time it's needed) */
export const songbook = (): Promise<SongEntry[]> => (index ??= fetch(`${base()}index.json`).then((r) => (r.ok ? r.json() : [])));

/**
 * The song a song-ref block asks for, sung from its score; null if the songbook hasn't got it. Its
 * first line names the song; a line "excerpt" after it sings only its first 4 bars (a song the model
 * sings unasked), else it's sung whole.
 */
export async function findSong(query: string): Promise<{ entry: SongEntry; song: Song } | null> {
  const [name, ...rest] = query.trim().split("\n");
  const maxBars = rest.some((l) => /^\s*excerpt\s*$/i.test(l)) ? 4 : Infinity;
  const entry = findEntry(await songbook(), name);
  if (!entry) return null;
  const r = await fetch(`${base()}${entry.id}.mxl`);
  if (!r.ok) return null;
  try {
    return { entry, song: scoreToSong(await scoreXml(new Uint8Array(await r.arrayBuffer())), { maxBars, lang: entry.lang, instrumental: entry.instrumental }) };
  } catch (e) {
    console.warn("songbook:", entry.title, e);
    return null;
  }
}
