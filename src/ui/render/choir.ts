/**
 * The other singers of a found song (a choir's alto, tenor, bass, or asked-for harmony), drawn by
 * the head's view into its own canvas, in the space under the head from its bottom-left corner (in
 * rows, wrapping upwards when they don't fit across): a
 * small head each, the same face as the main one, its mouth moving with its own voice (that
 * engine's jaw and lips), its brows, lids and cheeks with its own singing, its name and the word it
 * is singing. Only while such a song plays.
 *
 * One small WebGL renderer draws every head in turn, copied into the view's canvas: browsers allow
 * few WebGL contexts, and the main head has one already.
 */
import * as THREE from "three";
import { engine } from "../../audio/AudioEngine.ts";
import { currentChoir, currentPlan, planNow } from "../speech.ts";
import { loadSkins, type Skin } from "./skin3d.ts";
import { Expression } from "./expression.ts";
import { VoiceModel } from "../analysis.ts";
import { label } from "./vector.ts";
import { V } from "../colors.ts";

/** each head's box, CSS px, and the gap between them and from the canvas's edge */
const W = 96, H = 108, GAP = 10, EDGE = 16;
/** the name and the word under each head */
const CAPTION = 34;

interface Head {
  skin: Skin;
  scene: THREE.Scene;
  face: Expression;
}

export class Choir {
  private gl: THREE.WebGLRenderer | null = null;
  private failed = false;
  private readonly camera = new THREE.PerspectiveCamera(22, W / H, 0.01, 100);
  private readonly heads: Head[] = [];
  private loading = false;
  private gone = false;

  constructor() {
    // the head (a unit tall, centred) fills the box's height, a little room round it
    this.camera.position.set(0, 0, 0.4 / Math.tan((this.camera.fov * Math.PI) / 360));
    this.camera.lookAt(0, 0, 0);
  }

  /** the renderer, made the first time a choir sings and kept, and the heads loading (as many as the choir has, kept) */
  private ready(dpr: number, n: number): boolean {
    if (this.failed) return false;
    if (!this.gl) {
      try {
        this.gl = new THREE.WebGLRenderer({ antialias: true, alpha: true });
      } catch {
        this.failed = true;
        return false;
      }
      this.gl.outputColorSpace = THREE.LinearSRGBColorSpace; // as the main head
      this.gl.setClearColor(0x000000, 0);
    }
    if (this.gl.getPixelRatio() !== dpr) {
      this.gl.setPixelRatio(dpr);
      this.gl.setSize(W, H, false);
    }
    if (this.heads.length < n && !this.loading) {
      this.loading = true;
      loadSkins(this.gl, n - this.heads.length).then(
        (skins) => {
          this.loading = false;
          if (this.gone) return;
          for (const skin of skins) {
            // face the camera (the skin turns the head for the main view), centred, a unit tall
            skin.root.rotation.y = -Math.PI / 2;
            skin.tone(false);
            const box = new THREE.Box3().setFromObject(skin.root);
            const size = box.getSize(new THREE.Vector3()), mid = box.getCenter(new THREE.Vector3());
            const k = 1 / size.y;
            skin.root.scale.setScalar(k);
            skin.root.position.copy(mid).multiplyScalar(-k);
            const scene = new THREE.Scene();
            scene.add(skin.root);
            this.heads.push({ skin, scene, face: new Expression() });
          }
        },
        (err) => {
          this.loading = false;
          console.warn("choir face:", err);
        },
      );
    }
    return this.heads.length > 0;
  }

  /** Draw the singers (if a song with them is playing) along the bottom of a w×h (CSS px) canvas. */
  draw(ctx: CanvasRenderingContext2D, w: number, h: number, dpr: number, dt: number): void {
    const choir = currentChoir();
    const p = currentPlan(), now = planNow(p);
    // the song over (or another one begun): no heads
    if (!choir || !p || (now >= 0 && now > p.plan.end + 0.3)) return;
    if (!this.ready(dpr, choir.length) || !this.gl) return;
    const gl = this.gl;
    // as many to a row as fit, wrapping onto rows above: the last row sits on the bottom edge
    const perRow = Math.max(1, Math.floor((w - 2 * EDGE + GAP) / (W + GAP)));
    const rows = Math.ceil(choir.length / perRow), rowH = H + CAPTION + GAP;
    choir.forEach((part, i) => {
      const x = EDGE + (i % perRow) * (W + GAP);
      const top = h - EDGE - CAPTION - H - (rows - 1 - Math.floor(i / perRow)) * rowH;
      const head = this.heads[i];
      if (!head || i >= engine.choirSinging) return; // shed by a busy audio thread
      const tele = engine.choirLatest(i);
      head.face.update(tele, dt);
      if (tele) head.skin.drive(VoiceModel.articFromArray(tele.t.artic), head.face, 0, 0);
      gl.render(head.scene, this.camera);
      ctx.drawImage(gl.domElement, x, top, W, H);
      const word = part.words.find((x) => x.t0 <= now && now < x.t1)?.text ?? "";
      label(ctx, part.name.toUpperCase(), x + W / 2, top + H + 12, { size: 10, color: V.blue, align: "center", ls: 0.14 });
      if (word) label(ctx, word, x + W / 2, top + H + 28, { size: 12, color: V.white, align: "center", ls: 0.04 });
    });
  }

  dispose(): void {
    this.gone = true;
    this.gl?.dispose();
    this.gl?.forceContextLoss();
  }
}
