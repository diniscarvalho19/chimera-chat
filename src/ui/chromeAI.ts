/**
 * The model: Chrome's built-in AI (the Prompt API, Gemini Nano on the viewer's own machine). No
 * key, no server, nothing leaves the browser. It needs Chrome 148+ on hardware that can run the
 * model, which downloads once (the install step); the session then keeps the conversation.
 */
import { VOICE_PROMPT } from "../voicePrompt.ts";

/** "no-api": not Chrome, or too old; "unavailable": Chrome, but this device can't run the model */
export type AIStatus = "no-api" | "unavailable" | "downloadable" | "downloading" | "available";

interface Session {
  prompt(text: string): Promise<string>;
}
interface LanguageModelStatic {
  availability(o?: object): Promise<Exclude<AIStatus, "no-api">>;
  create(o?: object): Promise<Session>;
}

// English in, English out (the voice speaks English)
const LANGS = { expectedInputs: [{ type: "text", languages: ["en"] }], expectedOutputs: [{ type: "text", languages: ["en"] }] };

function api(): LanguageModelStatic | null {
  return (globalThis as { LanguageModel?: LanguageModelStatic }).LanguageModel ?? null;
}

export async function aiStatus(): Promise<AIStatus> {
  const lm = api();
  if (!lm) return "no-api";
  try {
    return await lm.availability(LANGS);
  } catch {
    return "unavailable";
  }
}

let session: Promise<Session> | null = null;

/**
 * Get the model ready: downloads it if it isn't on the device yet (call it from a click: Chrome
 * only starts a download on a user's gesture). `onProgress` gets 0..1 while it downloads.
 */
export function aiInstall(onProgress: (fraction: number) => void = () => {}): Promise<Session> {
  const lm = api();
  if (!lm) return Promise.reject(new Error("This browser has no built-in AI"));
  session ??= lm
    .create({
      ...LANGS,
      initialPrompts: [{ role: "system", content: VOICE_PROMPT }],
      monitor(m: EventTarget) {
        m.addEventListener("downloadprogress", (e) => onProgress((e as ProgressEvent).loaded));
      },
    })
    .catch((e) => {
      session = null; // a failed install can be tried again
      throw e;
    });
  return session;
}

/** One turn of the conversation. */
export async function aiPrompt(message: string): Promise<string> {
  return (await aiInstall()).prompt(message);
}
