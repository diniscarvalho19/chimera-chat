# Chimera Chat

Chat with an on-device AI model through a simulated voice. The live vocal-tract head (3D, facing you) is on
the left, the chat on the right. Each reply is spoken one paragraph at a time, and the text appears
word by word in step with the voice.

Built on [CHIMERA](https://github.com/jamesondh/chimera-vocal-synth), a physical-modeling voice
synthesizer (Rust engine compiled to WebAssembly for an AudioWorklet). Everything else from
CHIMERA (play, speak, sing, beatbox, bestiary, duet, CLI, docs, research tools) was removed here;
a full upstream checkout lives in `~/chimera-vocal-synth` for reference.

## Run it

Needs Rust with the `wasm32-unknown-unknown` target and Bun.

```sh
bun install
bun run dev        # builds the wasm, then Vite on 127.0.0.1:5317
bun run test       # wasm build, cargo test --workspace, bun test tests
```

## The model

The chat runs on **Chrome's built-in AI** (the Prompt API: Gemini Nano on the visitor's own
machine), so there's no server, no API key and no account, and nothing leaves the browser. It needs
Chrome 148+ on hardware that can run the model. On a device without it, the chat offers to
install it (a one-time download of a few GB) with a progress bar; elsewhere it says what's
missing. `src/ui/chromeAI.ts`; the system prompt (short spoken paragraphs, a mood tag per
paragraph, song blocks) is `src/voicePrompt.ts`.

## Release

A static site: `bun run build` writes `dist/`, which any static host serves (it needs HTTPS for
the AudioWorklet). `bun run preview` serves the build locally.

## License

[MIT](LICENSE). Bundled third-party files keep their own licenses: the CMU Pronouncing
Dictionary ([public/data/CMUDICT-LICENSE.txt](public/data/CMUDICT-LICENSE.txt)) and the fonts
([public/fonts/](public/fonts/)).
