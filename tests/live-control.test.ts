/**
 * Ownership and ordering of live control: the worklet applies messages in the order they arrive,
 * to the voice they were meant for (score messages right after a body change play on the new
 * voice; a beat stop cancels a hit sent just before it), and MIDI notes held on several
 * keyboards/channels end only when the last one lets go. (Tagged releases: crates/chimera/tests/live_control.rs.)
 */
import { describe, expect, test } from "bun:test";
import { wasmModule } from "./harness.ts";
import { fromUtf8 } from "../src/wasm/wire.ts";

describe("worklet ordering", () => {
  test("a note scheduled right after a body change plays on the new voice; a stop cancels what came before it", async () => {
    type Proc = { port: { onmessage: ((e: { data: unknown }) => void) | null }; process: (i: unknown, o: Float32Array[][]) => boolean };
    let Ctor: (new (o: unknown) => Proc) | null = null;
    const posted: { type: string; body?: unknown; message?: string }[] = [];
    const g = globalThis as Record<string, unknown>;
    g.sampleRate = 48000;
    g.AudioWorkletProcessor = class {
      port = { onmessage: null as unknown, postMessage: (m: { type: string }) => posted.push(m) };
    };
    g.registerProcessor = (_name: string, ctor: typeof Ctor) => (Ctor = ctor);
    await import("../src/worklet/processor.ts");
    const p = new Ctor!({ processorOptions: { module: wasmModule } });
    const send = (data: unknown) => p.port.onmessage!({ data });
    const block = () => p.process([], [[new Float32Array(128)]]);
    // the processor's engine, for inspection
    const { x, h } = p as unknown as { x: Record<string, (...a: number[]) => number> & { memory: WebAssembly.Memory }; h: number };
    const scoreSize = () => {
      x.engine_score_json(h);
      return JSON.parse(fromUtf8(new Uint8Array(x.memory.buffer, x.chimera_result_ptr(), x.chimera_result_len()))).length;
    };
    const body = () => ({ female: x.engine_body_female(h), child: x.engine_body_child(h) });
    const FEMALE = { female: 1, child: 0 }, MALE = { female: 0, child: 0 }, CHILD = { female: 0, child: 1 };

    const breath = { t0: 0, t1: 1, rampIn: 0.04, rampOut: 0.05, strength: 1, targets: { breath: 1 }, label: "breath" };
    send({ type: "body", body: FEMALE });
    send({ type: "schedule", gestures: [breath], segments: [], end: 1, id: 1, replace: false, lead: 0.006 });
    block();
    expect(body()).toEqual(FEMALE); // the new voice
    expect(posted.filter((m) => m.type === "ready").at(-1)?.body).toEqual(FEMALE);
    expect(scoreSize()).toBe(1); // holding the note

    // a beat stop sent after a hit, around a body change, still cancels that hit
    send({ type: "beat", steps: [{ id: "B" }, null, null, null], bpm: 96, playing: true });
    for (let i = 0; i < 20; i++) block();
    send({ type: "body", body: MALE });
    send({ type: "beatHit", id: "B" });
    send({ type: "beat", playing: false });
    block();
    expect(body()).toEqual(MALE);
    expect(scoreSize()).toBe(0);

    // three full-size schedules, then a stop: the stop comes after all three
    const big = Array.from({ length: 4000 }, (_, i) => ({ ...breath, t0: 1 + i * 1e-3, t1: 1.5 + i * 1e-3, label: `g${i}` }));
    send({ type: "body", body: CHILD });
    for (let k = 0; k < 3; k++) send({ type: "schedule", gestures: big, segments: [], end: 1, id: 10 + k, replace: false });
    expect(scoreSize()).toBe(12000);
    send({ type: "stopSpeech" });
    block();
    expect(scoreSize()).toBe(0);
    expect(posted.filter((m) => m.type === "error")).toEqual([]);
  });
});
