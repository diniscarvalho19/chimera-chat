import { useEffect, useRef, useState } from "react";
import { useStore } from "../store.ts";
import { speakText, singSong, stopSpeaking, currentPlan, planNow } from "../speech.ts";
import { Slider } from "./Controls.tsx";
import { Screen } from "./Screen.tsx";
import { extractSongs, moodBlocks, toSpeech, type MoodBlock, type Song } from "../chatText.ts";
import { MOOD, isMood, type Mood } from "../mood.ts";
import { aiInstall, aiPrompt, aiStatus, type AIStatus } from "../chromeAI.ts";

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
  }, []);
  const ready = ai === "available";
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
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
      await start();
      const reply = await aiPrompt(message);
      const { display, songs } = extractSongs(reply.replace(/’/g, "'"));
      const { text, blocks } = moodBlocks(display, isMood);
      const msg = push({ role: "assistant", text, shown: 0 });
      sp.current = { msg, blocks, bi: -1, planId: -1, matched: 0, cursor: 0, lower: text.toLowerCase(), songs };
      setTalking(true);
      void next();
    } catch (e) {
      push({ role: "error", text: String((e as Error).message ?? e), shown: Infinity });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="right right-chat">
      <Screen className="s-chat" title="Chat" sub="On-device AI" tools={<Slider label="Rate" value={rate} min={0.5} max={1.8} onChange={setRate} format={(v) => `${v.toFixed(2)}×`} />}>
        <div className="chat">
          <div className="chat-log" ref={list} aria-live="polite">
            {!ready && <AiSetup status={ai} progress={progress} onInstall={install} />}
            {ready && msgs.length === 0 && <p className="hint">Say something. The answer comes here, and out loud.</p>}
            {msgs.map((m, i) => (
              <div key={i} className={`chat-msg chat-${m.role}`}>
                {m.text.slice(0, m.shown)}
              </div>
            ))}
            {busy && <div className="chat-msg chat-assistant chat-thinking">Thinking…</div>}
          </div>
          <div className="say-row chat-input">
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
              placeholder={ready ? "Type a message (Enter to send, Shift+Enter for a new line)" : "Install the on-device model to chat"}
            />
            <div className="say-actions">
              <button className="primary" onClick={() => void send()} disabled={busy || !ready || !input.trim()}>
                {busy ? "Waiting…" : "Send"}
              </button>
              {talking && (
                <>
                  <button className="ghost" onClick={skip}>
                    Skip
                  </button>
                  <button className="ghost" onClick={stop}>
                    Stop
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      </Screen>
    </div>
  );
}

/** Until the model is on this device: what's needed, the install button, the download's progress. */
function AiSetup(props: { status: AIStatus | "checking" | "failed"; progress: number; onInstall: () => void }) {
  const { status, progress } = props;
  if (status === "checking") return <p className="hint">Checking for the on-device AI…</p>;
  if (status === "no-api" || status === "unavailable")
    return (
      <div className="ai-setup">
        <p>This chat runs an AI model on your own device, with Chrome&apos;s built-in AI.</p>
        <p className="hint">{status === "no-api" ? "Open it in Chrome 148 or newer on a computer." : "This device can't run Chrome's on-device model (it needs more memory, disk space or graphics power)."}</p>
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
