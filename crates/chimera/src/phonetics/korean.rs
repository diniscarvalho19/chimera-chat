//! Hangul lyrics → sung syllables. Each Hangul block is one sung syllable, so a block maps to one
//! note. The block keeps its spelling as the note's text; its sounds follow standard Seoul
//! pronunciation inside a word: a coda moves onto a following silent ㅇ (먹어 → 머거), codas
//! neutralise to seven sounds, obstruents nasalise before nasals (국물 → 궁물), ㄴ/ㄹ meet as [ll],
//! ㅎ aspirates its neighbour (좋다 → 조타), and obstruents tense after an obstruent coda.
//!
//! Stops say their own aspiration (Segment::aspirated): aspirated ㅋ ㅌ ㅍ ㅊ are aspirated, and
//! tense ㄲ ㄸ ㅃ ㅉ are voiceless and unaspirated (the engine has no stiff "fortis" phonation yet).
//! Lax stops keep the planner's default: aspirated word-initially, voiced between voiced sounds.
//! ㅈ ㅊ ㅉ are alveolo-palatal [tɕ], and ㅅ ㅆ before [i] or [j] are [ɕ].

use super::syllables::FrontEnd;
use super::{Segment, Syllable};

const BASE: u32 = 0xAC00;

pub fn is_hangul(c: char) -> bool {
    ('\u{AC00}'..='\u{D7A3}').contains(&c)
}

/// Initial consonants in Unicode order. 'ㅇ' as an initial is silent.
const INITIALS: [char; 19] = ['ㄱ', 'ㄲ', 'ㄴ', 'ㄷ', 'ㄸ', 'ㄹ', 'ㅁ', 'ㅂ', 'ㅃ', 'ㅅ', 'ㅆ', 'ㅇ', 'ㅈ', 'ㅉ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ'];

/// Medial vowels in Unicode order as (glide, vowel).
const MEDIALS: [(&str, &str); 21] = [
    ("", "a"), ("", "ɛ"), ("j", "a"), ("j", "ɛ"), ("", "ʌ"), ("", "e"), ("j", "ʌ"), ("j", "e"), // ㅏㅐㅑㅒㅓㅔㅕㅖ
    ("", "o"), ("w", "a"), ("w", "ɛ"), ("w", "e"), ("j", "o"), // ㅗㅘㅙㅚㅛ
    ("", "u"), ("w", "ʌ"), ("w", "e"), ("w", "i"), ("j", "u"), // ㅜㅝㅞㅟㅠ
    ("", "ɯ"), ("ɰ", "i"), ("", "i"), // ㅡㅢㅣ
];

/// Final consonants in Unicode order, as one or two letters ("" is no coda).
const FINALS: [&str; 28] = [
    "", "ㄱ", "ㄲ", "ㄱㅅ", "ㄴ", "ㄴㅈ", "ㄴㅎ", "ㄷ", "ㄹ", "ㄹㄱ", "ㄹㅁ", "ㄹㅂ", "ㄹㅅ", "ㄹㅌ", "ㄹㅍ", "ㄹㅎ",
    "ㅁ", "ㅂ", "ㅂㅅ", "ㅅ", "ㅆ", "ㅇ", "ㅈ", "ㅊ", "ㅋ", "ㅌ", "ㅍ", "ㅎ",
];

/// One block with its letters, rewritten in place by the sound rules.
struct Block {
    text: char,
    /// None: silent ㅇ
    onset: Option<char>,
    glide: &'static str,
    vowel: &'static str,
    coda: Vec<char>,
}

fn decompose(c: char) -> Block {
    let i = c as u32 - BASE;
    let (cho, jung, jong) = ((i / 588) as usize, ((i % 588) / 28) as usize, (i % 28) as usize);
    let onset = Some(INITIALS[cho]).filter(|&o| o != 'ㅇ');
    let (glide, vowel) = MEDIALS[jung];
    Block { text: c, onset, glide, vowel, coda: FINALS[jong].chars().collect() }
}

