import { expect, test } from "bun:test";
import { changedVoice, DEFAULT_VOICE } from "../src/ui/chatText.ts";

test("the model's voice: a man by default; a tag changes only what it names, and stays; default resets", () => {
  let v = { body: { female: 0, child: 0 }, voice: DEFAULT_VOICE };
  v = changedVoice(v, { female: 1, pitch: 1.2 });
  expect(v).toEqual({ body: { female: 1, child: 0 }, voice: { pitch: 1.2, rate: 1 } });
  v = changedVoice(v, { breathiness: 0.4 });
  expect(v).toEqual({ body: { female: 1, child: 0 }, voice: { pitch: 1.2, rate: 1, breathiness: 0.4 } });
  v = changedVoice(v, { reset: true, child: 1 });
  expect(v).toEqual({ body: { female: 0, child: 1 }, voice: DEFAULT_VOICE });
});
