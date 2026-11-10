import { expect, test } from "bun:test";
import { italianSyllables } from "../src/ui/italian.ts";
import { parseSong } from "../src/ui/chatText.ts";

const sung = (t: string) => italianSyllables(t).map((s) => [...s.onset, s.nucleus, ...s.coda].map((g) => g.ipa + (g.stress ? "ˈ" : "")).join("")).join(".");

test("Italian is sung by its spelling: syllables, digraphs, glides, stress", () => {
  expect(sung("cara mia bella")).toBe("kaˈ.ɾa.miˈ.a.beˈl.la");
  expect(sung("addio")).toBe("ad.diˈ.o");
  expect(sung("piano gnocchi figlio")).toBe("pjaˈ.no.ɲoˈk.ki.fiˈ.ʎo");
  expect(sung("ciao chiesa quando")).toBe("tʃaˈ.o.kjeˈ.sa.kwaˈn.do");
  expect(sung("perché pasta terra")).toBe("peɾ.keˈ.paˈ.sta.teˈ.ra");
  const s = italianSyllables("mia ~ ,");
  expect(s.map((x) => x.text)).toEqual(["mia", "~", "~"]);
  expect(s[2].melisma && s[2].phraseEnd).toBe(true);
});

test("a song block in Italian says so", () => {
  expect(parseSong("bpm 80\nlang it\nca-ra mi-a | C4 D4 E4 F4").lang).toBe("it");
  expect(parseSong("bpm 80\nlang pt\nco-ra-ção | C4 D4 E4").lang).toBe("pt");
  expect(parseSong("bpm 80\nhel-lo | C4 D4").lang).toBeUndefined();
});

test("a Portuguese paragraph is told from an English one", async () => {
  const { isPortuguese } = await import("../src/ui/chatText.ts");
  expect(isPortuguese("Olá! Tudo bem com você? Eu estou muito feliz.")).toBe(true);
  expect(isPortuguese("Que saudade da minha cidade.")).toBe(true);
  expect(isPortuguese("Hello! How are you doing today?")).toBe(false);
  expect(isPortuguese("I ordered a coffee at the café in Paris.")).toBe(false);
  expect(isPortuguese("The façade is made of stone and glass.")).toBe(false);
});
