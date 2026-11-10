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
import { MOUTH_SHUT } from "../store.ts";
import type { HumanArtic } from "../../wasm/engine.ts";
/** each head's box, CSS px, the gap between them and from the canvas's edge, and the room left
 *  in the middle, under the main head, which the choir flanks */
const W = 96, H = 108, GAP = 32, EDGE = 16, MID = 180;
/** the name and the word under each head */
const CAPTION = 60;
/** a part's name breaks onto a second line past this width (the gap between heads is shared) */
const NAME_W = W + GAP - 10;
/** the chat's libretto (styles.css): ink, faint ink, the cue amber; its fonts */
const INK = "#ece5d5", FAINT = "#8f8672", CUE = "#d4ab62";
const NAME_FONT = '500 12px "Archivo", system-ui, sans-serif', WORD_FONT = 'italic 18px "Newsreader", Georgia, serif';
/** a word stays up this long after it ends (s), so the caption doesn't blink between words; past it the part rests */
const HOLD = 0.6;

interface Head {
  skin: Skin;
  scene: THREE.Scene;
  face: Expression;
  /** 1 singing, fading towards REST resting */
  alpha: number;
  /** 0 singing → 1 resting: the mouth closes, the head bows and the eyes drop */
  rest: number;
  /** its voice's mouth, last heard */
  artic: HumanArtic | null;
}

const REST = 0.45;

export class Choir {
  private gl: THREE.WebGLRenderer | null = null;
  private failed = false;
  private readonly camera = new THREE.PerspectiveCamera(22, W / H, 0.01, 100);
  private readonly heads: Head[] = [];
  private loading = false;
  private gone = false;
  /** the choir last drawn: a new one fades in from the dark */
  private last: unknown = null;

  constructor() {
    // the head (a unit tall, centred) fills the box's height, a little room round it
    this.camera.position.set(0, 0, 0.4 / Math.tan((this.camera.fov * Math.PI) / 360));
    this.camera.lookAt(0, 0, 0);
    void document.fonts?.load(WORD_FONT).catch(() => {}); // the canvas only draws a face the page has loaded
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
            this.heads.push({ skin, scene, face: new Expression(), alpha: 0, rest: 0, artic: null });
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
    if (choir !== this.last) {
      this.last = choir;
      for (const head of this.heads) head.alpha = 0;
    }
    // half the choir to each side of the main head, as many to a side as fit, wrapping onto rows
    // above: the last row sits on the bottom edge
    const perSide = Math.max(1, Math.floor((w / 2 - MID / 2 - EDGE + GAP) / (W + GAP))), per = 2 * perSide;
    const rows = Math.ceil(choir.length / per), rowH = H + CAPTION + GAP;
    choir.forEach((part, i) => {
      const row = Math.floor(i / per), k = i % per;
      const left = Math.ceil(Math.min(per, choir.length - row * per) / 2);
      const x = k < left ? w / 2 - MID / 2 - (left - k) * (W + GAP) + GAP : w / 2 + MID / 2 + (k - left) * (W + GAP);
      const top = h - EDGE - CAPTION - H - (rows - 1 - row) * rowH;
      const head = this.heads[i];
      if (!head || i >= engine.choirSinging) return; // shed by a busy audio thread
      const tele = engine.choirLatest(i);
      head.face.update(tele, dt);
      if (tele) head.artic = VoiceModel.articFromArray(tele.t.artic);
      let word = "";
      for (let j = part.words.length - 1; j >= 0; j--) {
        const x = part.words[j]; // the last word begun, while it lasts or is held
        if (x.t0 > now) continue;
        if (now < x.t1 + HOLD) word = x.text;
        break;
      }
      // a resting part fades in about 200 ms, and settles: mouth shut, head bowed, eyes closed
      head.alpha += ((word ? 1 : REST) - head.alpha) * Math.min(1, dt / 0.07);
      const r = (head.rest += ((word ? 0 : 1) - head.rest) * Math.min(1, dt / 0.15));
      head.face.lid = Math.max(head.face.lid, r); // eyes shut while it rests
      if (head.artic) {
        const a = head.artic;
        head.skin.drive({ ...a, jaw: a.jaw + (MOUTH_SHUT.jaw - a.jaw) * r, lipAp: a.lipAp + (MOUTH_SHUT.lipAp - a.lipAp) * r }, head.face, -0.35 * r, 0);
      }
      head.scene.rotation.x = 0.28 * r;
      gl.render(head.scene, this.camera);
      ctx.save();
      ctx.globalAlpha = head.alpha;
      ctx.drawImage(gl.domElement, x, top, W, H);
      // the main head's falloff: the edges, chin and neck sink into the dark
      const fall = ctx.createRadialGradient(x + W / 2, top + H * 0.42, H * 0.22, x + W / 2, top + H * 0.42, H * 0.62);
      fall.addColorStop(0, "rgba(0,0,0,0.2)");
      fall.addColorStop(1, "#000");
      ctx.fillStyle = fall;
      ctx.fillRect(x, top, W, H);
      ctx.textAlign = "center";
      ctx.textBaseline = "alphabetic";
      ctx.font = NAME_FONT;
      if ("letterSpacing" in ctx) (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = "1.7px";
      ctx.fillStyle = word ? CUE : FAINT;
      // a long name ("Soprano saxophone") on two lines, never into its neighbour's
      const lines: string[] = [];
      for (const wd of part.name.toUpperCase().split(/\s+/)) {
        const l = lines.length - 1;
        if (l >= 0 && (l === 1 || ctx.measureText(`${lines[l]} ${wd}`).width <= NAME_W)) lines[l] += ` ${wd}`;
        else lines.push(wd);
      }
      lines.forEach((ln, j) => ctx.fillText(ln, x + W / 2, top + H + 16 + 15 * j, NAME_W));
      if ("letterSpacing" in ctx) (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = "0px";
      ctx.font = WORD_FONT;
      ctx.fillStyle = word ? INK : FAINT;
      if (word) ctx.fillText(word, x + W / 2, top + H + 25 + 15 * lines.length, NAME_W);
      ctx.restore();
    });
  }

  dispose(): void {
    this.gone = true;
    this.gl?.dispose();
    this.gl?.forceContextLoss();
  }
}
