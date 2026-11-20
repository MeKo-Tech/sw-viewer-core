// Interactive measuring: raycast picking (honouring the section and hidden components),
// snapping to corners, edge midpoints and circle centres, highlights, dimension lines
// with CSS2D labels, and pinned dimensions. Ported from MeKo's CAD-Viewer-Projekt
// (src/app.js: pick, snapPoint, entityAt, updateSelection, dimension, angleArc, pinCurrent).

import * as THREE from "three";
import { CSS2DObject } from "three/examples/jsm/renderers/CSS2DRenderer.js";
import { snapPoints, type SwSnapPoint } from "../geometry/analyze.ts";
import type { SwMeasureItem } from "../geometry/measure.ts";
import type { SwMesh, Vec3 } from "../types.ts";
import {
  computeMeasurement,
  formatDimension,
  type SwArc,
  type SwDimension,
  type SwMeasureMode,
  type SwMeasurement,
  type SwSnapKind,
  type SwViewerPick,
} from "./measureModel.ts";
import { type SwEdgeUserData, type SwMeshUserData, swMeshData } from "./scene.ts";
import type { SwSectionView } from "./section.ts";

const SEL = 0x3d8bfd;
const HOVER = 0x7fb2ff;
const DIM = 0xd9480f;

/** A dimension kept on screen after the selection moved on. */
export interface SwPinnedMeasurement {
  /** 1-based number shown in front of its labels. */
  id: number;
  measurement: SwMeasurement;
}

export interface SwMeasureHost {
  canvas: HTMLCanvasElement;
  camera: THREE.PerspectiveCamera;
  /** Orbit target, for the pixel size at the model. */
  target: THREE.Vector3;
  scene: THREE.Scene;
  section: SwSectionView;
  model(): THREE.Group | null;
  edgesVisible(): boolean;
}

export interface SwMeasureCallbacks {
  onMeasure?: (m: SwMeasurement | null) => void;
  onSelect?: (picks: SwViewerPick[]) => void;
  onPinsChange?: (pins: SwPinnedMeasurement[]) => void;
}

interface SnapSet {
  points: SwSnapPoint[];
  /** Bounding sphere of `points` (mesh space); null without points. */
  sphere: THREE.Sphere | null;
}

const snapSet = (m: SwMesh): SnapSet => {
  const points = snapPoints(m);
  if (!points.length) return { points, sphere: null };
  const box = new THREE.Box3();
  const v = new THREE.Vector3();
  for (const s of points) box.expandByPoint(v.set(s.point[0], s.point[1], s.point[2]));
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  let r = 0;
  for (const s of points) r = Math.max(r, sphere.center.distanceTo(v.set(s.point[0], s.point[1], s.point[2])));
  sphere.radius = r;
  return { points, sphere };
};

interface Hit {
  pick: SwViewerPick;
  object?: THREE.Mesh;
}

const mat4 = (o: THREE.Object3D) => (swMeshData(o)?.swMesh.matrix ? Array.from(o.matrix.elements) : undefined);

/** Polyline of one edge in world space. */
const edgePoints = (mesh: SwMesh, edge: number, matrix?: THREE.Matrix4): THREE.Vector3[] => {
  const r = mesh.edgeRanges?.[edge];
  const e = mesh.edges;
  if (!r || !e) return [];
  const pts: THREE.Vector3[] = [];
  for (let s = r.start; s < r.start + r.count; s++) {
    if (s === r.start) pts.push(new THREE.Vector3(e[6 * s], e[6 * s + 1], e[6 * s + 2]));
    pts.push(new THREE.Vector3(e[6 * s + 3], e[6 * s + 4], e[6 * s + 5]));
  }
  if (matrix) for (const p of pts) p.applyMatrix4(matrix);
  return pts;
};

const v3 = (p: Vec3) => new THREE.Vector3(p[0], p[1], p[2]);

const div = (className: string, text = "") => {
  const el = document.createElement("div");
  el.className = className;
  el.textContent = text;
  return el;
};

