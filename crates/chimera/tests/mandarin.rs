//! Mandarin: the alveolo-palatal and retroflex affricates are single tokens and real phonemes, and
//! the front end reads Han characters: longest phrase match, tone sandhi, pinyin → IPA with
//! aspiration said, tones → pitch bends.
use chimera::anatomy::human::BodyMix;
use chimera::phonetics::english::EnglishG2P;
use chimera::phonetics::inventory::{Manner, phoneme};
use chimera::phonetics::ipa::tokenize_ipa;
use chimera::phonetics::korean::Korean;
use chimera::phonetics::mandarin::{Mandarin, MandarinLexicon, Pinyin, tone_bends};
use chimera::phonetics::syllables::{English, read_lyrics};
use chimera::phonetics::{Edge, Syllable};

#[test]
fn affricates_tokenize_as_one_segment() {
    let ipa: Vec<String> = tokenize_ipa("tɕi tɕʰi dʑa tʂa dʐu ɕy ʑə ɥɛ").into_iter().map(|s| s.ipa).collect();
    // ʰ is not modelled and drops, as before
    assert_eq!(ipa, ["tɕ", "i", "tɕ", "i", "dʑ", "a", "tʂ", "a", "dʐ", "u", "ɕ", "y", "ʑ", "ə", "ɥ", "ɛ"]);
}

#[test]
fn mandarin_consonants_are_in_the_inventory() {
    for (ipa, manner, release) in [("ɕ", Manner::Fricative, None), ("ʑ", Manner::Fricative, None), ("tɕ", Manner::Affricate, Some("ɕ")), ("dʑ", Manner::Affricate, Some("ʑ")), ("tʂ", Manner::Affricate, Some("ʂ")), ("dʐ", Manner::Affricate, Some("ʐ")), ("ɥ", Manner::Approximant, None)] {
        let d = phoneme(ipa, BodyMix::MALE).unwrap_or_else(|| panic!("{ipa} missing"));
        assert_eq!(d.manner, manner, "{ipa}");
        assert_eq!(d.release, release, "{ipa}");
    }
}

const LEX: &str = "举\tju3\n风\tfeng1\n多\tduo1\n头\ttou2\n鸟\tniao3\n光\tguang1\n四\tsi4\n是\tshi4\n点\tdian3\n哪\tna3\n儿\ter2\n女\tnv3\n子\tzi5\n块\tkuai4\n一会儿\tyi1 hui4 er5\n天\ttian1\n你\tni3\n好\thao3\n我\two3\n不\tbu4\n会\thui4\n银\tyin2\n行\txing2\n银行\tyin2 hang2\n走\tzou3\n的\tde5\n跑\tpao3\n一\tyi1\n个\tge4\n绿\tlv4\n学\txue2\n吃\tchi1\n爱\tai4\n去\tqu4\n";

fn lex() -> MandarinLexicon {
    let mut l = MandarinLexicon::new();
    l.load(LEX);
    l
}

fn syls(text: &str) -> Vec<Syllable> {
    let l = lex();
    read_lyrics(text, &[&Mandarin(&l)])
}

/// onset+nucleus+coda, with ʰ/˭ where the front end says a stop's aspiration
fn ipa(s: &Syllable) -> String {
    let m = |segs: &[chimera::phonetics::Segment]| segs.iter().map(|x| format!("{}{}", x.ipa, match x.aspirated { Some(true) => "ʰ", Some(false) => "˭", None => "" })).collect::<String>();
    format!("{}{}{}", m(&s.onset), s.nucleus.ipa, m(&s.coda))
}

#[test]
fn readings_by_longest_phrase_then_tone_sandhi() {
    let l = lex();
    assert_eq!(l.read("银行"), ["yin2", "hang2"]); // the phrase decides 行
    assert_eq!(l.read("行走"), ["xing2", "zou3"]); // no phrase: the character's own reading
    assert_eq!(l.read("你好"), ["ni2", "hao3"]); // 3-3 → 2-3
    assert_eq!(l.read("我你好"), ["wo2", "ni2", "hao3"]); // a run of third tones
    assert_eq!(l.read("不会"), ["bu2", "hui4"]); // 不 before a fourth tone
    assert_eq!(l.read("一个"), ["yi2", "ge4"]); // 一 before a fourth tone
    assert_eq!(l.read("不去"), ["bu2", "qu4"]);
}

#[test]
fn pinyin_becomes_ipa_with_aspiration_said() {
    let all: Vec<String> = syls("跑不吃学绿的爱").iter().map(ipa).collect();
    // p aspirated, b unaspirated; ch aspirated before an apical vowel; xue = ɕ ɥ ɛ; lü; neutral de; ai
    // apical ʅ after ch; xue's glide sings inside the vowel (yɛ); 爱 starts with a glottal catch
    assert_eq!(all, ["pʰaʊ", "p˭u", "tʂʰʅ", "ɕyɛ", "ly", "t˭ə", "ʔaɪ"]);
}

#[test]
fn tones_become_bends_and_text_keeps_the_character() {
    let s = syls("你好");
    assert_eq!((s[0].text.as_str(), s[1].text.as_str()), ("你", "好"));
    assert_eq!(s[0].pitch, tone_bends(2)); // sandhi: sung as a rising tone
    assert_eq!(s[1].pitch, tone_bends(3));
    assert!(s[1].word_end && !s[0].word_end);
    assert!(tone_bends(1).is_empty() && tone_bends(5).is_empty());
    assert_eq!(tone_bends(4).iter().map(|b| b.at).collect::<Vec<_>>(), [Edge::Start, Edge::End]);
}

