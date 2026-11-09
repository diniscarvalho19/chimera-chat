/**
 * A skinned face over the 3D head: the three.js examples' Face Cap head (52 ARKit blendshapes),
 * placed on the anatomy's eyes and driven by the engine's articulators and the face's expression.
 * The anatomy's lines still draw over it (they ignore depth), so the tongue, jaw and airway show
 * through like an X-ray.
 *
 * ponytail: one fixed head for every body (scaled on the eyes, so a child's is a small adult's);
 * a body-specific mesh, or morphing towards the child's proportions, when that matters.
 */
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { KTX2Loader } from "three/addons/loaders/KTX2Loader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import type { HumanArtic } from "../../wasm/types.ts";
import type { Expression } from "./expression.ts";

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const smooth = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

/** ARKit blendshape weights from the articulators and the expression (pure: tested) */
export function articToMorphs(a: HumanArtic, e: Pick<Expression, "puff" | "brow" | "lid" | "smile" | "think">): Record<string, number> {
  // ARKit's full jawOpen is a scream; the engine's widest jaw (2.6 cm at the incisors) is a wide "ah"
  const jawOpen = clamp01(a.jaw / 3.6);
  // lips shut (p, b, m) while the jaw is open: the lips close over the gap
  const shut = 1 - smooth(0, 0.45, a.lipAp);
  // lips apart beyond what the jaw gives
  const part = clamp01((a.lipAp - 0.6 - 0.5 * a.jaw) / 1.2);
  const round = clamp01(a.lipProt / 1.3);
  const spread = clamp01((a.lipWidth - 0.5) * 2), narrow = clamp01((0.5 - a.lipWidth) * 2);
  const smile = Math.max(0, e.smile), frown = Math.max(0, -e.smile);
  const pucker = clamp01(0.8 * round + 0.4 * narrow);
  const m: Record<string, number> = {
    jawOpen,
    mouthClose: jawOpen * shut,
    mouthPress: 0.6 * smooth(-0.4, 0, -a.lipAp) + 0.4 * e.think,
    mouthPucker: pucker * (1 - smooth(0.3, 1.2, a.lipAp)),
    mouthFunnel: pucker * smooth(0.3, 1.2, a.lipAp),
    mouthRollLower: a.labiodental,
    mouthUpperUp: clamp01(0.5 * part + 0.35 * a.labiodental),
    mouthLowerDown: 0.5 * part * (1 - a.labiodental),
    mouthStretch: 0.6 * spread,
    mouthSmile: clamp01(0.25 * spread + 0.7 * smile),
    mouthFrown: 0.6 * frown,
    cheekPuff: clamp01(e.puff),
    browInnerUp: clamp01(0.8 * Math.max(0, e.brow)),
    browOuterUp: clamp01(0.6 * Math.max(0, e.brow)),
    browDown: clamp01(0.7 * Math.max(0, -e.brow)),
    eyeBlink: clamp01(e.lid),
    eyeWide: clamp01(0.5 * Math.max(0, e.brow)) * (1 - clamp01(e.lid)),
  };
  return m;
}

export class Skin {
  readonly root = new THREE.Group();
  private readonly head: THREE.Mesh;
  /** the eyeballs, each on a pivot at its centre */
  private readonly eyes: THREE.Group[] = [];
  /** eye midpoint and the mouth's height in the model's own frame (after the turn to face +x) */
  private readonly eyeMid: THREE.Vector3;
  private readonly mouthY: number;
  private readonly eyeGap: number;
  private placedFor = NaN;
  private readonly materials: THREE.MeshStandardMaterial[] = [];
  private glowing: boolean | null = null;

  /**
   * Darker than life, so the lines stay the bright thing. Under the view's glow (with the lines)
   * a little darker still: the glow brightens it about half again.
   */
  tone(glow: boolean): void {
    if (glow === this.glowing) return;
    this.glowing = glow;
    for (const m of this.materials) m.color.setScalar(glow ? 0.55 : 0.95);
  }

