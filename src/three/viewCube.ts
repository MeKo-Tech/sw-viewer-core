// Orientation cube in the top-right corner. It renders into a scissor viewport of the
// main renderer, so the viewer keeps a single WebGL context (browsers cap them; Safari
// especially). Faces, edges and corners are clickable. Ported from MeKo's
// CAD-Viewer-Projekt (src/app.js: ViewCube).

import * as THREE from "three";
import type { Vec3 } from "../types.ts";

/** Standard views. Front looks along −Z, top along −Y, right along −X (SolidWorks). */
export type SwStandardView = "front" | "back" | "top" | "bottom" | "left" | "right" | "iso";

/** Camera direction (from the target towards the camera) per standard view. */
export const VIEW_DIRECTIONS: Readonly<Record<SwStandardView, Vec3>> = {
  front: [0, 0, 1],
  back: [0, 0, -1],
  top: [0, 1, 0],
  bottom: [0, -1, 0],
  right: [1, 0, 0],
  left: [-1, 0, 0],
  iso: [1, 1, 1],
};

/** Texts on the cube faces. */
export interface SwViewCubeLabels {
  front: string;
  back: string;
  top: string;
  bottom: string;
  left: string;
  right: string;
}

export const defaultViewCubeLabels: SwViewCubeLabels = {
  front: "FRONT",
  back: "BACK",
  top: "TOP",
  bottom: "BOTTOM",
  left: "LEFT",
  right: "RIGHT",
};

const FACE_OF: Record<string, keyof SwViewCubeLabels> = {
  "0,0,1": "front",
  "0,0,-1": "back",
  "0,1,0": "top",
  "0,-1,0": "bottom",
  "1,0,0": "right",
  "-1,0,0": "left",
};

/** Size and margin of the cube viewport in CSS pixels. */
export const VIEW_CUBE_SIZE = 120;
const MARGIN = 8;

const labelTexture = (text: string) => {
  const cv = document.createElement("canvas");
  cv.width = cv.height = 256;
  const g = cv.getContext("2d")!;
  g.fillStyle = "#ffffff";
  g.fillRect(0, 0, 256, 256);
  g.fillStyle = "#3b4658";
  const size = text.length > 6 ? 40 : text.length > 5 ? 50 : 60;
  g.font = `700 ${size}px system-ui, "Segoe UI", sans-serif`;
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText(text, 128, 132, 236);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
};

