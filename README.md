# Chimera Chat

Chat with an on-device AI model through a simulated voice. The live vocal-tract head (3D, facing you) is on
the left, the chat on the right. Each reply is spoken one paragraph at a time, and the text appears
word by word in step with the voice.

Live at **https://chimera-chat.pages.dev** (Cloudflare Pages). It isn't connected to the repo: a push
deploys nothing. Deploy by hand after `bun run build`:
`bunx wrangler pages deploy dist --project-name chimera-chat --branch main`.

Built on [CHIMERA](https://github.com/jamesondh/chimera-vocal-synth), a physical-modeling voice
synthesizer (Rust engine compiled to WebAssembly for an AudioWorklet). Everything else from
CHIMERA (play, speak, sing, beatbox, bestiary, duet, CLI, docs, research tools) was removed here.

## What it adds to CHIMERA

- **A face.** The 3D head wears a face (the Face Cap head's 52 ARKit shapes) driven by the
  engine's articulators: the lips, jaw and tongue you see are the ones making the sound. It blinks,
  puffs its cheeks behind closed lips, raises its brows with the pitch, nods with the vibrato, and
  holds each mood (smile, brows, lids, tilt). X-ray shows the tongue, jaw and airway through it.
  Pet the top of its head and it closes its eyes and floats hearts. `src/ui/render/`.
- **Moods and voices.** The model tags what it says with a mood (`[happy]`, `[sad]`, `[curious]`…)
  that sets both the voice and the face, and can change the voice itself with a voice tag
  (`[voice female=1]`, `[voice child=1 pitch=1.2]`, `[voice pitch=0.8 roughness=0.6]`) to sound
  different or play a character. `src/ui/mood.ts`, `src/voicePrompt.ts`.
- **Music.** The model writes and sings its own songs (lyrics, notes and chords, with a band
  under the voice), or sings real ones by name from a songbook of about 20,000 public-domain and
  CC0 MuseScore scores ([PDMX](https://github.com/pnlong/PDMX)), converted in the browser: the
  tune with its words (or on "la" when it has none), the score's other parts as the band, its
  other sung parts by a choir of small heads under the main one, each on its own audio thread.
  Asked a cappella, voices take the band's parts: a bass, a backing and middle voice, and a
  beatboxer. The app searches the songbook for what you ask and tells the model what it has.
  `src/ui/songbook.ts`, `src/ui/musicxml.ts`, `src/ui/backing.ts`, `tools/build-songbook.ts`.
- **Languages.** Besides English, it speaks and sings Brazilian Portuguese (from
  [@hugoriosbrito](https://github.com/hugoriosbrito)'s fork,
  [chimera-pt-br](https://github.com/hugoriosbrito/chimera-pt-br)), and sings Italian.

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
missing. Optionally, you can sign in with [OpenRouter](https://openrouter.ai) instead and chat
through its models (free ones by default); then your messages go to OpenRouter. `src/ui/chromeAI.ts`; the system prompt (short spoken paragraphs, a mood tag per
paragraph, song blocks) is `src/voicePrompt.ts`.

## Release

A static site: `bun run build` writes `dist/`, which any static host serves (it needs HTTPS for
the AudioWorklet). `bun run preview` serves the build locally.

## License

[MIT](LICENSE). Bundled third-party files keep their own licenses: the CMU Pronouncing
Dictionary ([public/data/CMUDICT-LICENSE.txt](public/data/CMUDICT-LICENSE.txt)) and the fonts
([public/fonts/](public/fonts/)).