/** Removes `obj` from its parent, its CSS2D elements from the DOM, and frees its GPU data. */
const disposeOverlay = (obj: THREE.Object3D) => {
  obj.traverse((o) => {
    if (o instanceof CSS2DObject) o.element.remove();
    if (o instanceof THREE.Line || o instanceof THREE.Mesh) {
      o.geometry.dispose();
      (o.material as THREE.Material).dispose();
    }
  });
  obj.removeFromParent();
};

/** Disposes every child of `g` and keeps `g`. */
const clearGroup = (g: THREE.Object3D) => {
  for (const c of [...g.children]) disposeOverlay(c);
};

export class SwMeasureTool {
  mode: SwMeasureMode | null = null;
  format: (item: SwMeasureItem) => string = (item) => formatDimension(item);
  readonly overlay = new THREE.Group();
  readonly pinned = new THREE.Group();
  private readonly hover = new THREE.Group();
  private selection: Hit[] = [];
  private current: SwMeasurement | null = null;
  private pins: { id: number; measurement: SwMeasurement; group: THREE.Group }[] = [];
  private nextPin = 1;
  private readonly raycaster = new THREE.Raycaster();
  /** Snap points and their mesh-space bounding sphere, keyed by the shared `edges` buffer. */
  private readonly snapCache = new WeakMap<object, SnapSet>();
  private readonly snapMarker: CSS2DObject;
  private hoverKey = "";
  private sectionPick: { kind: "face" | "cylinder"; resolve: (h: Hit | null) => void } | null = null;
  private downAt: [number, number] | null = null;
  private moveRaf = 0;
  private lastMove: PointerEvent | null = null;
  private readonly cleanup: (() => void)[] = [];

  private readonly host: SwMeasureHost;
  private readonly callbacks: SwMeasureCallbacks;

  constructor(host: SwMeasureHost, callbacks: SwMeasureCallbacks = {}) {
    this.host = host;
    this.callbacks = callbacks;
    this.overlay.name = "measure";
    this.pinned.name = "pinned";
    this.hover.name = "hover";
    host.scene.add(this.overlay, this.pinned, this.hover);
    this.snapMarker = new CSS2DObject(div("sw-snap"));
    this.snapMarker.visible = false;
    host.scene.add(this.snapMarker);

    const c = host.canvas;
    const on = <K extends keyof HTMLElementEventMap>(type: K, fn: (ev: HTMLElementEventMap[K]) => void) => {
      c.addEventListener(type, fn as EventListener);
      this.cleanup.push(() => c.removeEventListener(type, fn as EventListener));
    };
    on("pointerdown", (ev) => {
      this.downAt = [ev.clientX, ev.clientY];
    });
    on("pointerup", (ev) => {
      const d = this.downAt;
      this.downAt = null;
      if (!d || ev.button !== 0 || Math.hypot(ev.clientX - d[0], ev.clientY - d[1]) > 4) return;
      this.click(ev);
    });
    on("pointermove", (ev) => {
      if (ev.buttons) return;
      this.lastMove = ev;
      if (!this.moveRaf) {
        this.moveRaf = requestAnimationFrame(() => {
          this.moveRaf = 0;
          if (this.lastMove) this.move(this.lastMove);
        });
      }
    });
    on("pointerleave", () => this.setHover(null));
    on("keydown", (ev) => {
      if (ev.key === "Escape") {
        if (this.sectionPick) this.cancelSectionPick();
        else this.clearSelection();
      }
    });
  }

  private get active() {
    return this.mode !== null || this.sectionPick !== null;
  }

  setMode(mode: SwMeasureMode | null) {
    if (mode === this.mode) return;
    this.mode = mode;
    this.clearSelection();
    this.setHover(null);
  }

  /** New model: drops selection, hover and pins. */
  reset() {
    this.cancelSectionPick();
    this.setHover(null);
    this.clearSelection();
    this.clearPins();
  }

  // ---------- picking ----------

  private ndc(x: number, y: number) {
    const r = this.host.canvas.getBoundingClientRect();
    return new THREE.Vector2(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1);
  }

  /** World size of one screen pixel at distance `dist` from the camera. */
  private worldPerPixel(dist?: number) {
    const cam = this.host.camera;
    const d = dist ?? cam.position.distanceTo(this.host.target);
    const h = this.host.canvas.clientHeight || 1;
    return (2 * d * Math.tan(THREE.MathUtils.degToRad(cam.fov / 2))) / cam.zoom / h;
  }

