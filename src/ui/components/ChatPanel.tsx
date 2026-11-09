import { useEffect, useRef, useState } from "react";
import { MOUTH_OPEN, MOUTH_SHUT, useStore } from "../store.ts";
import { speakText, singSong, stopSpeaking, currentPlan, planNow, g2p } from "../speech.ts";
import { Slider } from "./Controls.tsx";
import { Screen } from "./Screen.tsx";
import { extractSongs, moodBlocks, songRefs, toSpeech, type MoodBlock, type Song } from "../chatText.ts";
import { artistMentioned, findSong, songbook, songMentioned } from "../songbook.ts";
import { harmonize } from "../song.ts";

/** a message asking for backing singers */
const HARMONY = /\b(harmon\w*|backing (vocals?|singers?|voices?)|back-?up (vocals?|singers?)|choir|chorus of|other voices|more voices|with voices)\b/i;

/**
 * A message, with a note for the model (not shown) on what the songbook has that it may sing: the
 * song it names, or the songs of the artist it (or the message before it: "sing one of them")
 * names; asked to sing something it hasn't got, to say so. So the model neither promises a song it
 * can't sing nor makes one up, nor passes off another's song as the artist's. The notes say "if you
 * sing": they don't ask for a song.
 */
async function withSongbook(message: string, before = ""): Promise<string> {
  const index = await songbook().catch(() => []);
  const artist = artistMentioned(index, message) ?? artistMentioned(index, before);
  // a title inside the artist's name ("Imagine" in "Imagine Dragons") isn't the song asked for
  const named = songMentioned(index, message);
  const inName = (t: string) => artist && t.toLowerCase().split(/\W+/).filter(Boolean).every((w) => artist.artist.toLowerCase().includes(w));
  const song = named && !inName(named.title) ? named : null;
  const notes: string[] = [];
  if (song) notes.push(`if you sing it, the songbook has "${song.title}"${song.artist ? ` by ${song.artist}` : ""}: use a song-ref block with exactly that title`);
  if (artist)
    notes.push(`the songbook's songs by ${artist.artist} are: ${artist.titles.map((t) => `"${t}"`).join(", ")}. To sing one of theirs, use a song-ref block with exactly one of these titles; it has no others of theirs, so never name or sing any other song as theirs`);
  if (!notes.length && /\bsing\b/i.test(message))
    notes.push("the songbook has no score for any song named here. If an existing song was asked for, say plainly you don't have its music yet and offer to sing something else or a song of your own; never write its lyrics or a song block in its place");
  return notes.length ? `${message}\n\n(Note from the app: ${notes.join("; ")}.)` : message;
}import { MOOD, isMood, type Mood } from "../mood.ts";
import { aiInstall, aiPrompt, aiStatus, type AIStatus } from "../chromeAI.ts";
import { OR_AUTO, orFinishSignIn, orKey, orModels, orPrompt, orSignIn, orSignOut, type OrModel } from "../openRouter.ts";

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
  const body = useStore((s) => s.body);
  const f0 = useStore((s) => s.source.f0);
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
  const [rate, setRate] = useState(1.35);
  const [talking, setTalking] = useState(false);
  const sp = useRef<Speaking | null>(null);
  const opts = useRef({ body, f0, rate });
  opts.current = { body, f0, rate };
  const list = useRef<HTMLDivElement>(null);
  const count = useRef(0);
  /** append a message; its index */
  const push = (m: Msg) => {
    setMsgs((ms) => [...ms, m]);
    return count.current++;
  };

  const reveal = (msg: number, shown: number) => setMsgs((m) => m.map((x, i) => (i === msg && shown > x.shown ? { ...x, shown } : x)));

  /** the voice and the face take on a mood */
  const feel = (m: Mood) => {
    const { breathiness, tension, brightness } = MOOD[m].voice;
    setSource({ breathiness, tension, brightness });
    setMood(m);
  };

  const finish = () => {
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
      const para = s.lower.slice(b.start, b.end);
      const song = para.startsWith("♪") ? s.songs.shift() : undefined;
      const text = toSpeech(para);
      if (song || /[a-z]/.test(text)) {
        reveal(s.msg, b.start);
        const mood = isMood(b.mood) ? b.mood : "neutral";
        feel(mood);
        useStore.getState().setArtic(MOUTH_OPEN);
        const v = MOOD[mood].voice, o = opts.current;
        const plan = song ? await singSong(song, o.body) : await speakText(text, { ipa: false, body: o.body, rate: o.rate * v.rate, f0: o.f0 * v.f0 });
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
      if (refs.length) setStatus(`Finding the music for ${refs.map((r) => `“${r.replace(/\s+[-–—]\s+.*$/, "")}”`).join(" and ")}…`);
      const found = new Map(await Promise.all(refs.map(async (q) => [q, (await findSong(q))?.song ?? null] as const)));
      if (!g2p.loaded) {
        setStatus("Getting the words ready…");
        await g2p.load().catch(() => {}); // the letter-to-sound rules still work
      }
      const { display, songs } = extractSongs(clean, found);
      // asked for harmony: up to two backing singers on every song that has fewer of its own
      if (HARMONY.test(message))
        for (const song of songs) {
          const own = song.voices?.length ?? 0;
          if (own < 2) song.voices = [...(song.voices ?? []), ...harmonize(song, 2 - own)];
        }
      const { text, blocks } = moodBlocks(display, isMood);
      const msg = push({ role: "assistant", text, shown: 0 });
      sp.current = { msg, blocks, bi: -1, planId: -1, matched: 0, cursor: 0, lower: text.toLowerCase(), songs };
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
      <Screen className="s-chat" title="Chat" sub={local ? "On-device AI" : "OpenRouter"}
        tools={<Slider label="Rate" value={rate} min={0.5} max={1.8} onChange={setRate} format={(v) => `${v.toFixed(2)}×`} />}
      >
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
            {ready && msgs.length === 0 && <p className="hint">Say something. The answer comes here, and out loud.</p>}
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