export class SwViewCube {
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-1.15, 1.15, 1.15, -1.15, 0.1, 10);
  private readonly pieces: THREE.Mesh<THREE.BoxGeometry, THREE.MeshStandardMaterial[]>[] = [];
  private hovered: THREE.Mesh<THREE.BoxGeometry, THREE.MeshStandardMaterial[]> | null = null;
  private readonly raycaster = new THREE.Raycaster();

  constructor(labels: SwViewCubeLabels = defaultViewCubeLabels) {
    this.scene.add(new THREE.AmbientLight(0xffffff, 2.1));
    const light = new THREE.DirectionalLight(0xffffff, 1.1);
    this.camera.add(light);
    light.position.set(0.5, 0.8, 1);
    this.scene.add(this.camera);
    const sides: Vec3[] = [
      [1, 0, 0],
      [-1, 0, 0],
      [0, 1, 0],
      [0, -1, 0],
      [0, 0, 1],
      [0, 0, -1],
    ];
    for (const i of [-1, 0, 1])
      for (const j of [-1, 0, 1])
        for (const k of [-1, 0, 1]) {
          if (!i && !j && !k) continue;
          const nz = [i, j, k].filter(Boolean).length;
          const base = nz === 1 ? 0xffffff : nz === 2 ? 0xe4e8ef : 0xd5dbe4;
          const mats = sides.map((sd) => {
            const out = nz === 1 && sd[0] === i && sd[1] === j && sd[2] === k;
            return new THREE.MeshStandardMaterial({
              color: base,
              roughness: 0.9,
              metalness: 0,
              map: out ? labelTexture(labels[FACE_OF[`${i},${j},${k}`]]) : null,
            });
          });
          const size = [i, j, k].map((v) => (v ? 0.17 : 0.66)) as Vec3;
          const m = new THREE.Mesh(new THREE.BoxGeometry(...size), mats);
          m.position.set(i * 0.415, j * 0.415, k * 0.415);
          m.userData = { dir: [i, j, k], base };
          this.scene.add(m);
          this.pieces.push(m);
        }
    this.scene.add(
      new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)), new THREE.LineBasicMaterial({ color: 0x9aa6b8 })),
    );
    const axisColors = [0xd64545, 0x2f9e44, 0x2f6fd6];
    for (let a = 0; a < 3; a++) {
      const o = new THREE.Vector3(-0.56, -0.56, -0.56);
      const e = o.clone();
      e.setComponent(a, e.getComponent(a) + 1.38);
      this.scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([o, e]), new THREE.LineBasicMaterial({ color: axisColors[a] })));
    }
  }

  /** Viewport rectangle (CSS px, origin bottom-left as three.js expects) in a w×h canvas. */
  private viewport(w: number, h: number) {
    return { x: w - VIEW_CUBE_SIZE - MARGIN, y: h - VIEW_CUBE_SIZE - MARGIN, s: VIEW_CUBE_SIZE };
  }

  /** true when the client point lies on the cube's corner square. */
  contains(clientX: number, clientY: number, rect: DOMRect) {
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    return x >= rect.width - VIEW_CUBE_SIZE - MARGIN && x <= rect.width - MARGIN && y >= MARGIN && y <= MARGIN + VIEW_CUBE_SIZE;
  }

  /** Direction (from target to camera) of the cube piece under the client point, or null. */
  hit(clientX: number, clientY: number, rect: DOMRect): Vec3 | null {
    const piece = this.pieceAt(clientX, clientY, rect);
    return piece ? ([...piece.userData.dir] as Vec3) : null;
  }

  private pieceAt(clientX: number, clientY: number, rect: DOMRect) {
    if (!this.contains(clientX, clientY, rect)) return null;
    const x = (clientX - rect.left - (rect.width - VIEW_CUBE_SIZE - MARGIN)) / VIEW_CUBE_SIZE;
    const y = (clientY - rect.top - MARGIN) / VIEW_CUBE_SIZE;
    this.raycaster.setFromCamera(new THREE.Vector2(x * 2 - 1, -(y * 2 - 1)), this.camera);
    return (this.raycaster.intersectObjects(this.pieces, false)[0]?.object as (typeof this.pieces)[number] | undefined) ?? null;
  }

  /** Highlights the piece under the pointer; returns true when the pointer is on a piece. */
  hover(clientX: number, clientY: number, rect: DOMRect) {
    const p = this.pieceAt(clientX, clientY, rect);
    if (p !== this.hovered) {
      if (this.hovered) for (const m of this.hovered.material) m.color.setHex(this.hovered.userData.base);
      this.hovered = p;
      if (p) for (const m of p.material) m.color.setHex(0x9cc3ff);
    }
    return !!p;
  }

  /** Draws the cube over the frame just rendered, oriented like `camera`. */
  render(renderer: THREE.WebGLRenderer, camera: THREE.Camera, target: THREE.Vector3) {
    const size = renderer.getSize(new THREE.Vector2());
    if (size.x < VIEW_CUBE_SIZE * 2 || size.y < VIEW_CUBE_SIZE * 1.5) return;
    const d = camera.position.clone().sub(target).normalize();
    this.camera.position.copy(d.multiplyScalar(3));
    this.camera.up.copy(camera.up);
    this.camera.lookAt(0, 0, 0);
    const { x, y, s } = this.viewport(size.x, size.y);
    const autoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setScissorTest(true);
    renderer.setScissor(x, y, s, s);
    renderer.setViewport(x, y, s, s);
    renderer.clearDepth();
    renderer.render(this.scene, this.camera);
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, size.x, size.y);
    renderer.autoClear = autoClear;
  }

  dispose() {
    this.scene.traverse((o) => {
      if (o instanceof THREE.Mesh || o instanceof THREE.Line) {
        o.geometry.dispose();
        for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
          (m as THREE.MeshStandardMaterial).map?.dispose();
          m.dispose();
        }
      }
    });
  }
}
