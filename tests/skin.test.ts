import { expect, test } from "bun:test";
import { articToMorphs } from "../src/ui/render/skin3d.ts";

const rest = { puff: 0, brow: 0, lid: 0, smile: 0, think: 0 };
const artic = { jaw: 0.6, tbX: 2.9, tbY: 6.85, ttX: 6.45, ttY: 7.3, ttCurl: 0, root: 0, lipAp: 0.7, lipProt: 0.2, lipWidth: 0.5, labiodental: 0, velum: -0.15, larynx: 0, epilarynx: 0, ventricular: 0, lateral: 0, dorsum: 0 };

test("the face follows the articulators", () => {
  const open = articToMorphs({ ...artic, jaw: 2.6, lipAp: 2 }, rest);
  expect(open.jawOpen).toBeGreaterThan(0.6);
  expect(open.mouthClose).toBe(0);
  // m with the jaw open: the lips close over the gap
  const m = articToMorphs({ ...artic, jaw: 1.3, lipAp: -0.2 }, rest);
  expect(m.mouthClose).toBeCloseTo(m.jawOpen);
  expect(articToMorphs({ ...artic, lipProt: 1.3, lipWidth: 0.1, lipAp: 0.2 }, rest).mouthPucker).toBeGreaterThan(0.8);
  expect(articToMorphs({ ...artic, labiodental: 1 }, rest).mouthRollLower).toBe(1);
  for (const w of Object.values(articToMorphs(artic, { puff: 1.25, brow: -1, lid: 1, smile: 1.1, think: 1 }))) expect(w).toBeLessThanOrEqual(1);
});
