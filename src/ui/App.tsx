import { lazy, Suspense, useEffect, useState } from "react";
import { useStore } from "./store.ts";
import { engine } from "../audio/AudioEngine.ts";
import { Segmented } from "./components/Controls.tsx";
import { Chip, Screen } from "./components/Screen.tsx";
import { ChatRight } from "./components/ChatPanel.tsx";
import type { BodyName } from "../worklet/protocol.ts";
import { bodyLabel, presetOf, PRESETS } from "./body.ts";

// three.js loads after the engine, with the head
const AnatomyView3D = lazy(() => import("./components/AnatomyView3D.tsx").then((m) => ({ default: m.AnatomyView3D })));

function TopBar() {
  const started = useStore((s) => s.started);
  const body = useStore((s) => s.body);
  const setBody = useStore((s) => s.setBody);
  const volume = useStore((s) => s.volume);
  const setVolume = useStore((s) => s.setVolume);
  const [load, setLoad] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setLoad(engine.load), 500);
    return () => clearInterval(id);
  }, []);
  return (
    <header className="topbar">
      <div className="brand">
        <span className="wordmark">Chimera</span>
        <span className="tagline">A voice grown from a simulated airway</span>
      </div>
      <div className="body-control">
        <Segmented<BodyName>
          label="Body"
          value={presetOf(body)}
          onChange={(b) => setBody(PRESETS[b])}
          options={[
            { value: "male", label: "Male" },
            { value: "female", label: "Female" },
            { value: "child", label: "Child" },
          ]}
        />
      </div>
      <div className="topbar-right">
        <label className="volume">
          <span>Volume</span>
          <input type="range" min={0} max={1} step={0.01} value={volume} onChange={(e) => setVolume(Number(e.target.value))} style={{ "--pos": `${volume * 100}%` } as React.CSSProperties} />
        </label>
        {started && (
          <span className="load" title="Share of the audio thread's time budget used by the simulation">
            Engine load {Math.round(load * 100)} %
          </span>
        )}
        <a className="repo-link" href="https://github.com/jamesondh/chimera-vocal-synth" target="_blank" rel="noreferrer" aria-label="Chimera source on GitHub" title="Chimera source on GitHub">
          <svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true">
            <path
              fill="currentColor"
              d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"
            />
          </svg>
        </a>
      </div>
    </header>
  );
}

/** The tall left screen: the 3D head facing the viewer, its airway live (pressure, airflow). */
function LeftScreen() {
  const body = useStore((s) => s.body);
  const xray = useStore((s) => s.view.xray);
  const setView = useStore((s) => s.setView);
  return (
    <Screen
      className="left"
      focus
      title="Vocal tract"
      sub={bodyLabel(body)}
      label="Live vocal tract"
      tools={
        <Chip on={xray} onClick={() => setView({ xray: !xray })} title="Show the tongue, jaw and airway through the face">
          X-ray
        </Chip>
      }
    >
      <Suspense fallback={null}>
        <AnatomyView3D readouts={false} />
      </Suspense>
    </Screen>
  );
}

export function App() {
  // browsers only allow audio after the visitor's first click or key: start it then, wherever it is
  useEffect(() => {
    const go = () => void useStore.getState().start();
    const opts = { once: true, capture: true };
    window.addEventListener("pointerdown", go, opts);
    window.addEventListener("keydown", go, opts);
    return () => {
      window.removeEventListener("pointerdown", go, opts);
      window.removeEventListener("keydown", go, opts);
    };
  }, []);
  return (
    <div className="app text-colors mode-chat">
      <TopBar />
      <main className="wall wall-chat">
        <LeftScreen />
        <ChatRight />
      </main>
    </div>
  );
}
