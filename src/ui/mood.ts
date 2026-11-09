/**
 * Moods Claude tags its paragraphs with: how each one sounds (pitch, pace, voice quality) and how
 * the face holds it (smile, brows, lids, a tilt of the head).
 */
export const MOODS = ["neutral", "happy", "excited", "sad", "curious", "surprised", "calm", "concerned"] as const;
export type Mood = (typeof MOODS)[number];

export interface MoodVoice {
  /** speaking-rate and baseline-pitch multipliers */
  rate: number;
  f0: number;
  breathiness: number;
  tension: number;
  brightness: number;
}

export interface MoodFace {
  /** mouth corners: +1 a full smile, −1 turned down */
  smile: number;
  /** brows: +1 raised high, −1 lowered and knit */
  brow: number;
  /** extra lid closure: + sleepy/soft, − wide open */
  lid: number;
  /** head tilt (radians) */
  tilt: number;
}

// ponytail: hand-set by ear and eye; tune here
export const MOOD: Record<Mood, { voice: MoodVoice; face: MoodFace }> = {
  neutral: { voice: { rate: 1, f0: 1, breathiness: 0.15, tension: 0.5, brightness: 0.25 }, face: { smile: 0.1, brow: 0, lid: 0, tilt: 0 } },
  happy: { voice: { rate: 1.05, f0: 1.12, breathiness: 0.12, tension: 0.55, brightness: 0.4 }, face: { smile: 0.75, brow: 0.3, lid: 0.1, tilt: 0.04 } },
  excited: { voice: { rate: 1.18, f0: 1.22, breathiness: 0.1, tension: 0.65, brightness: 0.5 }, face: { smile: 1, brow: 0.7, lid: -0.25, tilt: 0 } },
  sad: { voice: { rate: 0.85, f0: 0.9, breathiness: 0.35, tension: 0.35, brightness: 0.12 }, face: { smile: -0.6, brow: -0.35, lid: 0.35, tilt: -0.06 } },
  curious: { voice: { rate: 0.98, f0: 1.08, breathiness: 0.15, tension: 0.5, brightness: 0.3 }, face: { smile: 0.25, brow: 0.55, lid: -0.1, tilt: 0.12 } },
  surprised: { voice: { rate: 1.05, f0: 1.25, breathiness: 0.18, tension: 0.6, brightness: 0.45 }, face: { smile: 0, brow: 1, lid: -0.35, tilt: 0 } },
  calm: { voice: { rate: 0.9, f0: 0.95, breathiness: 0.25, tension: 0.4, brightness: 0.2 }, face: { smile: 0.35, brow: 0, lid: 0.25, tilt: 0.03 } },
  concerned: { voice: { rate: 0.92, f0: 0.97, breathiness: 0.2, tension: 0.45, brightness: 0.2 }, face: { smile: -0.3, brow: -0.6, lid: 0.05, tilt: -0.04 } },
};

export function isMood(s: string): s is Mood {
  return (MOODS as readonly string[]).includes(s);
}

/** words a model tags with that aren't the moods' names, and the mood each is */
const ALIASES: Record<string, Mood> = {
  interested: "curious", intrigued: "curious", fascinated: "curious", wondering: "curious", thoughtful: "curious",
  joyful: "happy", cheerful: "happy", glad: "happy", warm: "happy", playful: "happy", proud: "happy", amused: "happy", grateful: "happy",
  thrilled: "excited", enthusiastic: "excited", eager: "excited", energetic: "excited",
  amazed: "surprised", astonished: "surprised", shocked: "surprised",
  worried: "concerned", anxious: "concerned", nervous: "concerned", apologetic: "concerned", serious: "concerned",
  sorry: "sad", melancholy: "sad", wistful: "sad", disappointed: "sad",
  relaxed: "calm", peaceful: "calm", gentle: "calm", reflective: "calm", soothing: "calm",
};

/** the mood a tag means: a mood's name, or a word close to one ("interested" is curious); else null */
export function moodOf(s: string): Mood | null {
  const w = s.toLowerCase();
  return isMood(w) ? w : (ALIASES[w] ?? null);
}
