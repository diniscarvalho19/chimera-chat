import { useEffect, useRef, useState } from "react";
import { MOUTH_OPEN, MOUTH_SHUT, useStore } from "../store.ts";
import { speakText, singSong, stopSpeaking, currentPlan, planNow, g2p, zh } from "../speech.ts";
import { hasHan } from "../../wasm/engine.ts";
import { Screen } from "./Screen.tsx";
import { extractSongs, moodBlocks, songRefs, toSpeech, type MoodBlock, type Song, type VoiceChange } from "../chatText.ts";
import { defaultF0 } from "../body.ts";
import { DEFAULT_SOURCE } from "../../wasm/engine.ts";
import { artistMentioned, choirSongs, findSong, languageSongs, searchSongs, songbook, songbookOverview, songMentioned, songName } from "../songbook.ts";
import { acappella, ensemble, harmonize } from "../song.ts";

/** a message asking for a song without instruments (however it's spelt) */
const A_CAPPELLA = /\b(a[\s-]?cap+el+a|acap+el+a|no (instruments|band|music)|voices only|just voices|only voices)\b/i;
import { MOOD, isMood, moodOf, type Mood } from "../mood.ts";
import { aiInstall, aiPrompt, aiStatus, type AIStatus } from "../chromeAI.ts";
import { OR_AUTO, orFinishSignIn, orKey, orModels, orPrompt, orSignIn, orSignOut, type OrModel } from "../openRouter.ts";

/** a message asking for as many singers as there can be */
const MAX_VOICES = /\b((max(imum)?|most|all( the)?|lots of|many|more and more|full|big|huge)\s+(number of\s+)?(voices|singers|choir|cast|ensemble)|ensemble|full cast|whole cast)\b/i;
/** a message asking for backing singers */
const HARMONY = /\b(harmon\w*|backing (vocals?|singers?|voices?)|back-?up (vocals?|singers?)|choir|chorus of|other voices|more voices|with voices)\b/i;

/**
 * A message, with a note for the model (not shown) from its songbook: the song the message names,
 * the songs of the artist it (or the message before it: "sing one of them") names, songs with choir
 * parts when it asks about choirs or harmony, songs on its topic ("any christmas songs?"), or the
 * songbook in brief when it asks what there is; asked to sing something not there, to say so. The
 * model can't search; this is its search. The notes say "if you sing": they don't ask for a song.
 */
async function withSongbook(message: string, before = ""): Promise<string> {
  const index = await songbook().catch(() => []);
  if (!index.length) return message;
  const artist = artistMentioned(index, message) ?? artistMentioned(index, before);
  // a title inside the artist's name ("Imagine" in "Imagine Dragons") isn't the song asked for
  const named = songMentioned(index, message);
  const inName = (t: string) => artist && t.toLowerCase().split(/\W+/).filter(Boolean).every((w) => artist.artist.toLowerCase().includes(w));
  const song = named && !inName(named.title) ? named : null;
  const notes: string[] = [];
  if (song) notes.push(`if you sing it, the songbook has ${songName(song)}${song.voices ? ` (with ${song.voices} choir part${song.voices > 1 ? "s" : ""})` : ""}: use a song-ref block with exactly that title`);
  if (artist)
    notes.push(`the songbook's songs by ${artist.artist} are: ${artist.titles.map((t) => `"${t}"${artist.tunes.includes(t) ? " (only its tune, no words: sung on la)" : ""}`).join(", ")}. Say which ones you have only the tune of, before singing one. To sing one of theirs, use a song-ref block with exactly one of these titles; it has no others of theirs, so never name or sing any other song as theirs`);
  if (CHOIR.test(message) || MAX_VOICES.test(message)) notes.push(`songs in the songbook sung with choir parts (other voices singing with you, each with a face), the fullest first; unless another is asked for, sing one of the first: ${choirSongs(index).map((e) => `${songName(e)} (${e.voices} choir part${e.voices! > 1 ? "s" : ""})`).join(", ")}`);
  // songs on a topic only when the message is about music ("any christmas songs?", not "what time is it")
  const language = languageSongs(index, message);
  if (language)
    notes.push(`the songbook's ${language.language} songs are: ${language.titles.map((t) => `"${t}"`).join(", ")}. Answer from this list: name a few of them (the first are the best known). To sing one, use a song-ref block with exactly one of these titles; it has no other ${language.language} songs, so never name, suggest or sing any other ${language.language} song`);
  const topic = song || artist || language || !MUSICAL.test(message) ? [] : searchSongs(index, message);
  if (topic.length) notes.push(`songs in the songbook on that: ${topic.map(songName).join(", ")}`);
  if (!notes.length && ABOUT_SONGBOOK.test(message)) notes.push(`your songbook (what you can sing from real scores): ${songbookOverview(index)}`);
  if (!notes.length && /\bsing\b/i.test(message))
    notes.push("the songbook has no score for any song named here. If an existing song was asked for, say plainly you don't have its music yet and offer to sing something else or a song of your own; never write its lyrics or a song block in its place");
  return notes.length ? `${message}\n\n(Note from the app, your songbook's own answer: ${notes.join("; ")}. Answer from this; to sing one, use a song-ref block with its exact title.)` : message;
}

