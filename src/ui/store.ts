import { create } from "zustand";
import { engine } from "../audio/AudioEngine.ts";
import { DEFAULT_SOURCE, type VoiceSource } from "../wasm/engine.ts";
import { NEUTRAL, restTip, type HumanArtic } from "../wasm/engine.ts";
import { defaultF0, PRESETS, sameBody, type BodyMix } from "./body.ts";
import { stopSpeaking } from "./speech.ts";
import type { Mood } from "./mood.ts";
import { changedVoice, DEFAULT_VOICE, type VoiceChange, type VoiceSettings } from "./chatText.ts";

export interface ViewOptions {
  pressure: boolean;
  particles: boolean;
  grid: boolean;
  calipers: boolean;
  /** the face screen shows the head in 3D (turn it with the pointer; no handles) */
  threeD: boolean;
  /** the 3D head: the anatomy's lines show through the face */
  xray: boolean;
}

interface State {
  started: boolean;
  starting: boolean;
  startError: string | null;
  /** the device couldn't keep up at 48 kHz: the voice runs at 32 kHz (see AudioEngine) */
  lightAudio: boolean;
  /** the device can't keep up even so: the voice breaks up or goes silent */
  overloaded: boolean;
  /** counts the audio's rebuilds: what was being said or sung is gone (the chat stops its reply) */
  rebuilt: number;
  body: BodyMix;
  source: VoiceSource;
  artic: HumanArtic;
  tipFree: boolean;
  volume: number;
  view: ViewOptions;
  /** the voice the model has set (the default: the man, as he is) */
  voice: VoiceSettings;
  /** a voice tag's change: the body (rebuilds the airway, if it changes) and the voice */
  changeVoice: (c: VoiceChange) => void;
  /** what the voice is feeling now (the face follows it) */
  mood: Mood;
  setMood: (m: Mood) => void;
  /** waiting on the model's answer (the face looks thoughtful) */
  thinking: boolean;
  start: () => Promise<void>;
  /** switch the voice to this body (rebuilds its airway) */
  setBody: (b: BodyMix) => void;
  setSource: (v: Partial<VoiceSource>) => void;
  setArtic: (v: Partial<HumanArtic>, tipFree?: boolean) => void;
  setView: (v: Partial<ViewOptions>) => void;
}

/** the mouth at rest: lips together, jaw nearly closed (speaking opens it to NEUTRAL's) */
export const MOUTH_SHUT = { jaw: 0.25, lipAp: -0.05 };
export const MOUTH_OPEN = { jaw: NEUTRAL.jaw, lipAp: NEUTRAL.lipAp };

/** Everything the voice plays from, sent to an engine that knows none of it (a new one). */
function sendState(s: State) {
  engine.setVolume(s.volume);
  if (!sameBody(s.body, PRESETS.male)) engine.setBody(s.body);
  engine.setSource(s.source);
  engine.setArtic(s.artic, s.tipFree);
}

let startPromise: Promise<void> | null = null;

export const useStore = create<State>((set, get) => ({
  started: false,
  starting: false,
  startError: null,
  lightAudio: false,
  overloaded: false,
  rebuilt: 0,
  body: PRESETS.male,
  source: { ...DEFAULT_SOURCE },
  artic: (() => {
    const tip = restTip(NEUTRAL.jaw, NEUTRAL.tbX, NEUTRAL.tbY);
    return { ...NEUTRAL, ttX: tip.x, ttY: tip.y, ...MOUTH_SHUT };
  })(),
  tipFree: true,
  volume: 0.8,
  view: { pressure: true, particles: true, grid: false, calipers: false, threeD: true, xray: false },
  voice: DEFAULT_VOICE,
  changeVoice: (c) => {
    const { body, voice } = changedVoice(get(), c);
    if (!sameBody(body, get().body)) get().setBody(body);
    set({ voice });
  },
  mood: "neutral",
  setMood: (m) => set({ mood: m }),
  thinking: false,
  start: () => {
    if (get().started) return Promise.resolve();
    if (startPromise) return startPromise;
    set({ starting: true, startError: null });
    startPromise = (async () => {
      try {
        await engine.start();
        // anything set before audio existed was not delivered: send the whole state now
        sendState(get());
        set({ started: true, starting: false });
      } catch (e) {
        set({ starting: false, startError: e instanceof Error ? e.message : String(e) });
      } finally {
        startPromise = null;
      }
    })();
    return startPromise;
  },
  setBody: (b) => {
    // speech doesn't carry over (the new voice's clock starts again from zero)
    stopSpeaking();
    const f0 = defaultF0(b);
    set((s) => ({ body: b, source: { ...s.source, f0 } }));
    engine.setBody(b);
  },
  setSource: (v) => {
    set((s) => ({ source: { ...s.source, ...v } }));
    engine.setSource(v);
  },
  setArtic: (v, tipFree) => {
    set((s) => ({ artic: { ...s.artic, ...v }, tipFree: tipFree ?? s.tipFree }));
    engine.setArtic(v, tipFree);
  },
  setView: (v) => set((s) => ({ view: { ...s.view, ...v } })),
}));

engine.onStatus(() => useStore.setState({ lightAudio: engine.light, overloaded: engine.overloaded }));
// the lighter audio is a new engine: the phrase being said or sung is gone (its score was the old
// engine's), and the rest is sent again
engine.onRebuilt(() => {
  stopSpeaking();
  sendState(useStore.getState());
  useStore.setState((s) => ({ rebuilt: s.rebuilt + 1 }));
});
