//! Singing: syllables on notes, through the same gestural planner as speech.
//!  - A note's vowel lands on the beat. Its onset consonants are sung just before it (they take
//!    their time from the previous note, as singers do), its coda just before the next onset.
//!  - Diphthongs sustain their first vowel and glide to the second at the end of the note.
//!  - A melisma ("-") carries the vowel onto further notes; the coda waits for the last of them.
//!  - Vibrato blooms a quarter of a second into a held vowel.
//!
//! Live playing uses open-ended notes: a key press sings the onset and starts a vowel that lasts
//! until the key is released (tagged gestures, ended with GestureScore.release), and the release
//! sings the glide and the coda.
//!
//! These planners allocate (they run off the audio thread).

use super::inventory::phoneme;
use crate::anatomy::human::{ArticKey, BodyMix};
use super::planner::{PlanOptions, held_vowel, offglide, onglide, plan_utterance};
use super::{Bend, Edge, Intonation, Plan, PlannedSegment, Segment, Syllable};
use crate::control::score::{ControlKey, Gesture, Targets};
use crate::math::{js_max, js_min};
use serde::{Deserialize, Serialize};

/// `440 · 2^((m − 69)/12)`, the same formula and operation order as `sing.ts`.
pub use crate::math::midi_to_hz;

/// sung consonants are a little shorter than spoken ones
fn cdur(ipa: &str, body: BodyMix, k: f64) -> f64 {
    phoneme(ipa, body).map_or(0.07, |d| d.dur) * k
}

/// Sung consonants: a duration the front end gives is its own (a language's timing: Mandarin's long
/// nasal codas); otherwise the phoneme's spoken length times `k`. Either is squeezed when a note is
/// too short for it.
fn consonants(segs: &[Segment], body: BodyMix, k: f64) -> Vec<Segment> {
    segs.iter().map(|c| Segment { ipa: c.ipa.clone(), dur: Some(c.dur.unwrap_or_else(|| cdur(&c.ipa, body, k))), aspirated: c.aspirated, vot: c.vot, ..Default::default() }).collect()
}

/// Sung consonants at their note's pitch: an onset consonant moves the pitch to the new note
/// before its vowel (as singers do), a coda holds the old one.
fn consonants_at(segs: &[Segment], body: BodyMix, k: f64, hz: f64) -> Vec<Segment> {
    let mut out = consonants(segs, body, k);
    for c in out.iter_mut() {
        c.f0 = Some(hz);
    }
    out
}

/// Sung consonants are this long relative to spoken (unless a front end gives their duration).
/// Measured with the scramble test: 0.8 (as before) lost consonants, word-initial ones most; 1.25
/// gained 3.4 points in English and 2.6 in Korean, neutral in Mandarin; 1.5 overshot.
pub const SUNG_CONSONANTS: f64 = 1.25;

/// A falling diphthong (or a triphthong) glides off over this share of its held part. At 0.2 the
/// glide was too short to hear on a long note (English EY heard as IH, AY as AH); 0.35 gained 2.0
/// points in English and 3.3 in Mandarin.
const OFFGLIDE: f64 = 0.35;

/// a rising diphthong's glide lasts a quarter of its vowel, at most this long (s)
const RISING_GLIDE: f64 = 0.12;

/// a sung vowel keeps at least this long when a short note squeezes its consonants (s)
const MIN_VOWEL: f64 = 0.05;
/// a squeezed consonant keeps at least this long (s); a flap is 16 ms
const MIN_CONSONANT: f64 = 0.012;

/// Fit the consonants between a vowel and the next one into `span`, the time from the vowel's
/// beat to the next vowel's (or to the end of a phrase's last note): when they leave the vowel
/// less than [`MIN_VOWEL`], they shrink in proportion (each down to [`MIN_CONSONANT`]), so the
/// next vowel still lands on its beat and a fast run doesn't drift later note by note.
fn fit(groups: [&mut [Segment]; 2], span: f64) {
    let [a, b] = groups;
    let cons = total(a) + total(b);
    let room = span - MIN_VOWEL;
    if cons <= room || cons <= 0.0 {
        return;
    }
    let scale = js_max(0.0, room) / cons;
    for c in a.iter_mut().chain(b.iter_mut()) {
        c.dur = Some(js_max(MIN_CONSONANT, c.dur.unwrap_or(0.0) * scale));
    }
}

fn total(segs: &[Segment]) -> f64 {
    segs.iter().fold(0.0, |s, c| s + c.dur.unwrap_or(0.0))
}

