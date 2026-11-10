//! Phonetics: IPA, the Portuguese and English G2Ps, syllables, durations, the gestural planner,
//! singing, beatbox.
//! These run off the audio thread (they allocate); their output is a [`Plan`] of gestures that a
//! voice plays.

use crate::control::score::Gesture;
use serde::{Deserialize, Serialize};

pub mod beatbox;
pub mod durations;
pub mod english;
pub mod inventory;
pub mod ipa;
pub mod korean;
pub mod mandarin;
pub mod planner;
pub mod portuguese;
pub mod sing;
pub mod songs;
pub mod syllables;
pub mod vowel_data;

/// One phoneme in an utterance.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Segment {
    pub ipa: String,
    /// duration override (s)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dur: Option<f64>,
    /// 0 unstressed, 1 primary, 2 secondary
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stress: Option<u8>,
    /// explicit pitch (Hz) for this segment (singing)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub f0: Option<f64>,
    /// word boundary after this segment
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub word_end: Option<bool>,
    /// a voiceless stop or affricate's aspiration, as its front end decides it (Mandarin and Korean
    /// contrast it); None: the planner's default, English's rule (aspirated syllable-initially
    /// before a vowel, not after /s/)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub aspirated: Option<bool>,
    /// how long an aspirated stop or affricate's aspiration lasts (s, voice onset time); None: 50 ms
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vot: Option<f64>,
}

/// One phrase of an utterance: its segments, how it ends, and the words said.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Phrase {
    pub segments: Vec<Segment>,
    pub intonation: Intonation,
    /// pause after the phrase (s)
    pub pause: f64,
    /// the words said, one per word end in `segments`
    pub words: Vec<String>,
}

impl Segment {
    pub fn new(ipa: &str) -> Segment {
        Segment { ipa: ipa.to_string(), ..Default::default() }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Intonation {
    /// final fall
    #[default]
    Statement,
    /// final rise
    Question,
    Flat,
}

/// A segment as the planner timed it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlannedSegment {
    pub ipa: String,
    pub t0: f64,
    pub t1: f64,
    /// lexical stress of vowels (0 unstressed, 1 primary, 2 secondary)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stress: Option<u8>,
    pub kind: String,
}

/// Gestures for a voice plus the timeline they realise (times relative to the plan's t0 origin).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub gestures: Vec<Gesture>,
    pub segments: Vec<PlannedSegment>,
    pub end: f64,
}

/// A sung syllable.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Syllable {
    /// lyric text shown on the note
    pub text: String,
    pub onset: Vec<Segment>,
    /// vowel (a diphthong stays one nucleus: "aɪ")
    pub nucleus: Segment,
    pub coda: Vec<Segment>,
    /// continue the previous syllable's vowel at a new pitch
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub melisma: Option<bool>,
    /// last syllable of a word (codas sound here; phrase breaks follow punctuation)
    pub word_end: bool,
    /// a breath follows (comma, full stop, line break)
    pub phrase_end: bool,
    /// pitch bends inside the sung note, as the syllable's front end writes them (a tone, a pitch
    /// accent, a scoop); none: the note's pitch as written
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub pitch: Vec<Bend>,
    /// breath (lung drive) while the note sounds, relative to the phrase's (a light neutral-tone
    /// syllable); None: the phrase's
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub breath: Option<f64>,
    /// nasalise this fraction of the vowel before a nasal coda (at most 0.25 s), as Mandarin does;
    /// None: the song's SongOptions::nasal_lead
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nasal_lead: Option<f64>,
}

/// Which end of its sung vowel a pitch bend sits at.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Edge {
    Start,
    End,
}

/// A bend of the pitch inside a sung note: `st` semitones from the note, at the vowel's start or
/// end, over `len` of the vowel but at most `max` seconds. The melody stays as written; a bend only
/// colours the note's start or end (Mandarin's tones, Japanese pitch accent, an English scoop).
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Bend {
    pub at: Edge,
    pub len: f64,
    pub max: f64,
    pub st: f64,
}