/** a message about music: singing, songs, tunes, pieces */
const MUSICAL = /\b(sing|sang|sung|song|music|tune|piece|play|hymn|carol|anthem|lullaby|aria|melod|ballad|opera|jazz|rock|pop|folk|classical|instrumental|repertoire)/i;
/** asking about choirs, harmony, several voices */
const CHOIR = /\b(choirs?|harmon\w*|a ?cappella|vocal (groups?|harmon\w*)|multi-?(part|voice|layered)|layered vocals?|several voices|other voices|more voices|backing (vocals?|singers?)|duets?|quartets?)\b/i;
/** asking what the songbook has */
const ABOUT_SONGBOOK = /\b(songbook|what (songs|music) (do you|can you)|which songs|what can you sing|list (of )?(songs|artists|music)|(any|some) songs|songs (do|can) you|what artists|which artists)\b/i;


interface Msg {
  role: "user" | "assistant" | "error";
  text: string;
  /** characters of the text shown so far (the reveal follows the voice) */
  shown: number;
}

/** The paragraph being said: which message, where in it, and how far the reveal has matched. */
interface Speaking {
  msg: number;
  blocks: MoodBlock[];
  bi: number;
  planId: number;
  matched: number;
  cursor: number;
  lower: string;
  /** the reply's songs not yet sung, in order (each shows as a ♪ paragraph) */
  songs: Song[];
  /** a voice tag at the reply's very end: the voice from the next reply on */
  voiceAfter?: VoiceChange;
}