/// A coda's sound once it can't move on: one of ㄱ ㄴ ㄷ ㄹ ㅁ ㅂ ㅇ.
fn neutral(c: char) -> char {
    match c {
        'ㄱ' | 'ㄲ' | 'ㅋ' => 'ㄱ',
        'ㄷ' | 'ㅅ' | 'ㅆ' | 'ㅈ' | 'ㅊ' | 'ㅌ' | 'ㅎ' => 'ㄷ',
        'ㅂ' | 'ㅍ' => 'ㅂ',
        other => other,
    }
}

/// Which letter of a two-letter coda sounds when nothing follows to take the other.
fn simplify(coda: &[char]) -> Option<char> {
    match coda {
        [] => None,
        [c] => Some(*c),
        ['ㄹ', b @ ('ㄱ' | 'ㅁ' | 'ㅍ')] => Some(*b),
        [a, _] => Some(*a),
        _ => unreachable!("codas have at most two letters"),
    }
}

fn aspirated(c: char) -> Option<char> {
    Some(match c {
        'ㄱ' => 'ㅋ',
        'ㄷ' => 'ㅌ',
        'ㅂ' => 'ㅍ',
        'ㅈ' => 'ㅊ',
        _ => return None,
    })
}

fn tense(c: char) -> char {
    match c {
        'ㄱ' => 'ㄲ',
        'ㄷ' => 'ㄸ',
        'ㅂ' => 'ㅃ',
        'ㅅ' => 'ㅆ',
        'ㅈ' => 'ㅉ',
        other => other,
    }
}

/// Apply the sound rules at the boundary between block `a` and the next block `b`.
fn join(a: &mut Block, b: &mut Block) {
    // a coda before a silent ㅇ moves over (ㅎ drops, ㅇ stays: 좋아 → 조아, 빵야 → 빵야)
    if b.onset.is_none() {
        match a.coda.last() {
            Some('ㅎ') => {
                a.coda.pop();
            }
            Some('ㅇ') | None => {}
            Some(_) => b.onset = a.coda.pop(),
        }
        return;
    }
    // ㅎ meets a stop or affricate: one aspirated consonant (좋다 → 조타, 축하 → 추카)
    if a.coda.last() == Some(&'ㅎ') {
        a.coda.pop();
        let o = b.onset.unwrap();
        b.onset = Some(match o {
            'ㅅ' => 'ㅆ',
            'ㄴ' => {
                a.coda = vec!['ㄴ'];
                'ㄴ'
            }
            _ => aspirated(o).unwrap_or(o),
        });
        if a.coda.is_empty() {
            return;
        }
    }
    let Some(c) = simplify(&a.coda).map(neutral) else { return };
    a.coda = vec![c];
    let o = b.onset.unwrap();
    if o == 'ㅎ' && matches!(c, 'ㄱ' | 'ㄷ' | 'ㅂ') {
        a.coda.clear();
        b.onset = aspirated(c);
        return;
    }
    // ㄹ after any coda but ㄴ/ㄹ reads ㄴ (국립 → 궁닙); ㄴ and ㄹ together read [ll] (신라 → 실라)
    let o = match (c, o) {
        ('ㄹ', 'ㄴ') | ('ㄴ', 'ㄹ') => {
            a.coda = vec!['ㄹ'];
            'ㄹ'
        }
        (_, 'ㄹ') if c != 'ㄹ' => 'ㄴ',
        _ => o,
    };
    b.onset = Some(o);
    // obstruent codas nasalise before nasals, and tense the obstruent after them
    if matches!(c, 'ㄱ' | 'ㄷ' | 'ㅂ') {
        if matches!(o, 'ㄴ' | 'ㅁ') {
            a.coda = vec![match c {
                'ㄱ' => 'ㅇ',
                'ㄷ' => 'ㄴ',
                _ => 'ㅁ',
            }];
        } else {
            b.onset = Some(tense(o));
        }
    }
}

