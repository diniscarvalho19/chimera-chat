//! Offline Brazilian Portuguese letter-to-sound front end.
use super::{Segment, Syllable, Phrase, Intonation, syllables::{English, FrontEnd, WordSource}};
use std::collections::HashMap;

#[derive(Clone, Debug, Default)]
pub struct PortugueseG2P { dict: HashMap<String, String> }

fn vowel(c: char) -> bool { "aeiouáéíóúâêôãõü".contains(c) }

impl PortugueseG2P {
    pub fn new() -> Self { Self::default() }
    /// Optional offline overrides: one word, tab, IPA per line.
    pub fn load_dict(&mut self, text: &str) {
        for line in text.lines() {
            if let Some((word, ipa)) = line.split_once('\t') {
                self.dict.insert(word.trim().to_lowercase(), ipa.trim().to_owned());
            }
        }
    }
    pub fn word(&self, word: &str, _reduce: bool) -> Vec<Segment> {
        let lower = word.to_lowercase();
        if let Some(ipa) = self.dict.get(&lower) { return super::ipa::tokenize_ipa(ipa); }
        let cs: Vec<char> = lower.chars().collect();
        let nuclei: Vec<usize> = cs.iter().enumerate().filter(|(_, c)| vowel(**c)).map(|(i, _)| i).collect();
        let stress = nuclei.iter().copied().find(|&i| "áéíóúâêôãõ".contains(cs[i])).or_else(|| {
            let penultimate = lower.ends_with(['a','e','o']) || lower.ends_with("as") || lower.ends_with("es") || lower.ends_with("os");
            nuclei.get(nuclei.len().saturating_sub(if penultimate {2} else {1})).copied()
        });
        let mut out = Vec::new();
        let mut i = 0;
        while i < cs.len() {
            let c = cs[i];
            let next = cs.get(i+1).copied().unwrap_or(' ');
            let prev = i.checked_sub(1).map(|j| cs[j]).unwrap_or(' ');
            // Silent u in que/qui/gue/gui; it is not a sung vowel nucleus.
            if c == 'u' && matches!(prev, 'q' | 'g') && "eiéêí".contains(next) { i += 1; continue; }
            let final_vowel = i+1 == cs.len() || (i+2 == cs.len() && next == 's');
            let weak = stress != Some(i);
            if c == 'ã' && next == 'o' {
                let mut s = Segment::new("ɐ̃w̃");
                s.stress = Some(if weak { 0 } else { 1 });
                out.push(s);
                i += 2;
                continue;
            }
            let pair = match (c,next) { ('n','h') => Some("ɲ"), ('l','h') => Some("ʎ"), ('c','h') => Some("ʃ"), ('r','r') => Some("ʁ"), ('s','s') => Some("s"), _ => None };
            let phone = if let Some(p) = pair { i += 1; p } else { match c {
                'a' | 'á' => if weak && final_vowel {"ɐ"} else {"a"}, 'â' => "ɐ", 'ã' => "ã", 'õ' => "õ",
                'e' => if weak && final_vowel {"i"} else {"e"}, 'é' => "ɛ", 'ê' => "e",
                'o' => if weak && final_vowel {"u"} else {"o"}, 'ó' => "ɔ", 'ô' => "o",
                'i' | 'í' => "i", 'u' | 'ú' | 'ü' => "u",
                't' | 'd' if matches!(next, 'i' | 'í') || (next == 'e' && (i+2 == cs.len() || (i+3 == cs.len() && cs.last() == Some(&'s')))) => if c == 't' {"tʃ"} else {"dʒ"},
                'c' => if "eiéêí".contains(next) {"s"} else {"k"}, 'ç' => "s",
                'g' => if "eiéêí".contains(next) {"ʒ"} else {"g"}, 'j' => "ʒ", 'q' => "k",
                'r' => if i == 0 || !vowel(next) || matches!(prev, 'n' | 's' | 'l') {"ʁ"} else {"ɾ"},
                'l' => if !vowel(next) {"w"} else {"l"},
                's' => if vowel(prev) && vowel(next) {"z"} else {"s"},
                'x' => "ʃ", 'z' => "z", 'p' => "p", 'b' => "b", 't' => "t", 'd' => "d",
                'f' => "f", 'v' => "v", 'm' => "m", 'n' => "n", 'k' => "k", 'w' => "w", 'y' => "j", _ => "",
            }};
            if !phone.is_empty() { let mut s = Segment::new(phone); if vowel(c) {s.stress = Some(if stress == Some(i) {1} else {0});} out.push(s); }
            // Falling oral diphthongs end in a glide, not a second sung nucleus.
            if matches!(c, 'a' | 'e' | 'o' | 'é' | 'ó') && matches!(next, 'i' | 'u')
                && (i + 2 == cs.len() || cs.get(i + 2) == Some(&'s')) {
                out.push(Segment::new(if next == 'i' { "j" } else { "w" }));
                i += 1;
            }
            i += 1;
        }
        out
    }
    pub fn to_phrases(&self, text: &str) -> Vec<Phrase> {
        let mut out = Vec::new();
        for part in super::english::split_keeping(text, super::english::is_phrase_punct) {
            if part.chars().all(super::english::is_phrase_punct) {
                if let Some(p) = out.last_mut() { let p: &mut Phrase = p; p.pause = 0.35; if part.contains('?') { p.intonation = Intonation::Question; } }
                continue;
            }
            let words: Vec<String> = part.split(|c: char| !c.is_alphabetic()).filter(|w| !w.is_empty()).map(str::to_owned).collect();
            let mut segments = Vec::new();
            for w in &words { let mut s = self.word(w, true); if let Some(last) = s.last_mut() {last.word_end = Some(true);} segments.extend(s); }
            if !segments.is_empty() {out.push(Phrase {segments, words, pause: 0.3, intonation: Intonation::Statement});}
        }
        out
    }
}
impl WordSource for PortugueseG2P {
    fn word(&self, w: &str, reduce: bool) -> Vec<Segment> { self.word(w, reduce) }
}

/// Portuguese lyrics as a front end: words in any letters (ã, ç, é), read by [`PortugueseG2P`] and
/// split into syllables as English's are. The router picks front ends by script, so Portuguese is
/// asked for by name (`lyricsToSyllablesPt`), not found in the text.
pub struct PortugueseLyrics<'a>(pub &'a PortugueseG2P);

impl FrontEnd for PortugueseLyrics<'_> {
    fn starts(&self, c: char) -> bool {
        c.is_alphabetic() || c == '\''
    }
    fn continues(&self, c: char) -> bool {
        self.starts(c) || c == '-'
    }
    fn word(&self, word: &str) -> Vec<Syllable> {
        English(self.0).word(word)
    }
}