/** Chrome's speech recognition (dictation), where there is one */
interface Recognition {
  lang: string;
  interimResults: boolean;
  onresult: (e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void;
  onend: () => void;
  start(): void;
  stop(): void;
}
const SpeechRec = ((globalThis as Record<string, unknown>).SpeechRecognition ?? (globalThis as Record<string, unknown>).webkitSpeechRecognition) as
  | (new () => Recognition)
  | undefined;

const CHROME = "chrome";
const SIGN_OUT = "sign-out";
const MODEL_KEY = "chat-model";
const stored = () => {
  try {
    return localStorage.getItem(MODEL_KEY);
  } catch {
    return null;
  }
};

/** Chat mode's right column: talk to a model; each reply is said by the voice as it appears. */
export function ChatRight() {
  const start = useStore((s) => s.start);
  const setSource = useStore((s) => s.setSource);
  const setMood = useStore((s) => s.setMood);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  // the model: Chrome's on-device AI, installed on first use
  const [ai, setAi] = useState<AIStatus | "checking" | "failed">("checking");
  const [progress, setProgress] = useState(0);
  const install = () => {
    setAi("downloading");
    aiInstall(setProgress).then(
      () => setAi("available"),
      () => setAi("failed"),
    );
  };
  useEffect(() => {
    void aiStatus().then((st) => {
      setAi(st);
      // a download already under way (another tab, an earlier visit): follow it
      if (st === "downloading") install();
    });
    orFinishSignIn().then(
      (back) => {
        setCloud(!!orKey());
        if (back) setModel(OR_AUTO); // just signed in: chat through OpenRouter
      },
      (e: Error) => push({ role: "error", text: e.message, shown: Infinity }),
    );
  }, []);
  // or OpenRouter (signed in): the model menu picks which, Chrome's by default
  const [cloud, setCloud] = useState(() => !!orKey());
  const [model, setModel] = useState(() => stored() ?? CHROME);
  useEffect(() => {
    try {
      localStorage.setItem(MODEL_KEY, model); // kept across the sign-in's round trip
    } catch {
      // private window: the default next time
    }
  }, [model]);
  const [orList, setOrList] = useState<OrModel[]>([]);
  // the account's models, fetched again on each sign-in and out
  useEffect(() => void orModels().then(setOrList, () => setOrList([])), [cloud]);
  const local = model === CHROME;
  const ready = local ? ai === "available" : cloud;
  const pick = (v: string) => {
    if (v === SIGN_OUT) {
      orSignOut();
      setCloud(false);
      return setModel(CHROME);
    }
    if (v !== CHROME && !cloud) return void orSignIn(); // "Sign in…": off to OpenRouter
    setModel(v);
  };
  // signed out (or the key was rejected): back on Chrome's
  useEffect(() => {
    if (!cloud && model !== CHROME) setModel(CHROME);
  }, [cloud, model]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  /** what the reply is waiting on, said in the chat while it waits */
  const [status, setStatus] = useState("Thinking…");
  // the model can take a while (the on-device one most): say so as the wait grows
  useEffect(() => {
    if (status !== "Thinking…") return;
    const t1 = setTimeout(() => setStatus((s) => (s === "Thinking…" ? "Still thinking…" : s)), 6000);
    const t2 = setTimeout(() => setStatus((s) => (s === "Still thinking…" ? (local ? "Still thinking… the on-device model takes its time" : "Still thinking… the model is slow today") : s)), 15000);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [status, local]);
  useEffect(() => useStore.setState({ thinking: busy }), [busy]);
  const [rec, setRec] = useState<Recognition | null>(null);
  /** dictate into the box (the voice stops first: the mic would hear it) */
  const listen = () => {
    if (rec) return rec.stop();
    if (!SpeechRec) return;
    stop();
    const r = new SpeechRec();
    r.lang = "en-US";
    r.interimResults = true;
    r.onresult = (e) => setInput(Array.from(e.results, (x) => x[0].transcript).join(""));
    r.onend = () => setRec(null);
    r.start();
    setRec(r);
  };
  const [talking, setTalking] = useState(false);
  const sp = useRef<Speaking | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const count = useRef(0);
  /** append a message; its index */
  const push = (m: Msg) => {
    setMsgs((ms) => [...ms, m]);
    return count.current++;
  };

  const reveal = (msg: number, shown: number) => setMsgs((m) => m.map((x, i) => (i === msg && shown > x.shown ? { ...x, shown } : x)));

  /** the voice and the face take on a mood; the voice quality the model fixed stays (else the mood's) */
  const feel = (m: Mood) => {
    const mv = MOOD[m].voice, v = useStore.getState().voice;
    setSource({
      breathiness: v.breathiness ?? mv.breathiness,
      tension: v.tension ?? mv.tension,
      brightness: v.brightness ?? mv.brightness,
      roughness: v.roughness ?? DEFAULT_SOURCE.roughness,
      fry: v.fry ?? DEFAULT_SOURCE.fry,
    });
    setMood(m);
  };

  const finish = () => {
    if (sp.current?.voiceAfter) useStore.getState().changeVoice(sp.current.voiceAfter);
    feel("neutral");
    useStore.getState().setArtic(MOUTH_SHUT);
    const s = sp.current;
    sp.current = null;
    setTalking(false);
    if (s) setMsgs((m) => m.map((x, i) => (i === s.msg ? { ...x, shown: x.text.length } : x)));
  };

  /** say the next paragraph that has words; paragraphs without (code) just appear */
  // ponytail: each paragraph is planned when the last one ends (a small gap); plan ahead if it's audible
  const next = async () => {
    const s = sp.current;
    if (!s) return;
    while (++s.bi < s.blocks.length) {
      const b = s.blocks[s.bi];
      // the model's voice tag: the voice from these words on (a new body is a new airway)
      if (b.voice) useStore.getState().changeVoice(b.voice);
      const para = s.lower.slice(b.start, b.end);
      const song = para.startsWith("♪") ? s.songs.shift() : undefined;
      const text = toSpeech(para);
      if (song || /[a-z]/.test(text)) {
        reveal(s.msg, b.start);
        const mood = isMood(b.mood) ? b.mood : "neutral";
        feel(mood);
        useStore.getState().setArtic(MOUTH_OPEN);
        // pitch and pace: the body's own, times the model's voice, times the mood's
        const v = MOOD[mood].voice, { body, voice } = useStore.getState(), rate = RATE;
        const plan = song ? await singSong(song, body) : await speakText(text, { ipa: false, body, rate: rate * voice.rate * v.rate, f0: defaultF0(body) * voice.pitch * v.f0 });
        if (sp.current !== s) return; // stopped meanwhile
        if (plan) {
          Object.assign(s, { planId: plan.id, matched: 0, cursor: b.start });
          return;
        }
      }
      reveal(s.msg, b.end);
    }
    finish();
  };

  // the reveal: words said so far → how far into the paragraph to show
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const s = sp.current, p = currentPlan();
      if (!s || !p || p.id !== s.planId) return;
      const now = planNow(p);
      if (now < 0) return;
      const said = p.words.filter((w) => w.t0 <= now).length;
      const end = s.blocks[s.bi].end;
      while (s.matched < said) {
        const w = p.words[s.matched++].text.toLowerCase();
        const i = s.lower.indexOf(w, s.cursor);
        if (i >= 0 && i < end) s.cursor = i + w.length;
      }
      // show whole words: up to the next space
      const sp2 = s.lower.slice(s.cursor, end).search(/\s/);
      reveal(s.msg, sp2 < 0 ? end : s.cursor + sp2);
      if (now > p.plan.end + 0.05) {
        reveal(s.msg, end);
        s.planId = -1;
        void next();
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  useEffect(() => {
    list.current?.scrollTo({ top: list.current.scrollHeight });
  }, [msgs]);

  // leaving the panel (another mode) ends the reply
  useEffect(() => () => void (sp.current = null), []);

  const stop = () => {
    stopSpeaking();
    finish();
  };
  const skip = () => {
    if (!sp.current) return;
    stopSpeaking();
    reveal(sp.current.msg, sp.current.blocks[sp.current.bi]?.end ?? 0);
    sp.current.planId = -1;
    void next();
  };

  const send = async () => {
    const message = input.trim();
    if (!message || busy || !ready) return;
    stop();
    setInput("");
    setBusy(true);
    push({ role: "user", text: message, shown: message.length });
    try {
      if (!useStore.getState().started) setStatus("Waking up the voice…");
      await start();
      const err = useStore.getState().startError;
      if (err) throw new Error(`Audio could not start: ${err}`);
      if (/\b(sing|song|songs)\b/i.test(message)) setStatus("Looking through the songbook…");
      const prompt = await withSongbook(message, msgs.filter((m) => m.role === "user").at(-1)?.text);
      setStatus("Thinking…");
      const reply = local ? await aiPrompt(prompt) : await orPrompt(prompt, model);
      const clean = reply.replace(/’/g, "'");
      // songs asked for by name: their scores, from the songbook
      const refs = songRefs(clean);
      if (refs.length) setStatus(`Finding the music for ${refs.map((r) => `“${r.split("\n")[0].replace(/\s+[-–—]\s+.*$/, "")}”`).join(" and ")}…`);
      const found = new Map(await Promise.all(refs.map(async (q) => [q, (await findSong(q))?.song ?? null] as const)));
      if (!g2p.loaded) {
        setStatus("Getting the words ready…");
        await g2p.load().catch(() => {}); // the letter-to-sound rules still work
      }
      if (hasHan(clean) && !zh.loaded) {
        setStatus("Getting the Chinese words ready…");
        await zh.load().catch(() => {}); // pinyin still works
      }
      // a song the model offered unasked that isn't there is left out, not apologised for
      const { display, songs } = extractSongs(clean, found, !/\b(sing|sang|play)\b/i.test(message));
      const cappella = A_CAPPELLA.test(message);
      // asked for harmony: a score's instrument parts sung over its band; otherwise up to two
      // backing singers on every song that has fewer of its own
      if (HARMONY.test(message))
        songs.forEach((song, i) => {
          if (!cappella && song.parts?.some((p) => !p.vocal)) return void (songs[i] = acappella(song, true));
          const own = song.voices?.length ?? 0;
          if (own < 2) song.voices = [...(song.voices ?? []), ...harmonize(song, 2 - own)];
        });
      // asked a cappella: no band; voices sing its instruments' parts
      // a beatboxer where the score had drums, or when asked for
      if (cappella) songs.forEach((song, i) => (songs[i] = acappella(song, false, !!song.drums || /\bbeat ?box/i.test(message))));
      // asked for the most voices: every line doubled at the octave
      if (MAX_VOICES.test(message)) songs.forEach((song, i) => (songs[i] = ensemble(song)));
      const { text, blocks, voiceAfter } = moodBlocks(display, moodOf);
      const msg = push({ role: "assistant", text, shown: 0 });
      sp.current = { msg, blocks, bi: -1, planId: -1, matched: 0, cursor: 0, lower: text.toLowerCase(), songs, voiceAfter };
      setTalking(true);
      void next();
    } catch (e) {
      push({ role: "error", text: String((e as Error).message ?? e), shown: Infinity });
    } finally {
      setCloud(!!orKey());
      setBusy(false);
      setStatus("Thinking…");
    }
  };

  return (
    <div className="right right-chat">
      <Screen className="s-chat" title="Chat" sub={local ? "On-device AI" : "OpenRouter"}>
        <div className="chat">
          <div className="chat-log" ref={list} aria-live="polite">
            {!ready && local && (
              <AiSetup
                status={ai}
                progress={progress}
                onInstall={install}
                onSignIn={() => {
                  setModel(OR_AUTO);
                  void orSignIn();
                }}
              />
            )}
            {msgs.map((m, i) => (
              <div key={i} className={`chat-msg chat-${m.role}`}>
                {m.text.slice(0, m.shown)}
              </div>
            ))}
            {busy && (
              <div className="chat-msg chat-assistant chat-thinking" role="status">
                {status}
              </div>
            )}
          </div>
          <div className="chat-input">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
                e.stopPropagation();
              }}
              rows={2}
              aria-label="Message"
              disabled={!ready}
              placeholder={ready ? "Ask anything (Enter to send, Shift+Enter for a new line)" : "Install the model or sign in to chat"}
            />
            <div className="chat-input-bar">
              <select className="model-pick" value={model} onChange={(e) => pick(e.target.value)} aria-label="Model" title="Model">
                <option value={CHROME}>Chrome AI (on-device)</option>
                <optgroup label="OpenRouter">
                  <option value={OR_AUTO}>{cloud ? "Auto (best available)" : "Sign in to choose a model…"}</option>
                  {orList.filter((m) => m.free).map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                  {/* a model picked before the list loads, or gone from it, still shows */}
                  {model !== CHROME && model !== OR_AUTO && !orList.some((m) => m.id === model) && <option value={model}>{model}</option>}
                </optgroup>
                {orList.some((m) => !m.free) && (
                  <optgroup label="OpenRouter (paid, uses your credits)">
                    {orList.filter((m) => !m.free).map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                      </option>
                    ))}
                  </optgroup>
                )}
                {cloud && <option value={SIGN_OUT}>Sign out of OpenRouter</option>}
              </select>
              <span className="bar-gap" />
            {SpeechRec && <IconButton icon="mic" label={rec ? "Stop listening" : "Speak"} onClick={listen} disabled={!ready} pressed={!!rec} />}
            {talking && (
              <>
                <IconButton icon="skip" label="Skip" onClick={skip} />
                <IconButton icon="stop" label="Stop" onClick={stop} />
              </>
            )}
            <IconButton className="send-btn" icon="send" label={busy ? "Waiting…" : "Send"} onClick={() => void send()} disabled={busy || !ready || !input.trim()} />
            </div>
          </div>
        </div>
      </Screen>
    </div>
  );
}

/** Until the model is on this device: what's needed, the install button, the download's progress. */
function AiSetup(props: { status: AIStatus | "checking" | "failed"; progress: number; onInstall: () => void; onSignIn: () => void }) {
  const { status, progress } = props;
  if (status === "checking") return <p className="hint">Checking for the on-device AI…</p>;
  if (status === "no-api" || status === "unavailable")
    return (
      <div className="ai-setup">
        <p>This chat runs an AI model on your own device, with Chrome&apos;s built-in AI.</p>
        <p className="hint">{status === "no-api" ? "Open it in Chrome 148 or newer on a computer." : "This device can't run Chrome's on-device model (it needs more memory, disk space or graphics power)."}</p>
        <p>Or chat through OpenRouter: sign in (free, an account in a few taps) and it uses free models.</p>
        <button className="primary" onClick={props.onSignIn}>
          Sign in with OpenRouter
        </button>
      </div>
    );
  if (status === "downloading")
    return (
      <div className="ai-setup">
        <p>Installing the on-device AI model…</p>
        <progress className="ai-progress" max={1} value={progress} aria-label="Model download" />
        <p className="hint">{Math.round(progress * 100)} %. It downloads once; after that, everything runs on your device.</p>
      </div>
    );
  return (
    <div className="ai-setup">
      <p>This chat runs an AI model on your own device: private, free, no account.</p>
      <p className="hint">{status === "failed" ? "The install didn't finish. Try again." : "Chrome needs to download it once (a few GB)."}</p>
      <button className="primary" onClick={props.onInstall}>
        {status === "failed" ? "Try again" : "Install the model"}
      </button>
    </div>
  );
}

/** the speaking rate, over the mood's and the voice tag's */
const RATE = 1.35;

const ICONS = {
  send: "M12 19V5M5.5 11.5 12 5l6.5 6.5",
  mic: "M12 3a3 3 0 0 0-3 3v5a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3ZM5 11a7 7 0 0 0 14 0M12 18v3M8 21h8",
  stop: "M6 6h12v12H6Z",
  skip: "M5 5l10 7-10 7ZM18 5v14",
};

function IconButton(props: { icon: keyof typeof ICONS; label: string; onClick: () => void; disabled?: boolean; pressed?: boolean; className?: string }) {
  return (
    <button className={`icon-btn ${props.className ?? ""}`} onClick={props.onClick} disabled={props.disabled} aria-label={props.label} title={props.label} aria-pressed={props.pressed}>
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" aria-hidden="true">
        <path d={ICONS[props.icon]} />
      </svg>
    </button>
  );
}