  private visibleMeshes(): THREE.Mesh[] {
    const model = this.host.model();
    if (!model || !model.visible) return [];
    return model.children.filter((o): o is THREE.Mesh => o instanceof THREE.Mesh && o.visible && !!swMeshData(o));
  }

  /** Snap points of a mesh; instances sharing their edges share the cached set. */
  private snaps(m: SwMesh): SnapSet {
    const key = m.edges ?? m;
    let s = this.snapCache.get(key);
    if (!s) this.snapCache.set(key, (s = snapSet(m)));
    return s;
  }

  /** The element under the cursor, filtered by `mode` (`angle` picks like `auto`). */
  pickAt(clientX: number, clientY: number, mode: SwMeasureMode = this.mode ?? "auto", snap = true): Hit | null {
    if (mode === "angle") mode = "auto";
    const meshes = this.visibleMeshes();
    if (!meshes.length) return null;
    const { camera, section } = this.host;
    const ndc = this.ndc(clientX, clientY);
    const ray = this.raycaster;
    ray.setFromCamera(ndc, camera);
    const fh = ray.intersectObjects(meshes, false).find((h) => !section.isClipped(h.point));
    const wpp = this.worldPerPixel(fh?.distance);

    if (snap && (mode === "auto" || mode === "point")) {
      const sp = this.snapAt(clientX, clientY, mode === "auto" ? 8 : 14, meshes);
      if (sp) return sp;
    }
    if (mode === "auto" || mode === "edge") {
      let best: { hit: THREE.Intersection; contour: boolean } | null = null;
      ray.params.Line = { threshold: 6 * wpp };
      if (this.host.edgesVisible() || mode === "edge") {
        const lines = meshes.map((m) => swMeshData(m)!.edgeLines).filter((l): l is THREE.LineSegments => !!l);
        const eh = ray.intersectObjects(lines, false).find((h) => !section.isClipped(h.point));
        if (eh) best = { hit: eh, contour: false };
      }
      const cl = section.contourLines;
      if (cl) {
        const ch = ray.intersectObject(cl, false)[0];
        if (ch && (!best || ch.distance < best.hit.distance)) best = { hit: ch, contour: true };
      }
      if (best && fh && best.hit.distance > fh.distance + 8 * wpp) best = null;
      if (best) {
        const seg = Math.floor((best.hit.index ?? 0) / 2);
        if (best.contour) {
          const src = section.contourSources;
          const mesh = section.contours!;
          const edge = mesh.edgeRanges!.findIndex((r) => seg >= r.start && seg < r.start + r.count);
          if (edge >= 0) {
            const meshIndex = src[edge]?.meshIndex;
            const owner = meshes.find((m) => swMeshData(m)!.swIndex === meshIndex);
            const componentId = owner ? swMeshData(owner)!.componentId : undefined;
            return { pick: { kind: "edge", mesh, edge, contour: true, meshIndex, ...(componentId !== undefined ? { componentId } : {}) } };
          }
        } else {
          const lines = best.hit.object as THREE.LineSegments;
          const owner = lines.parent as THREE.Mesh;
          const data = swMeshData(owner)!;
          const edge = (lines.userData as SwEdgeUserData).segEdge[seg];
          if (edge >= 0) return { pick: this.withOwner({ kind: "edge", mesh: data.swMesh, edge }, owner, data), object: owner };
        }
      }
    }
    if (fh) {
      if (mode === "point") {
        const data = swMeshData(fh.object);
        return {
          pick: {
            kind: "point",
            point: fh.point.toArray() as Vec3,
            snap: "surface",
            ...(data ? { meshIndex: data.swIndex } : {}),
            ...(data?.componentId !== undefined ? { componentId: data.componentId } : {}),
          },
        };
      }
      if (mode === "auto" || mode === "face") {
        const owner = fh.object as THREE.Mesh;
        const data = swMeshData(owner)!;
        const face = data.triFace[fh.faceIndex ?? -1] ?? -1;
        if (face >= 0 && data.swMesh.faces?.[face]) {
          return { pick: this.withOwner({ kind: "face", mesh: data.swMesh, face }, owner, data), object: owner };
        }
      }
    }
    return null;
  }

