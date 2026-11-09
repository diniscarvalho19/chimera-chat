/**
 * The other singers of a found song (a choir's alto, tenor, bass): a small head each under the main
 * one, the same face as the main head, its mouth moving with its own voice (that engine's jaw and
 * lips) and its brows, lids and cheeks with its own singing, and the word it is singing. Shown only
 * while such a song plays.
 *
 * One small WebGL renderer draws every head in turn and each is copied into its own 2D canvas:
 * browsers allow few WebGL contexts, and the main head has one already.
 */
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { engine } from "../../audio/AudioEngine.ts";
import { currentChoir, currentPlan, planNow, type ChoirPart } from "../speech.ts";
import { loadSkin, type Skin } from "../render/skin3d.ts";
import { Expression } from "../render/expression.ts";
import { VoiceModel } from "../analysis.ts";

/** each head's canvas, CSS px */
const W = 96, H = 108;

interface Head {
  skin: Skin;
  scene: THREE.Scene;
  face: Expression;
}

export function ChoirFaces() {
  const [parts, setParts] = useState<ChoirPart[] | null>(null);
  const canvases = useRef<(HTMLCanvasElement | null)[]>([]);
  const words = useRef<(HTMLSpanElement | null)[]>([]);

  useEffect(() => {
    let gl: THREE.WebGLRenderer | null = null;
    const camera = new THREE.PerspectiveCamera(22, W / H, 0.01, 100);
    const heads: Head[] = [];
    let loading = false, gone = false;
    /** the renderer and the heads, made the first time a choir sings and kept */
    const ready = (n: number): boolean => {
      if (!gl) {
        try {
          gl = new THREE.WebGLRenderer({ antialias: true, alpha: false });
        } catch {
          return false;
        }
        gl.outputColorSpace = THREE.LinearSRGBColorSpace; // as the main head
        gl.setClearColor(0x000000, 1);
        gl.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
        gl.setSize(W, H, false);
      }
      if (heads.length < n && !loading) {
        loading = true;
        loadSkin(gl).then(
          (skin) => {
            loading = false;
            if (gone) return;
            // face the camera (the skin turns the head for the main view), centred, a head tall
            skin.root.rotation.y = -Math.PI / 2;
            skin.tone(false);
            const box = new THREE.Box3().setFromObject(skin.root);
            const size = box.getSize(new THREE.Vector3()), mid = box.getCenter(new THREE.Vector3());
            const k = 1 / size.y;
            skin.root.scale.setScalar(k);
            skin.root.position.copy(mid).multiplyScalar(-k);
            const scene = new THREE.Scene();
            scene.add(skin.root);
            heads.push({ skin, scene, face: new Expression() });
          },
          (err) => {
            loading = false;
            console.warn("choir face:", err);
          },
        );
      }
      return heads.length >= n;
    };
    // the head (a unit tall, centred) fills the frame's height, a little room round it
    camera.position.set(0, 0, 0.4 / Math.tan((camera.fov * Math.PI) / 360));
    camera.lookAt(0, 0, 0);

    let raf = 0, shown: ChoirPart[] | null = null, last = performance.now();
    const tick = (nowMs: number) => {
      raf = requestAnimationFrame(tick);
      const dt = Math.min(0.1, (nowMs - last) / 1000);
      last = nowMs;
      const choir = currentChoir();
      const p = currentPlan(), now = planNow(p);
      // the song over (or another one begun): the heads go
      const live = choir && p && (now < 0 || now < p.plan.end + 0.3) ? choir : null;
      if (live !== shown) setParts((shown = live));
      if (!live || !ready(live.length) || !gl) return;
      live.forEach((part, i) => {
        const head = heads[i], c = canvases.current[i];
        const tele = engine.choirLatest(i);
        head.face.update(tele, dt);
        if (tele) head.skin.drive(VoiceModel.articFromArray(tele.t.artic), head.face, 0, 0);
        if (c) {
          const ctx = c.getContext("2d");
          gl!.render(head.scene, camera);
          if (ctx) {
            if (c.width !== gl!.domElement.width) [c.width, c.height] = [gl!.domElement.width, gl!.domElement.height];
            ctx.drawImage(gl!.domElement, 0, 0);
          }
        }
        const w = words.current[i];
        if (w) w.textContent = part.words.find((x) => x.t0 <= now && now < x.t1)?.text ?? "";
      });
    };
    raf = requestAnimationFrame(tick);
    return () => {
      gone = true;
      cancelAnimationFrame(raf);
      gl?.dispose();
      gl?.forceContextLoss();
    };
  }, []);

  if (!parts) return null;
  return (
    <div className="choir" aria-label="The other singers">
      {parts.map((p, i) => (
        <figure key={i} className="choir-face">
          <canvas ref={(el) => void (canvases.current[i] = el)} style={{ width: W, height: H }} aria-hidden="true" />
          <figcaption>
            <span className="choir-name">{p.name}</span>
            <span className="choir-word" ref={(el) => void (words.current[i] = el)} />
          </figcaption>
        </figure>
      ))}
    </div>
  );
}
