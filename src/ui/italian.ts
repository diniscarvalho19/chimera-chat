/**
 * Italian lyrics → sung syllables, by spelling (Italian is written as it sounds), for the engine's
 * IPA inventory. The same shape as the engine's English `lyricsToSyllables`: "~" holds the last
 * vowel, punctuation ends a phrase.
 *
 * Stress: an accented vowel (città, perché), else the one before last. i/u next to a vowel glide
 * (piano → pja-no, uomo → wo-mo) unless stressed (mi-a, ad-di-o).
 * e/o are closed (e, o) unless accented è/ò; s is s, z is ts.
 */
import type { Segment, Syllable } from "../wasm/types.ts";

const VOWEL = /[aeiouàèéìíòóùú]/;
const PLAIN: Record<string, string> = { à: "a", è: "ɛ", é: "e", ì: "i", í: "i", ò: "ɔ", ó: "o", ù: "u", ú: "u" };
const FRONT = /[eièéìí]/;

/** one word's sounds: IPA symbols, the vowels' indices, and which is stressed */
function wordSounds(word: string): { ipa: string[]; vowels: number[]; stressed: number } {
  const w = word.toLowerCase().replace(/[^a-zàèéìíòóùú]/g, "");
  const ipa: string[] = [], vowels: number[] = [];
  let accented = -1;
  const push = (s: string) => ipa.push(s);
  for (let i = 0; i < w.length; i++) {
    const c = w[i], n = w[i + 1] ?? "", n2 = w[i + 2] ?? "";
    if (VOWEL.test(c)) {
      if (PLAIN[c]) accented = vowels.length;
      vowels.push(ipa.length);
      push(PLAIN[c] ?? c);
      continue;
    }
    switch (c) {
      case "h":
        break; // silent (ch, gh handled below)
      case "c":
        if (n === "h") { push("k"); i++; }
        else if (n === "i" && VOWEL.test(n2)) { push("tʃ"); i++; } // cia, cio: the i is only spelling
        else if (FRONT.test(n)) push("tʃ");
        else if (n === "c" && FRONT.test(n2)) { push("t"); } // ccia: a long tʃ
        else push("k");
        break;
      case "g":
        if (n === "h") { push("g"); i++; }
        else if (n === "n") { push("ɲ"); i++; }
        else if (n === "l" && n2 === "i") { push("ʎ"); i += VOWEL.test(w[i + 3] ?? "") ? 2 : 1; } // gli: the i stays only at the end
        else if (n === "i" && VOWEL.test(n2)) { push("dʒ"); i++; }
        else if (FRONT.test(n)) push("dʒ");
        else if (n === "g" && FRONT.test(n2)) push("d");
        else push("g");
        break;
      case "s":
        if (n === "c" && n2 === "i" && VOWEL.test(w[i + 3] ?? "")) { push("ʃ"); i += 2; }
        else if (n === "c" && FRONT.test(n2)) { push("ʃ"); i++; }
        else push(/[bdgvmnlr]/.test(n) ? "z" : "s");
        break;
      case "q":
        push("k");
        if (n === "u") { push("w"); i++; }
        break;
      case "z":
        push(n === "z" ? "t" : "ts");
        break;
      case "r":
        if (n === "r") { push("r"); i++; } // rolled; a single r is tapped
        else push("ɾ");
        break;
      case "j":
        push("j");
        break;
      case "x":
        push("k");
        push("s");
        break;
      case "y":
        vowels.push(ipa.length);
        push("i");
        break;
      case "w":
        push("w");
        break;
      case "k":
        push("k");
        break;
      default:
        push(c); // b d f l m n p t v
    }
  }
  // i/u beside another vowel glides (pjano, wɔmo, maj) unless stressed (mi-a, ad-di-o, Di-o)
  const stress = accented >= 0 ? accented : Math.max(0, vowels.length - 2);
  const keep: number[] = [];
  let stressed = 0;
  vowels.forEach((at, k) => {
    const s = ipa[at], beside = vowels[k - 1] === at - 1 || vowels[k + 1] === at + 1;
    if ((s === "i" || s === "u") && beside && k !== stress) ipa[at] = s === "i" ? "j" : "w";
    else {
      if (k === stress) stressed = keep.length;
      keep.push(at);
    }
  });
  return { ipa, vowels: keep, stressed };
}

const STOPS = /^(p|b|t|d|k|g|f|v)$/, LIQUIDS = /^(ɾ|r|l)$/;

/** Italian lyrics → sung syllables (see the module comment) */
export function italianSyllables(text: string): Syllable[] {
  const out: Syllable[] = [];
  for (const tok of text.replace(/’/g, "'").match(/~|[.,!?;:]|[^\s~.,!?;:]+/g) ?? []) {
    if (/^[.,!?;:]$/.test(tok)) {
      if (out.length) out[out.length - 1].phraseEnd = true;
      continue;
    }
    if (tok === "~") {
      const prev = out[out.length - 1];
      if (prev) out.push({ text: "~", onset: [], nucleus: prev.nucleus, coda: [], melisma: true, wordEnd: prev.wordEnd, phraseEnd: false });
      continue;
    }
    // an elision ("l'amore", "dov'è") sings as one word
    const { ipa, vowels, stressed } = wordSounds(tok.replace(/-/g, ""));
    if (!vowels.length) continue;
    const seg = (s: string): Segment => ({ ipa: s, stress: 0 });
    const syls: Syllable[] = vowels.map((at, k) => ({ text: k ? "~" : tok, onset: [], nucleus: { ipa: ipa[at], stress: k === stressed ? 1 : 0 }, coda: [], wordEnd: false, phraseEnd: false }));
    syls[0].onset = ipa.slice(0, vowels[0]).map(seg);
    for (let k = 1; k < vowels.length; k++) {
      // the consonants between two vowels: one starts the next syllable, and so do s + consonant
      // (pa-sta) and a stop or f/v + liquid (ca-pra); else the first ends this one (bel-la, can-to)
      const between = ipa.slice(vowels[k - 1] + 1, vowels[k]);
      let split = between.length <= 1 ? 0 : 1;
      if (between.length === 2 && STOPS.test(between[0]) && LIQUIDS.test(between[1])) split = 0;
      if (between.length >= 2 && between[0] === "s" && between[1] !== "s") split = 0;
      syls[k - 1].coda = between.slice(0, split).map(seg);
      syls[k].onset = between.slice(split).map(seg);
    }
    syls[syls.length - 1].coda = ipa.slice(vowels[vowels.length - 1] + 1).map(seg);
    syls[syls.length - 1].wordEnd = true;
    out.push(...syls);
  }
  return out;
}