#[test]
fn a_mixed_line_routes_each_word_to_its_front_end() {
    let l = lex();
    let mut g = EnglishG2P::new();
    g.load_dict("you\tY UW1\n");
    let out = read_lyrics("我爱 you, 你。", &[&English(&g), &Korean, &Mandarin(&l)]);
    let shown: Vec<(&str, bool, bool)> = out.iter().map(|s| (s.text.as_str(), s.word_end, s.phrase_end)).collect();
    assert_eq!(shown, [("我", false, false), ("爱", true, false), ("you", true, true), ("你", true, true)]);
    // no lexicon loaded: Han reads as nothing, the rest is unaffected
    let empty = MandarinLexicon::new();
    assert_eq!(read_lyrics("我 you", &[&English(&g), &Mandarin(&empty)]).len(), 1);
}

fn typed(text: &str) -> Vec<(String, String, usize)> {
    let mut g = EnglishG2P::new();
    g.load_dict("hello\tHH AH0 L OW1\ncaf\tK AE1 F\nit's\tIH1 T S\n");
    read_lyrics(text, &[&Pinyin, &English(&g), &Korean]).iter().map(|s| (s.text.clone(), ipa(s), s.pitch.len())).collect()
}

#[test]
fn pinyin_with_tones_is_mandarin_and_without_is_english() {
    let t = typed("nǐhǎo xièxie ni3 hao3 de5 Xī'ān nǚ");
    let text: Vec<&str> = t.iter().map(|x| x.0.as_str()).collect();
    assert_eq!(text, ["nǐ", "hǎo", "xiè", "xie", "ni3", "hao3", "de5", "xī", "ān", "nǚ"]);
    let ipa: Vec<&str> = t.iter().map(|x| x.1.as_str()).collect();
    assert_eq!(ipa, ["ni", "xaʊ", "ɕiɛ", "ɕiɛ", "ni", "xaʊ", "t˭ə", "ɕi", "ʔan", "ny"]);
    // nǐhǎo is one word: third-tone sandhi sings nǐ rising (one bend); "ni3 hao3" are two words
    assert_eq!(t[0].2, tone_bends(2).len());
    assert_eq!(t[4].2, tone_bends(3).len());
    // the unmarked syllable of a marked word is neutral: no bend
    assert_eq!(t[3].2, 0);
    // English: no tones, not pinyin; an accented word that isn't pinyin isn't re-entered midway
    let e: Vec<String> = typed("hello café it's").into_iter().map(|x| x.0).collect();
    assert_eq!(e, ["hel", "lo", "caf", "it's"]);
}

#[test]
fn the_front_end_says_aspiration_length_and_nasalisation() {
    let s = syls("跑的天");
    assert_eq!(s[0].onset[0].vot, Some(0.09)); // aspirated: Mandarin's long aspiration
    assert_eq!(s[1].onset[0].vot, None); // unaspirated
    assert_eq!(s[1].breath, None); // neutral tones stay at full breath (measured: lighter was harder to recognise)
    assert!(s[2].nasal_lead.is_some()); // tiān: nasalised before -n
    assert_eq!(s[0].nasal_lead, None);
}

#[test]
fn apical_vowels_follow_their_consonant() {
    let n: Vec<String> = syls("四是").iter().map(|s| s.nucleus.ipa.clone()).collect();
    assert_eq!(n, ["ɿ", "ʅ"]);
}

#[test]
fn erhua_merges_into_the_syllable_before() {
    let shown = |t: &str| syls(t).iter().map(|s| format!("{}={}", s.text, ipa(s))).collect::<Vec<_>>().join(" ");
    // erhua: the syllable ends in ɻ, its -n gives way, a falling diphthong keeps its first vowel
    assert_eq!(shown("一点儿"), "一=i 点儿=t˭iɛɻ");
    assert_eq!(shown("块儿"), "块儿=kʰuaɻ"); // uai → ua + ɻ (the off-glide gives way, the on-glide stays)
    assert_eq!(shown("哪儿"), "哪儿=naɻ");
    assert_eq!(shown("一会儿"), "一=i 会儿=xweɻ");
    // 儿 as a word's own syllable
    assert_eq!(shown("女儿"), "女=ny 儿=ʔɝ");
    assert_eq!(shown("儿子"), "儿=ʔɝ 子=ts˭ɿ");
    // pinyin's r
    let p: Vec<String> = typed("nǎr yìdiǎnr").into_iter().map(|x| x.1).collect();
    assert_eq!(p, ["naɻ", "i", "t˭iɛɻ"]);
}

#[test]
fn mandarin_timing_and_vowels() {
    let s = syls("光天你风举");
    let dur = |segs: &[chimera::phonetics::Segment]| segs.iter().map(|x| x.dur).collect::<Vec<_>>();
    // nasal codas held long enough to tell -n from -ng
    assert_eq!(dur(&s[0].coda), [Some(0.13)]);
    assert_eq!(dur(&s[1].coda), [Some(0.10)]);
    // nasal onsets and f longer; an unaspirated affricate's frication shorter
    assert_eq!(s[2].onset[0].dur, Some(0.09));
    assert_eq!(s[3].onset[0].dur, Some(0.13));
    assert_eq!(s[4].onset[0].dur, Some(0.08));
    // Mandarin's own vowels: eng back [ɤŋ], uo open [uɔ], ou central [əʊ], iao one three-part nucleus
    let n: Vec<String> = syls("风多头鸟").iter().map(|s| s.nucleus.ipa.clone()).collect();
    assert_eq!(n, ["ɤ", "uɔ", "əʊ", "iaʊ"]);
}
