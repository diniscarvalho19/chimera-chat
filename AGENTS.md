# Chimera Chat

A chat with an AI model, given a voice: the CHIMERA engine (Rust → wasm in an AudioWorklet) and its live
head on the left, a chat panel on the right. See the README. The full upstream CHIMERA repo
(docs, CLI, judges, other modes) is checked out in `~/chimera-vocal-synth`: read it there, don't
copy it back unless it serves the chat or the face.

## Map

- `crates/chimera/`: the engine (no I/O). `crates/chimera-wasm/`: the browser's C ABI. Both are
  upstream's `main` as of `c6147d01` (2026-11-18: #41's hill climb, the language front ends Korean,
  Mandarin, pinyin and Russian), unchanged except for hugoriosbrito/chimera-pt-br's Brazilian
  Portuguese (`phonetics/portuguese.rs`; its nasal vowels are upstream's tilde), as a front end
  asked for by name (`lyricsToSyllablesPt`, `g2pPtPhrases`). To update: take upstream's two crates
  whole, then add the module, its four calls in `api.rs` and the two `pub(crate)` helpers in
  `english.rs` back. Italian is sung by `src/ui/italian.ts`. Both are a song's `lang` ("it",
  "pt"): the router picks a front end by script, and theirs is English's.
- `src/ui/chromeAI.ts`: the model (Chrome's on-device AI): status, install with progress, prompt.
  `src/voicePrompt.ts`: its system prompt.
- `src/ui/components/ChatPanel.tsx`: the chat, the paragraph queue, the reveal synced to speech.
  `src/ui/chatText.ts`: paragraphs and speakable text.
- `src/ui/speech.ts`: text (or a song) → plan → worklet. `src/ui/mood.ts`: each mood's voice and face.
- `src/ui/songbook.ts`: real songs asked for by name (a `song-ref` block), found in `public/songs/`
  and converted in the browser by `src/ui/musicxml.ts`. `tools/build-songbook.ts` builds the songbook
  from PDMX (MuseScore scores marked public domain or CC0).
  A score's other parts are the band (`playParts` in `src/ui/backing.ts`); its other sung parts are
  sung by extra worklet nodes (`AudioEngine.singChoir`), drawn as small heads under the main one
  (`src/ui/render/choir.ts`).
- `src/ui/components/AnatomyView3D.tsx`, `src/ui/render/`: the head (3D, facing the viewer).
- `src/wasm/`: the UI's facade over the engine. `src/worklet/`: the AudioWorklet.

## Rules

- **The engine's contract** (upstream `docs/rust-engine.md`): transcendental math only through
  `chimera::math`, no allocation while rendering, output independent of block size.
  `cargo test` enforces each. Any change to the sound or the plans fails the golden tests.
- **`src/wasm/chimera.wasm` is a gitignored build product.** After a Rust change use
  `bun run test`, not `bun test tests` alone.
- **Gesture records are defined twice**, in `crates/chimera-wasm/src/lib.rs` and
  `src/wasm/wire.ts`. Change both and bump `LAYOUT_VERSION`.
- **The wasm loads before the UI.** A module that calls the engine at import must not be reachable
  from `src/main.tsx`'s static imports.
- **DOM content flows in `.screen-body`, never absolutely positioned.**

## Checks

`bun run typecheck` and `bun run test` after any change.