/// An initial's sound, and its aspiration when the letter decides it (None: the planner's default).
fn onset_ipa(o: char, voiced_before: bool, front: bool, after_l: bool) -> (&'static str, Option<bool>) {
    match o {
        'ㄱ' if voiced_before => ("g", None),
        'ㄱ' => ("k", None),
        'ㅋ' => ("k", Some(true)),
        'ㄲ' => ("k", Some(false)),
        'ㄷ' if voiced_before => ("d", None),
        'ㄷ' => ("t", None),
        'ㅌ' => ("t", Some(true)),
        'ㄸ' => ("t", Some(false)),
        'ㅂ' if voiced_before => ("b", None),
        'ㅂ' => ("p", None),
        'ㅍ' => ("p", Some(true)),
        'ㅃ' => ("p", Some(false)),
        'ㅈ' if voiced_before => ("dʑ", None),
        'ㅈ' => ("tɕ", None),
        'ㅊ' => ("tɕ", Some(true)),
        'ㅉ' => ("tɕ", Some(false)),
        'ㅅ' | 'ㅆ' if front => ("ɕ", None),
        'ㅅ' | 'ㅆ' => ("s", None),
        'ㅎ' if voiced_before => ("ɦ", None),
        'ㅎ' => ("h", None),
        'ㄴ' => ("n", None),
        'ㅁ' => ("m", None),
        'ㄹ' if after_l => ("l", None),
        'ㄹ' => ("ɾ", None),
        _ => unreachable!("not an initial: {o}"),
    }
}

fn coda_ipa(c: char) -> &'static str {
    match c {
        'ㄱ' => "k",
        'ㄴ' => "n",
        'ㄷ' => "t",
        'ㄹ' => "l",
        'ㅁ' => "m",
        'ㅂ' => "p",
        'ㅇ' => "ŋ",
        _ => unreachable!("not a neutral coda: {c}"),
    }
}

/// One word of Hangul (a run of blocks) → its sung syllables, the last marked as the word's end.
pub fn word_syllables(word: &str) -> Vec<Syllable> {
    let mut blocks: Vec<Block> = word.chars().filter(|&c| is_hangul(c)).map(decompose).collect();
    for i in 1..blocks.len() {
        let (l, r) = blocks.split_at_mut(i);
        join(l.last_mut().unwrap(), &mut r[0]);
    }
    if let Some(last) = blocks.last_mut() {
        last.coda = simplify(&last.coda).map(neutral).into_iter().collect();
    }
    let mut out = Vec::with_capacity(blocks.len());
    for (i, b) in blocks.iter().enumerate() {
        let prev_coda = if i > 0 { blocks[i - 1].coda.last().copied() } else { None };
        let voiced_before = i > 0 && prev_coda.is_none_or(|c| matches!(c, 'ㄴ' | 'ㄹ' | 'ㅁ' | 'ㅇ'));
        let front = b.vowel == "i" && b.glide != "w" || b.glide == "j";
        let mut onset: Vec<Segment> = b
            .onset
            .map(|o| {
                let (ipa, aspirated) = onset_ipa(o, voiced_before, front, prev_coda == Some('ㄹ'));
                Segment { aspirated, ..Segment::new(ipa) }
            })
            .into_iter()
            .collect();
        // ㅢ after a consonant is plain [i] (희 → 히)
        if !b.glide.is_empty() && !(b.glide == "ɰ" && b.onset.is_some()) {
            onset.push(Segment::new(b.glide));
        }
        out.push(Syllable {
            text: b.text.to_string(),
            onset,
            nucleus: Segment::new(b.vowel),
            coda: b.coda.iter().map(|&c| Segment::new(coda_ipa(c))).collect(),
            melisma: None,
            word_end: i + 1 == blocks.len(),
            phrase_end: false,
            // no pitch bends: Korean has no lexical tone (and fields added later default)
            ..Default::default()
        });
    }
    out
}

/// The Korean front end: Hangul blocks, by the rules above (no data needed).
pub struct Korean;

impl FrontEnd for Korean {
    fn starts(&self, c: char) -> bool {
        is_hangul(c)
    }
    fn word(&self, word: &str) -> Vec<Syllable> {
        word_syllables(word)
    }
}