  constructor(scene: THREE.Object3D) {
    // the Face Cap head looks down +z; the anatomy's face looks down +x
    scene.rotation.y = Math.PI / 2;
    this.root.add(scene);
    this.root.updateMatrixWorld(true);
    this.head = scene.getObjectByName("head")!.children[0] as THREE.Mesh;
    const c = ["eyeLeft", "eyeRight"].map((n) => {
      const node = scene.getObjectByName(n)!, ball = node.children[0];
      const centre = new THREE.Box3().setFromObject(ball).getCenter(new THREE.Vector3());
      const pivot = new THREE.Group();
      node.add(pivot);
      pivot.position.copy(node.worldToLocal(centre.clone()));
      pivot.attach(ball);
      this.eyes.push(pivot);
      return centre;
    });
    this.eyeMid = c[0].clone().add(c[1]).multiplyScalar(0.5);
    this.eyeGap = c[0].distanceTo(c[1]);
    this.mouthY = mouthCorner(this.head).y;
    scene.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
      if (m && !this.materials.includes(m)) {
        m.roughness = 0.75;
        this.materials.push(m);
      }
    });
    this.tone(true);
    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(40, 30, 25);
    this.root.add(key, new THREE.HemisphereLight(0xbfd4ff, 0x101018, 0.9));
  }

  /**
   * Fit the head on the anatomy (body cm): one scale (no stretching), between the one that matches
   * the eyes' gap and the one that matches eyes to mouth, centred halfway down from eyes to mouth.
   */
  place(eyeMid: THREE.Vector3, eyeGap: number, mouthY: number): void {
    if (mouthY === this.placedFor) return;
    this.placedFor = mouthY;
    const sw = eyeGap / this.eyeGap, sh = (eyeMid.y - mouthY) / (this.eyeMid.y - this.mouthY);
    const k = Math.sqrt(sw * sh);
    this.root.scale.setScalar(k);
    this.root.position.copy(eyeMid).addScaledVector(this.eyeMid, -k);
    this.root.position.y = (eyeMid.y + mouthY) / 2 - (k * (this.eyeMid.y + this.mouthY)) / 2;
  }

  /** gaze: radians, pitch up and yaw towards the anatomy's +z */
  drive(a: HumanArtic, e: Expression, pitch: number, yaw: number): void {
    // the anatomy's +z is the face's right: the right eye looks out, the left one in
    const right = yaw / 0.7, up = pitch / 0.5;
    const w: Record<string, number> = {
      eyeLookOut_R: right, eyeLookIn_L: right, eyeLookOut_L: -right, eyeLookIn_R: -right,
      eyeLookUp_L: up, eyeLookUp_R: up, eyeLookDown_L: -up, eyeLookDown_R: -up,
    };
    for (const [name, v] of Object.entries(articToMorphs(a, e))) w[name] = w[name + "_L"] = w[name + "_R"] = v;
    const dict = this.head.morphTargetDictionary!, inf = this.head.morphTargetInfluences!;
    inf.fill(0);
    for (const name in w) {
      const i = dict[name];
      if (i !== undefined) inf[i] = clamp01(w[name]);
    }
    // the head looks down its +z, and the face's right is its −x
    for (const eye of this.eyes) eye.rotation.set(-pitch, -yaw, 0, "YXZ");
  }
}

/** a corner of the mouth, in the root's frame: the vertex the smile moves furthest */
function mouthCorner(head: THREE.Mesh): THREE.Vector3 {
  const g = head.geometry, d = g.morphAttributes.position![head.morphTargetDictionary!.mouthSmile_L];
  let best = 0, at = 0;
  for (let i = 0; i < d.count; i++) {
    const m = d.getX(i) ** 2 + d.getY(i) ** 2 + d.getZ(i) ** 2;
    if (m > best) {
      best = m;
      at = i;
    }
  }
  return new THREE.Vector3().fromBufferAttribute(g.attributes.position, at).applyMatrix4(head.matrixWorld);
}

/** load the head (needs the renderer, for which compressed textures it can take) */
export async function loadSkin(gl: THREE.WebGLRenderer): Promise<Skin> {
  const ktx2 = new KTX2Loader().setTranscoderPath(`${import.meta.env.BASE_URL}basis/`).detectSupport(gl);
  try {
    const gltf = await new GLTFLoader().setKTX2Loader(ktx2).setMeshoptDecoder(MeshoptDecoder).loadAsync(`${import.meta.env.BASE_URL}models/facecap.glb`);
    return new Skin(gltf.scene);
  } finally {
    ktx2.dispose();
  }
}