  private withOwner<P extends SwViewerPick>(p: P, owner: THREE.Mesh, data: SwMeshUserData): P {
    const m = mat4(owner);
    return { ...p, ...(m ? { matrix: m } : {}), meshIndex: data.swIndex, ...(data.componentId !== undefined ? { componentId: data.componentId } : {}) };
  }

  /** Nearest visible snap point within `radius` px of the cursor. */
  private snapAt(x: number, y: number, radius: number, meshes: THREE.Mesh[]): Hit | null {
    const { camera, section } = this.host;
    const r = this.host.canvas.getBoundingClientRect();
    const cands: { p: THREE.Vector3; kind: SwSnapKind; d: number; meshIndex?: number; componentId?: string }[] = [];
    const v = new THREE.Vector3();
    const consider = (p: THREE.Vector3, kind: SwSnapKind, meshIndex?: number, componentId?: string) => {
      if (section.isClipped(p)) return;
      v.copy(p).project(camera);
      if (v.z < -1 || v.z > 1) return;
      const sx = ((v.x + 1) / 2) * r.width + r.left;
      const sy = ((1 - v.y) / 2) * r.height + r.top;
      const d = Math.hypot(sx - x, sy - y);
      if (d < radius) cands.push({ p: p.clone(), kind, d, meshIndex, componentId });
    };
    // Cursor ray and the largest angle `radius` pixels can span (the image plane lies at
    // distance >= 1 in tangent space), to skip instances whose snap points are all away
    // from the cursor before projecting each of them.
    const cursor = new THREE.Raycaster();
    cursor.setFromCamera(new THREE.Vector2(((x - r.left) / (r.width || 1)) * 2 - 1, -((y - r.top) / (r.height || 1)) * 2 + 1), camera);
    const tanHalf = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) / (camera.zoom || 1);
    const maxAngle = radius * 2 * tanHalf * Math.max(1 / (r.height || 1), camera.aspect / (r.width || 1)) + 1e-6;
    const sphere = new THREE.Sphere();
    const toCenter = new THREE.Vector3();
    const nearCursor = (local: THREE.Sphere, matrix: THREE.Matrix4) => {
      sphere.copy(local).applyMatrix4(matrix);
      toCenter.copy(sphere.center).sub(cursor.ray.origin);
      const dist = toCenter.length();
      if (dist <= sphere.radius * (1 + 1e-9) + 1e-9) return true;
      const angle = cursor.ray.direction.angleTo(toCenter);
      return angle <= Math.asin(Math.min(1, sphere.radius / dist)) + maxAngle;
    };
    const w = new THREE.Vector3();
    for (const o of meshes) {
      const data = swMeshData(o)!;
      const set = this.snaps(data.swMesh);
      if (!set.sphere || !nearCursor(set.sphere, o.matrixWorld)) continue;
      for (const s of set.points) {
        w.set(s.point[0], s.point[1], s.point[2]).applyMatrix4(o.matrixWorld);
        consider(w, s.kind, data.swIndex, data.componentId);
      }
    }
    const contours = section.contours;
    if (contours) {
      const cs = this.snaps(contours);
      let componentOf: Map<number, string | undefined> | undefined;
      for (const s of cs.points) {
        const src = section.contourSources[s.edge];
        if (!componentOf) {
          componentOf = new Map();
          for (const m of meshes) {
            const d = swMeshData(m)!;
            if (!componentOf.has(d.swIndex)) componentOf.set(d.swIndex, d.componentId);
          }
        }
        consider(v3(s.point), s.kind, src?.meshIndex, src ? componentOf.get(src.meshIndex) : undefined);
      }
    }
    cands.sort((a, b) => a.d - b.d);
    // Skip snap points hidden behind other faces.
    const ray = new THREE.Raycaster();
    for (const c of cands.slice(0, 8)) {
      const dir = c.p.clone().sub(camera.position);
      const dist = dir.length();
      ray.set(camera.position, dir.normalize());
      const hit = ray.intersectObjects(meshes, false).find((h) => !section.isClipped(h.point));
      const tol = Math.max(4 * this.worldPerPixel(dist), dist * 1e-4);
      if (hit && hit.distance < dist - tol) continue;
      return {
        pick: {
          kind: "point",
          point: c.p.toArray() as Vec3,
          snap: c.kind,
          ...(c.meshIndex !== undefined ? { meshIndex: c.meshIndex } : {}),
          ...(c.componentId !== undefined ? { componentId: c.componentId } : {}),
        },
      };
    }
    return null;
  }

  // ---------- selection ----------

  private click(ev: PointerEvent) {
    if (this.sectionPick) {
      const h = this.pickAt(ev.clientX, ev.clientY, this.sectionPick.kind === "face" ? "face" : "auto", false);
      if (h && h.pick.kind !== "point") this.sectionPick.resolve(h);
      return;
    }
    if (!this.mode) return;
    const h = this.pickAt(ev.clientX, ev.clientY);
    if (!h) {
      this.clearSelection();
      return;
    }
    const same = this.selection.findIndex((s) => samePick(s.pick, h.pick));
    if (same >= 0) {
      this.selection.splice(same, 1);
    } else {
      const allPoints = this.selection.every((s) => s.pick.kind === "point") && h.pick.kind === "point";
      const max = this.mode === "angle" && allPoints ? 3 : 2;
      if (this.selection.length >= max) this.selection = [];
      this.selection.push(h);
    }
    this.update();
  }

  /** Waits for a click on a planar face (`face`) or a cylinder, cone or circle (`cylinder`). */
  waitForSectionPick(kind: "face" | "cylinder"): Promise<SwViewerPick | null> {
    this.cancelSectionPick();
    return new Promise((resolve) => {
      this.sectionPick = {
        kind,
        resolve: (h) => {
          this.sectionPick = null;
          this.setHover(null);
          resolve(h?.pick ?? null);
        },
      };
    });
  }

  cancelSectionPick() {
    this.sectionPick?.resolve(null);
  }

  get picking() {
    return this.sectionPick !== null;
  }

  clearSelection() {
    if (!this.selection.length && !this.current) return;
    this.selection = [];
    this.update();
  }

  /** Current picks. */
  get picks(): SwViewerPick[] {
    return this.selection.map((s) => s.pick);
  }

  get measurement() {
    return this.current;
  }

  /** Redraws highlights and dimensions after the selection changed. */
  private update() {
    clearGroup(this.overlay);
    for (const s of this.selection) this.overlay.add(this.highlight(s, SEL));
    const viewDir = this.host.camera.getWorldDirection(new THREE.Vector3()).toArray() as Vec3;
    let m: SwMeasurement | null = null;
    try {
      m = computeMeasurement(this.picks, { viewDir, mode: this.mode ?? "auto" });
    } catch {
      m = null;
    }
    this.current = m;
    if (m) for (const d of m.dimensions) this.overlay.add(this.drawDimension(d));
    this.callbacks.onSelect?.(this.picks);
    this.callbacks.onMeasure?.(m);
  }

  /** Re-runs the measurement (e.g. after the formatter changed). */
  refresh() {
    this.update();
    for (const p of this.pins) {
      disposeOverlay(p.group);
      p.group = this.drawPinned(p.measurement, p.id);
      this.pinned.add(p.group);
    }
  }

  /**
   * Drops picks whose mesh became invisible: face and edge picks by their mesh object,
   * contour edges and point picks by the `meshIndex` they came from. Points without
   * a mesh (none are made today) are kept.
   */
  pruneHidden() {
    const meshes = this.visibleMeshes();
    const visible = new Set(meshes);
    const visibleIndex = new Set(meshes.map((m) => swMeshData(m)!.swIndex));
    const before = this.selection.length;
    this.selection = this.selection.filter((s) =>
      s.object ? visible.has(s.object) : s.pick.meshIndex === undefined || visibleIndex.has(s.pick.meshIndex),
    );
    if (this.selection.length !== before) this.update();
    this.setHover(null);
  }

  // ---------- drawing ----------

  private highlight(h: Hit, color: number, hover = false): THREE.Object3D {
    const p = h.pick;
    if (p.kind === "point") {
      const o = new CSS2DObject(div(hover ? "sw-measure-point sw-hover" : "sw-measure-point"));
      o.position.set(...p.point);
      return o;
    }
    if (p.kind === "edge") {
      const pts = edgePoints(p.mesh, p.edge, h.object?.matrixWorld);
      return this.line(pts, color);
    }
    const o = h.object!;
    const r = p.mesh.faceRanges![p.face];
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", o.geometry.getAttribute("position"));
    g.setIndex(new THREE.BufferAttribute(p.mesh.indices.slice(r.start, r.start + r.count), 1));
    const mat = new THREE.MeshBasicMaterial({
      color,
      side: THREE.DoubleSide,
      transparent: hover,
      opacity: hover ? 0.55 : 1,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
      depthWrite: false,
    });
    this.host.section.track(mat);
    mat.addEventListener("dispose", () => this.host.section.untrack(mat));
    const mesh = new THREE.Mesh(g, mat);
    mesh.matrixAutoUpdate = false;
    mesh.matrix.copy(o.matrixWorld);
    mesh.renderOrder = 3;
    mesh.raycast = () => {};
    // Shares the model's position buffer; only the index is ours.
    g.dispose = () => {
      g.deleteAttribute("position");
      THREE.BufferGeometry.prototype.dispose.call(g);
    };
    return mesh;
  }

  private line(pts: THREE.Vector3[], color: number) {
    const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color, depthTest: false }));
    l.renderOrder = 10;
    l.raycast = () => {};
    return l;
  }

  private label(text: string, at: THREE.Vector3) {
    const o = new CSS2DObject(div("sw-dim", text));
    o.position.copy(at);
    return o;
  }

  private drawDimension(d: SwDimension, pinNo?: number): THREE.Object3D {
    const g = new THREE.Group();
    const text = (pinNo ? `(${pinNo}) ` : "") + this.format(d.item);
    if (d.kind === "angle") return this.drawArc(d.arc, text);
    const p = v3(d.from);
    const q = v3(d.to);
    const wpp = this.worldPerPixel(this.host.camera.position.distanceTo(q));
    let at = p.clone().add(q).multiplyScalar(0.5);
    if (d.at === "end") {
      const dir = q.clone().sub(p).normalize();
      g.add(this.line([p, q.clone().add(dir.clone().multiplyScalar(28 * wpp))], DIM));
      at = q.clone().add(dir.multiplyScalar(44 * wpp));
    } else {
      g.add(this.line([p, q], DIM));
    }
    for (const x of [p, q]) {
      const o = new CSS2DObject(div("sw-dim-end"));
      o.position.copy(x);
      g.add(o);
    }
    g.add(this.label(text, at));
    return g;
  }

  private drawArc(a: SwArc, text: string) {
    const g = new THREE.Group();
    const c = v3(a.center);
    const u = v3(a.u).normalize();
    const vv = v3(a.v).normalize();
    const r = Math.max(a.r || 0, 38 * this.worldPerPixel(this.host.camera.position.distanceTo(c)));
    let w = vv.clone().sub(u.clone().multiplyScalar(vv.dot(u)));
    if (w.lengthSq() < 1e-18) w = new THREE.Vector3(0, 0, 1).cross(u);
    w.normalize();
    const ang = (a.deg * Math.PI) / 180;
    const n = Math.max(12, Math.ceil(a.deg / 4));
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= n; i++) {
      const t = (ang * i) / n;
      pts.push(c.clone().add(u.clone().multiplyScalar(r * Math.cos(t))).add(w.clone().multiplyScalar(r * Math.sin(t))));
    }
    g.add(this.line(pts, DIM));
    g.add(this.line([c, c.clone().add(u.clone().multiplyScalar(r * 1.25))], DIM));
    g.add(this.line([c, c.clone().add(vv.clone().multiplyScalar(r * 1.25))], DIM));
    const lr = r * 1.3;
    const mid = c.clone().add(u.clone().multiplyScalar(lr * Math.cos(ang / 2))).add(w.clone().multiplyScalar(lr * Math.sin(ang / 2)));
    g.add(this.label(text, mid));
    return g;
  }

  private drawPinned(m: SwMeasurement, id: number) {
    const g = new THREE.Group();
    for (const d of m.dimensions) g.add(this.drawDimension(d, id));
    if (!m.dimensions.length) {
      const p = m.picks[0];
      const d0 = m.descriptions[0];
      const at = p?.kind === "point" ? p.point : (d0?.center ?? d0?.point);
      if (at) g.add(this.label(`(${id})`, v3(at)));
    }
    return g;
  }

  // ---------- hover ----------

  private move(ev: PointerEvent) {
    if (!this.active) return;
    const mode = this.sectionPick ? (this.sectionPick.kind === "face" ? "face" : "auto") : (this.mode ?? "auto");
    const h = this.pickAt(ev.clientX, ev.clientY, mode, !this.sectionPick);
    this.setHover(h && !(this.sectionPick && h.pick.kind === "point") ? h : null);
  }

  private setHover(h: Hit | null) {
    const p = h?.pick;
    const key = !p
      ? ""
      : p.kind === "point"
        ? `p:${p.point.join(",")}`
        : `${p.kind}:${p.meshIndex ?? "c"}:${p.kind === "face" ? p.face : p.edge}:${h.object?.id ?? ""}`;
    this.host.canvas.style.cursor = !p ? "" : p.kind === "face" ? "pointer" : "crosshair";
    if (key === this.hoverKey) return;
    this.hoverKey = key;
    clearGroup(this.hover);
    this.snapMarker.visible = false;
    if (!p) return;
    if (p.kind === "point") {
      if (p.snap && p.snap !== "surface") {
        this.snapMarker.position.set(...p.point);
        this.snapMarker.element.dataset.kind = p.snap;
        this.snapMarker.visible = true;
      } else {
        this.hover.add(this.highlight(h!, HOVER, true));
      }
      return;
    }
    if (this.selection.some((s) => samePick(s.pick, p))) return;
    this.hover.add(this.highlight(h!, HOVER, true));
  }

  // ---------- pins ----------

  /** Keeps the current dimensions on screen and clears the selection. */
  pin(): SwPinnedMeasurement | null {
    const m = this.current;
    if (!m) return null;
    const id = this.nextPin++;
    const group = this.drawPinned(m, id);
    this.pinned.add(group);
    this.pins.push({ id, measurement: m, group });
    this.selection = [];
    this.update();
    this.callbacks.onPinsChange?.(this.pinList);
    return { id, measurement: m };
  }

  get pinList(): SwPinnedMeasurement[] {
    return this.pins.map(({ id, measurement }) => ({ id, measurement }));
  }

  removePin(id: number) {
    const i = this.pins.findIndex((p) => p.id === id);
    if (i < 0) return;
    disposeOverlay(this.pins[i].group);
    this.pins.splice(i, 1);
    this.callbacks.onPinsChange?.(this.pinList);
  }

  clearPins() {
    const had = this.pins.length > 0;
    for (const p of this.pins) disposeOverlay(p.group);
    this.pins = [];
    this.nextPin = 1;
    if (had) this.callbacks.onPinsChange?.([]);
  }

  dispose() {
    cancelAnimationFrame(this.moveRaf);
    this.cancelSectionPick();
    for (const f of this.cleanup) f();
    for (const g of [this.overlay, this.hover, this.pinned]) disposeOverlay(g);
    this.snapMarker.element.remove();
    this.snapMarker.removeFromParent();
    this.host.canvas.style.cursor = "";
  }
}

const samePick = (a: SwViewerPick, b: SwViewerPick) => {
  if (a.kind !== b.kind) return false;
  if (a.kind === "point" && b.kind === "point") return Math.hypot(a.point[0] - b.point[0], a.point[1] - b.point[1], a.point[2] - b.point[2]) < 1e-9;
  if (a.kind === "face" && b.kind === "face") return a.mesh === b.mesh && a.face === b.face && a.meshIndex === b.meshIndex;
  if (a.kind === "edge" && b.kind === "edge") return a.mesh === b.mesh && a.edge === b.edge && a.meshIndex === b.meshIndex;
  return false;
};