fn vibrato_gesture(t0: f64, t1: f64, depth: f64, tag: Option<f64>) -> Gesture {
    let mut g = Gesture::new(t0 + 0.22, t1, 0.3, 0.06, 4.0, Targets::default().with(ControlKey::VIBRATO, depth)).label("vibrato");
    g.tag = tag;
    g
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SungNote {
    pub midi: f64,
    /// length in beats
    pub beats: f64,
    pub syl: Syllable,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SongOptions {
    pub body: BodyMix,
    pub bpm: f64,
    /// plan time of the first note's beat (its onset consonants come before)
    pub t0: f64,
    /// vibrato depth (cents) on held vowels
    pub vibrato: f64,
    /// nasalise the vowel before a nasal coda for this fraction of the vowel (at most 0.25 s), as
    /// Mandarin singers do; None or 0: the velum lowers only for the nasal itself
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nasal_lead: Option<f64>,
    /// sung consonant length relative to spoken (None: SUNG_CONSONANTS, 1.25)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub consonant_scale: Option<f64>,
}

/// A bend's blending strength against the note's own pitch (6): it wins while it lasts.
const BEND_STRENGTH: f64 = 30.0;

/// Pitch gestures for a syllable's bends on a vowel sung at `hz` from a to b.
fn bend_gestures(bends: &[Bend], hz: f64, a: f64, b: f64, out: &mut Vec<Gesture>) {
    let d = b - a;
    if d <= 0.02 {
        return;
    }
    for bend in bends {
        let len = js_min(bend.len * d, bend.max);
        let (t0, t1) = match bend.at {
            Edge::Start => (a - 0.03, a + len),
            Edge::End => (b - len, b + 0.02),
        };
        let f = hz * crate::math::pow(2.0, bend.st / 12.0);
        out.push(Gesture::new(t0, t1, 0.015, 0.04, BEND_STRENGTH, Targets::default().with(ControlKey::F0, f)).label("bend"));
    }
}

fn melisma(s: &Syllable) -> bool {
    s.melisma == Some(true)
}

/// Plan a whole melody: one utterance per phrase, so each phrase gets its own breath.
pub fn plan_song(notes: &[SungNote], o: &SongOptions) -> Plan {
    let beat = 60.0 / o.bpm;
    let mut gestures: Vec<Gesture> = Vec::new();
    let mut segments: Vec<PlannedSegment> = Vec::new();
    let mut times: Vec<f64> = Vec::with_capacity(notes.len());
    let mut t = o.t0;
    for n in notes {
        times.push(t);
        t += n.beats * beat;
    }
    let mut end = t;
    let mut i = 0;
    while i < notes.len() {
        let mut j = i;
        while j < notes.len() - 1 && !notes[j].syl.phrase_end {
            j += 1;
        }
        let mut segs: Vec<Segment> = Vec::new();
        let mut vowel_spans: Vec<(f64, f64)> = Vec::new();
        // (note, vowel start, vowel end) of syllables with bends, and of vowels before a nasal coda
        let mut bend_spans: Vec<(usize, f64, f64)> = Vec::new();
        let mut nasal_spans: Vec<(f64, f64, f64, &str)> = Vec::new();
        let mut breath_spans: Vec<(f64, f64, f64)> = Vec::new();
        // each note's onset and coda consonants, at the note's pitch (a coda at the pitch of the
        // note whose syllable it ends; a melisma has neither)
        let hz_of = |k: usize| midi_to_hz(notes[k].midi);
        // a bend at the vowel's start begins in the onset: the consonants already sing its pitch, so
        // a rising tone starts low instead of starting at the note and dipping
        let onset_hz = |k: usize| {
            let start = notes[k].syl.pitch.iter().find(|b| b.at == Edge::Start).map_or(0.0, |b| b.st);
            hz_of(k) * crate::math::pow(2.0, start / 12.0)
        };
        let mut onsets: Vec<Vec<Segment>> = (i..=j).map(|k| if melisma(&notes[k].syl) { Vec::new() } else { consonants_at(&notes[k].syl.onset, o.body, o.consonant_scale.unwrap_or(SUNG_CONSONANTS), onset_hz(k)) }).collect();
        let mut codas: Vec<Vec<Segment>> = (i..=j)
            .map(|k| if k < j && melisma(&notes[k + 1].syl) { Vec::new() } else { consonants_at(&last_of_chain(notes, k).coda, o.body, o.consonant_scale.unwrap_or(SUNG_CONSONANTS), hz_of(k)) })
            .collect();
        // the phrase's last vowel leaves a short breath before the next phrase. The call's last
        // phrase is followed by a rest (callers split phrases at rests), so the breath comes from
        // the rest: hold that note to its end, less the breath's release.
        let reserve = if j == notes.len() - 1 { 0.05 } else { 0.12 };
        let last_end = times[j] + notes[j].beats * beat - js_min(reserve, 0.3 * notes[j].beats * beat);
        for k in i..=j {
            let (span, next) = if k < j { (times[k + 1] - times[k], &mut onsets[k + 1 - i][..]) } else { (last_end - times[k], &mut [][..]) };
            fit([&mut codas[k - i][..], next], span);
        }
        let first_onset = total(&onsets[0]);
        for k in i..=j {
            let n = &notes[k];
            let hz = hz_of(k);
            let next_melisma = k < j && melisma(&notes[k + 1].syl);
            let coda = std::mem::take(&mut codas[k - i]);
            let onset = std::mem::take(&mut onsets[k - i]);
            // vowel from this note's beat to the next note's onset (less this note's coda)
            let note_end = if k < j { times[k + 1] - total(&onsets[k + 1 - i]) } else { last_end };
            // only consonants squeezed to their floor can leave less than MIN_VOWEL
            let vdur = js_max(0.02, note_end - times[k] - total(&coda));
            segs.extend(onset);
            // the nucleus in time: a rising on-glide short on the beat (not on a melisma's later
            // notes), the vowel that holds, and a falling off-glide over the held part's last OFFGLIDE (not
            // when a melisma continues the vowel)
            let nuc = n.syl.nucleus.ipa.as_str();
            let on = onglide(nuc).filter(|_| !melisma(&n.syl));
            let g = if on.is_some() { js_min(0.25 * vdur, RISING_GLIDE) } else { 0.0 };
            if let Some(a) = on {
                segs.push(Segment { ipa: a.to_string(), dur: Some(g), f0: Some(hz), stress: Some(1), ..Default::default() });
            }
            let rest = vdur - g;
            match offglide(nuc).filter(|_| !next_melisma) {
                Some(b) => {
                    segs.push(Segment { ipa: held_vowel(nuc).to_string(), dur: Some(rest * (1.0 - OFFGLIDE)), f0: Some(hz), stress: Some(1), ..Default::default() });
                    segs.push(Segment { ipa: b.to_string(), dur: Some(rest * OFFGLIDE), f0: Some(hz), stress: Some(1), ..Default::default() });
                }
                None => segs.push(Segment { ipa: held_vowel(nuc).to_string(), dur: Some(rest), f0: Some(hz), stress: Some(1), ..Default::default() }),
            }
            if coda.first().is_some_and(|c| matches!(c.ipa.as_str(), "m" | "n" | "ŋ")) {
                // the syllable whose coda this is decides (a melisma's coda is its parent's)
                let lead = last_of_chain(notes, k).nasal_lead.or(o.nasal_lead).unwrap_or(0.0);
                if lead > 0.0 {
                    // the tongue body's rise toward -ng after the back vowel ɑ (ang, iang, uang); after
                    // other vowels, and toward -n, it measured no better or worse
                    let place = if coda[0].ipa == "ŋ" && held_vowel(nuc) == "ɑ" { "velar" } else { "" };
                    nasal_spans.push((times[k], times[k] + vdur, lead, place));
                }
            }
            if let Some(b) = last_of_chain(notes, k).breath {
                breath_spans.push((times[k], times[k] + vdur, b));
            }
            segs.extend(coda);
            vowel_spans.push((times[k], times[k] + vdur));
            // bends shape their syllable's first note (a melisma continues at the written pitches)
            if !n.syl.pitch.is_empty() && !melisma(&n.syl) {
                bend_spans.push((k, times[k], times[k] + vdur));
            }
        }
        if !segs.is_empty() {
            // the planner lays segments out from t0 + 0.06: start so the first vowel lands on its beat
            let plan = plan_utterance(&segs, &PlanOptions { body: o.body, t0: times[i] - first_onset - 0.06, f0: Some(hz_of(i)), intonation: Some(Intonation::Flat), sung: Some(true), ..Default::default() });
            gestures.extend_from_slice(&plan.gestures);
            segments.extend(plan.segments);
            for &(k, a, b) in &bend_spans {
                bend_gestures(&notes[k].syl.pitch, hz_of(k), a, b, &mut gestures);
            }
            for &(a, b, lead, place) in &nasal_spans {
                let t0 = b - js_min(lead * (b - a), 0.25);
                gestures.push(Gesture::new(t0, b + 0.02, 0.06, 0.03, 4.0, Targets::default().with(ArticKey::Velum, 0.3)).label("nasal vowel"));
                // and the tongue on its way to the coda's place, which is where -n and -ng differ
                // in the vowel: the body rising toward the velum for -ng, the tip toward the ridge
                // for -n (short of closure; the coda closes)
                let approach = match place {
                    "velar" => Some(Targets::default().with(ArticKey::TbY, 7.95)),
                    "alveolar" => Some(Targets::default().with(ArticKey::TtX, 6.2).with(ArticKey::TtY, 9.3)),
                    _ => None,
                };
                if let Some(t) = approach {
                    gestures.push(Gesture::new(t0, b + 0.02, 0.06, 0.03, 2.5, t).label("coda approach"));
                }
            }
            // a syllable's own breath, over the phrase's (strength 1): it wins while the note sounds
            for &(a, b, level) in &breath_spans {
                gestures.push(Gesture::new(a - 0.02, b, 0.05, 0.05, 8.0, Targets::default().with(ControlKey::BREATH, level)).label("syllable breath"));
            }
            for (a, b) in vowel_spans {
                if b - a > 0.3 {
                    gestures.push(vibrato_gesture(a, b, o.vibrato, None));
                }
            }
            end = js_max(end, plan.end);
        }
        i = j + 1;
    }
    Plan { gestures, segments, end }
}

/// The syllable whose coda ends a melisma chain starting at note k.
fn last_of_chain(notes: &[SungNote], k: usize) -> &Syllable {
    let mut b = k;
    while b > 0 && melisma(&notes[b].syl) {
        b -= 1;
    }
    &notes[b].syl
}

/// Live: gestures relative to "now" (the planner's 60 ms lead is mostly taken back).
const LIVE_T0: f64 = -0.045;
/// a held vowel lasts at most this long (s)
const HOLD: f64 = 30.0;

/// The previous note of a legato pair.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LegatoFrom {
    pub syl: Syllable,
    pub midi: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteOnOptions {
    pub body: BodyMix,
    pub vibrato: f64,
    pub tag: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub legato_from: Option<LegatoFrom>,
}

/// Key pressed: sing the previous syllable's glide and coda if it is still sounding (legato),
/// then this syllable's onset, then its vowel held open-ended. Every gesture gets `tag`; the
/// pitch and vibrato get `tag + 1`, so a melisma can change pitch without ending the vowel.
pub fn plan_note_on(syl: &Syllable, midi: f64, o: &NoteOnOptions) -> Vec<Gesture> {
    let hz = midi_to_hz(midi);
    let mut segs: Vec<Segment> = Vec::new();
    if let Some(l) = &o.legato_from {
        segs.extend(tail(&l.syl, o.body, midi_to_hz(l.midi)));
    }
    segs.extend(consonants(&syl.onset, o.body, 0.7));
    if let Some(a) = onglide(&syl.nucleus.ipa) {
        segs.push(Segment { ipa: a.to_string(), dur: Some(RISING_GLIDE * 0.6), f0: Some(hz), stress: Some(1), ..Default::default() });
    }
    segs.push(Segment { ipa: held_vowel(&syl.nucleus.ipa).to_string(), dur: Some(HOLD), f0: Some(hz), stress: Some(1), ..Default::default() });
    let plan = plan_utterance(&segs, &PlanOptions { body: o.body, t0: LIVE_T0, f0: Some(hz), intonation: Some(Intonation::Flat), open_end: Some(true), ..Default::default() });
    let vowel = &plan.segments[plan.segments.len() - 1];
    let mut out: Vec<Gesture> = plan.gestures.iter().map(|g| g.tag(if g.targets.has(ControlKey::F0) { o.tag + 1.0 } else { o.tag })).collect();
    out.push(vibrato_gesture(vowel.t0, vowel.t1, o.vibrato, Some(o.tag + 1.0)));
    out
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MelismaOptions {
    pub vibrato: f64,
    pub tag: f64,
}

/// Melisma, live: the held vowel moves to a new pitch (release tag + 1 first).
pub fn plan_melisma(midi: f64, o: &MelismaOptions) -> Vec<Gesture> {
    let MelismaOptions { vibrato, tag } = *o;
    vec![
        Gesture::new(0.0, HOLD, 0.05, 0.06, 6.0, Targets::default().with(ControlKey::F0, midi_to_hz(midi))).label("pitch").tag(tag + 1.0),
        vibrato_gesture(0.0, HOLD, vibrato, Some(tag + 1.0)),
    ]
}

/// Key released: the diphthong's glide and the coda (release the note's tags first).
pub fn plan_note_off(syl: &Syllable, midi: f64, body: BodyMix) -> Vec<Gesture> {
    let hz = midi_to_hz(midi);
    let segs = tail(syl, body, hz);
    if segs.is_empty() {
        return Vec::new();
    }
    plan_utterance(&segs, &PlanOptions { body, t0: LIVE_T0, f0: Some(hz), intonation: Some(Intonation::Flat), ..Default::default() }).gestures
}

/// What follows a held vowel: the diphthong's glide (at the note's pitch) and the coda.
fn tail(syl: &Syllable, body: BodyMix, hz: f64) -> Vec<Segment> {
    let mut out: Vec<Segment> = Vec::new();
    // a falling diphthong (or a triphthong) glides off at the end; a rising one already holds its vowel
    if let Some(b) = offglide(&syl.nucleus.ipa) {
        out.push(Segment { ipa: b.to_string(), dur: Some(0.07), stress: Some(1), f0: Some(hz), ..Default::default() });
    }
    out.extend(consonants(&syl.coda, body, 0.7));
    out
}
