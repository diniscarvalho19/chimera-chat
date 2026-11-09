/**
 * The fallback model where Chrome's built-in AI isn't (phones, other browsers): OpenRouter, signed
 * in with its OAuth PKCE flow. No backend: the browser trades the sign-in's code for a key, keeps it
 * in localStorage and calls the API directly. The free models router costs the viewer nothing.
 */
import { VOICE_PROMPT } from "../voicePrompt.ts";

const KEY = "openrouter-key";
const VERIFIER = "openrouter-verifier";
/**
 * The menu's "Auto": OpenRouter's router picks a strong model for each message, paid from the
 * account's credits; with no credits (or once they run out) its free router answers instead.
 */
export const OR_AUTO = "auto";
const BEST = "openrouter/auto";
const FREE = "openrouter/free";
/** false once OpenRouter says the account can't pay (free tier, or the credits ran out) */
let credits = true;
const API = "https://openrouter.ai/api/v1";

export function orKey(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

const b64url = (bytes: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

/** Off to OpenRouter's sign-in; it comes back to this page with `?code=`. */
export async function orSignIn() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  sessionStorage.setItem(VERIFIER, verifier);
  const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  const q = new URLSearchParams({ callback_url: location.origin + location.pathname, code_challenge: challenge, code_challenge_method: "S256" });
  location.href = `https://openrouter.ai/auth?${q}`;
}

/** Back from the sign-in: trade the code for a key. False when this page load isn't that return. */
export async function orFinishSignIn(): Promise<boolean> {
  const url = new URL(location.href);
  const code = url.searchParams.get("code");
  if (!code) return false;
  url.searchParams.delete("code");
  history.replaceState(null, "", url); // before the await: a second call sees no code
  const r = await fetch(`${API}/auth/keys`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, code_verifier: sessionStorage.getItem(VERIFIER), code_challenge_method: "S256" }),
  });
  if (!r.ok) throw new Error(`OpenRouter sign-in failed (${r.status}). Try again.`);
  localStorage.setItem(KEY, ((await r.json()) as { key: string }).key);
  return true;
}

const convo: { role: string; content: string }[] = [{ role: "system", content: VOICE_PROMPT }];

/** One turn of the conversation. A rejected key signs out (`orKey()` is null after). */
export async function orPrompt(message: string, model: string): Promise<string> {
  const tries = model !== OR_AUTO ? [model] : credits ? [BEST, FREE] : [FREE];
  for (const [i, m] of tries.entries()) {
    const r = await fetch(`${API}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${orKey()}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: m, messages: [...convo, { role: "user", content: message }] }),
    });
    if (r.status === 401) localStorage.removeItem(KEY);
    // 402: no credits left. Auto moves down to the free models, and stays there
    if (r.status === 402 && m === BEST) credits = false;
    if (!r.ok && r.status !== 401 && i < tries.length - 1) continue;
    if (!r.ok) throw new Error(r.status === 401 ? "OpenRouter signed you out. Sign in again." : r.status === 402 ? "No OpenRouter credits left for this model. Pick Auto or a free model." : `OpenRouter error ${r.status}: ${await r.text()}`);
    const reply = ((await r.json()) as { choices: { message: { content: string } }[] }).choices[0].message.content;
    convo.push({ role: "user", content: message }, { role: "assistant", content: reply });
    return reply;
  }
  throw new Error("OpenRouter gave no answer");
}

/** Forget the key and the conversation: the chat goes back to the on-device AI or the sign-in. */
export function orSignOut() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // nothing stored
  }
  convo.length = 1;
  credits = true;
}

export interface OrModel {
  id: string;
  name: string;
  free: boolean;
}

/**
 * The signed-in account's models: those its provider preferences, privacy settings and guardrails
 * allow, and only the free ones on an account that never bought credits. None when signed out.
 */
export async function orModels(): Promise<OrModel[]> {
  const key = orKey();
  if (!key) return [];
  const auth = { headers: { Authorization: `Bearer ${key}` } };
  const [models, account] = await Promise.all([fetch(`${API}/models/user`, auth), fetch(`${API}/key`, auth)]);
  if (!models.ok) return [];
  const { data } = (await models.json()) as { data: { id: string; name: string; pricing?: { prompt?: string; completion?: string }; architecture?: { output_modalities?: string[] } }[] };
  const freeTier = account.ok && ((await account.json()) as { data?: { is_free_tier?: boolean } }).data?.is_free_tier === true;
  credits = !freeTier;
  return data
    // chat models only: not the routers (Auto covers them), music/audio makers or batch-only variants
    .filter((m) => !m.id.startsWith("openrouter/") && !m.id.endsWith(":batch") && !m.architecture?.output_modalities?.some((o) => o !== "text"))
    .map((m) => ({ id: m.id, name: m.name, free: m.id.endsWith(":free") || (m.pricing?.prompt === "0" && m.pricing?.completion === "0") }))
    .filter((m) => m.free || !freeTier)
    .sort((a, b) => a.name.localeCompare(b.name));
}
