import { expect, test } from "bun:test";
import { initEngine } from "./harness.ts";
import { extractSongs, songRefs, type Song } from "../src/ui/chatText.ts";

await initEngine();
const { findEntry } = await import("../src/ui/songbook.ts");

const index = [
  { id: "a", title: "Happy Birthday to You", artist: "Misc Traditional" },
  { id: "b", title: "Hallelujah", artist: "Leonard Cohen" },
  { id: "c", title: "Hallelujah", artist: "George Frideric Handel" },
  { id: "d", title: "you are my sunshine", artist: "Jimmie Davis" },
  { id: "e", title: "let it snow", artist: "Frank Sinatra" },
];

test("a song is found by its title, most of it, and the artist settles a tie", () => {
  expect(findEntry(index, "Happy Birthday")?.id).toBe("a");
  expect(findEntry(index, "You Are My Sunshine - Jimmie Davis")?.id).toBe("d");
  expect(findEntry(index, "Hallelujah by Handel")?.id).toBe("c");
  expect(findEntry(index, "Hallelujah")?.id).toBe("b"); // the more popular (first)
  expect(findEntry(index, "Bohemian Rhapsody - Queen")).toBeNull();
  expect(findEntry(index, "Let It Go - Frozen")).toBeNull(); // not "Let It Snow"
  expect(findEntry(index, "Let It Snow by Dean Martin")?.id).toBe("e"); // a cover: the songbook doesn't know Dean Martin
});

test("a song asked for by name: listed, then sung if found, said so if not", () => {
  const reply = "[happy] Here it is!\n\n```song-ref\nYou Are My Sunshine - Jimmie Davis\n```\n\n```song-ref\nNope - Nobody\n```";
  expect(songRefs(reply)).toEqual(["You Are My Sunshine - Jimmie Davis", "Nope - Nobody"]);
  const song: Song = { bpm: 90, exact: true, lines: [{ lyrics: "you are my sun shine ~", notes: [], chords: [] }] };
  const { display, songs } = extractSongs(reply, new Map([["You Are My Sunshine - Jimmie Davis", song], ["Nope - Nobody", null]]));
  expect(songs).toEqual([song]);
  expect(display).toBe("[happy] Here it is!\n\n♪ you are my sun shine\n\nI couldn't find the music for Nope.");
});

test("a chord sheet written outside a block isn't read out; prose, moods and songs stay", () => {
  const reply = [
    "[happy] Here it is! A song with a chorus, as you asked.",
    "",
    "(Verse 1)         Em  C  G  D",
    "Some made-up words here | Em C G D",
    "[Chorus]",
    "Am Em C G",
    "",
    "Hope you liked it.",
  ].join("\n");
  expect(extractSongs(reply).display).toBe("[happy] Here it is! A song with a chorus, as you asked.\n\nHope you liked it.");
});

test("the song a message names is found in it, short common titles aside", async () => {
  const { songMentioned } = await import("../src/ui/songbook.ts");
  const idx = [...index, { id: "f", title: "Home", artist: "Someone" }, { id: "g", title: "Clocks", artist: "Coldplay" }];
  expect(songMentioned(idx, "can you sing coldplay clocks?")?.id).toBe("g");
  expect(songMentioned(idx, "sing you are my sunshine please")?.id).toBe("d");
  expect(songMentioned(idx, "sing me happy birthday!")?.id).toBe("a");
  expect(songMentioned(idx, "sing me a song about going home")).toBeNull(); // "home": too short to count alone
});

test("a song asked for by name is the song: one the model wrote beside it is dropped", () => {
  const reply = "Sure!\n\n```song-ref\nClocks - Coldplay\n```\n\n```song\nbpm 90\nTick tick | C4 C4\n```";
  const { display, songs } = extractSongs(reply, new Map([["Clocks - Coldplay", null]]));
  expect(songs).toEqual([]);
  expect(display).toBe("Sure!\n\nI couldn't find the music for Clocks.");
});

test("an artist named: their songs listed; another's song with a title they never sang isn't theirs", async () => {
  const { artistMentioned } = await import("../src/ui/songbook.ts");
  const idx = [
    { id: "a", title: "Fix You", artist: "Coldplay" },
    { id: "b", title: "One by One", artist: "Warren Someone" },
    { id: "c", title: "Wonderwall by Oasis", artist: "Oasis Arr. Mariette Wilson" },
    { id: "d", title: "Amazing Grace", artist: "Misc Praise Songs" },
  ];
  expect(artistMentioned(idx, "do you know any coldplay songs?")).toEqual({ artist: "Coldplay", titles: ["Fix You"] });
  expect(artistMentioned(idx, "sing something by oasis")?.titles).toEqual(["Wonderwall by Oasis"]);
  expect(artistMentioned(idx, "sing me a song")).toBeNull();
  expect(findEntry(idx, "One By One - Coldplay")).toBeNull();
  expect(findEntry(idx, "One By One")?.id).toBe("b");
  expect(findEntry(idx, "Amazing Grace - John Newton")?.id).toBe("d"); // a generic credit is anyone's
});
