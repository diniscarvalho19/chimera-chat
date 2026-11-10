//! Port of tests/syllables.test.ts.
use chimera::phonetics::Segment;
use chimera::phonetics::english::arpabet_to_segments;
use chimera::phonetics::syllables::{lyrics_to_syllables, split_spelling, syllabify_segments};

// a few CMUdict entries, enough to test without loading the dictionary
fn dict(w: &str) -> Option<&'static str> {
    Some(match w {
        "twinkle" => "T W IH1 NG K AH0 L",
        "little" => "L IH1 T AH0 L",
        "star" => "S T AA1 R",
        "how" => "HH AW1",
        "i" => "AY1",
        "wonder" => "W AH1 N D ER0",
        "what" => "W AH1 T",
        "you" => "Y UW1",
        "are" => "AA1 R",
        "extra" => "EH1 K S T R AH0",
        "of" => "AH1 V",
        _ => return None,
    })
}
fn word(w: &str, _reduce: bool) -> Vec<Segment> {
    dict(w).map(arpabet_to_segments).unwrap_or_default()
}
fn ipa(xs: &[Segment]) -> String {
    xs.iter().map(|x| x.ipa.as_str()).collect()
}

#[test]
fn maximal_onset_with_legal_english_clusters() {
    let tw = syllabify_segments(&word("twinkle", false));
    let got: Vec<[String; 3]> = tw.iter().map(|s| [ipa(&s.onset), s.nucleus.ipa.clone(), ipa(&s.coda)]).collect();
    assert_eq!(got, [["tw", "ɪ", "ŋ"].map(String::from), ["k", "ə", "l"].map(String::from)]);
    // "extra": k + str → ek-stra (str is a legal onset)
    let ex = syllabify_segments(&word("extra", false));
    assert_eq!(ex.iter().map(|s| ipa(&s.onset)).collect::<Vec<_>>(), ["", "stɹ"]);
    assert_eq!(ipa(&ex[0].coda), "k");
}

#[test]
fn spelling_splits_to_match() {
    assert_eq!(split_spelling("twinkle", 2), ["twin", "kle"]);
    assert_eq!(split_spelling("little", 2), ["lit", "tle"]);
    assert_eq!(split_spelling("wonder", 2), ["won", "der"]);
    assert_eq!(split_spelling("are", 1), ["are"]);
}

#[test]
fn lyrics_words_melisma_phrase_ends_unreduced_function_words() {
    let syl = lyrics_to_syllables("Twinkle little star, how I - wonder", &word);
    assert_eq!(syl.iter().map(|s| s.text.as_str()).collect::<Vec<_>>(), ["Twin", "kle", "lit", "tle", "star", "how", "I", "~", "won", "der"]);
    assert!(syl[4].phrase_end);
    assert_eq!(syl[7].melisma, Some(true));
    assert_eq!(syl[7].nucleus.ipa, "aɪ");
    assert!(syl[1].word_end && !syl[0].word_end);
}

/// Each syllable as onset+nucleus+coda IPA, joined with "."; a stop's aspiration, when its front end
/// decides it, as ʰ (aspirated) or ˭ (unaspirated)
fn sung(text: &str) -> String {
    let marked = |segs: &[Segment]| segs.iter().map(|s| format!("{}{}", s.ipa, match s.aspirated { Some(true) => "ʰ", Some(false) => "˭", None => "" })).collect::<String>();
    lyrics_to_syllables(text, &word).iter().map(|s| format!("{}{}{}", marked(&s.onset), s.nucleus.ipa, marked(&s.coda))).collect::<Vec<_>>().join(".")
}

#[test]
fn hangul_sings_one_syllable_per_block_with_korean_sound_rules() {
    assert_eq!(sung("빵야"), "p˭aŋ.ja"); // ㅇ coda stays; tense ㅃ is voiceless and unaspirated
    assert_eq!(sung("먹어"), "mʌ.gʌ"); // a coda moves onto a silent ㅇ, voiced between vowels
    assert_eq!(sung("좋아"), "tɕo.a"); // ㅎ drops before a vowel; ㅈ is alveolo-palatal
    assert_eq!(sung("좋다"), "tɕo.tʰa"); // ㅎ + ㄷ aspirates
    assert_eq!(sung("국물"), "kuŋ.mul"); // nasalisation
    assert_eq!(sung("신라"), "ɕil.la"); // ㄴ + ㄹ is [ll]; ㅅ before i is [ɕ]
    assert_eq!(sung("없는"), "ʌm.nɯn"); // a two-letter coda simplifies, then nasalises
    assert_eq!(sung("학교"), "hak.k˭jo"); // tensing after an obstruent coda
    assert_eq!(sung("사랑해"), "sa.ɾaŋ.ɦɛ");
    assert_eq!(sung("닭"), "tak");
    assert_eq!(sung("의사"), "ɰi.sa");
}

#[test]
fn hangul_keeps_its_spelling_and_mixes_with_english() {
    let syls = lyrics_to_syllables("twinkle 빵야 빵야, star", &word);
    let shown: Vec<(&str, bool, bool)> = syls.iter().map(|s| (s.text.as_str(), s.word_end, s.phrase_end)).collect();
    assert_eq!(
        shown,
        [("twin", false, false), ("kle", true, false), ("빵", false, false), ("야", true, false), ("빵", false, false), ("야", true, true), ("star", true, false)]
    );
}
