// Section view: one clipping plane through the model, a closed hatched cap where the
// plane cuts solid material (stencil technique), and the exact section contour from
// `sectionContour`. The plane maths at the top is pure and runs without WebGL.
// Ported from MeKo's CAD-Viewer-Projekt (src/app.js: updateSection, buildContour, the
// stencil cap in showModel).

import * as THREE from "three";
import { sectionContour, type SwPlane, type SwSectionContour } from "../geometry/measure.ts";
import { basis, cross, dot, normalize, scale, sub } from "../geometry/linalg.ts";
import type { SwDescription } from "../geometry/measure.ts";
import type { SwEdgeInfo, SwMesh, Vec3 } from "../types.ts";
import { swMeshData } from "./scene.ts";

export type SwAxis = "x" | "y" | "z";

interface SectionCommon {
  /**
   * `axis`: the plane's coordinate on that axis in mm (default: the model's centre).
   * `cylinder`/`face`: distance of the plane from the axis or face along its normal.
   */
  offset?: number;
  /** Cut away the other side. */
  flip?: boolean;
  /** Draw the exact section contour (default true). */
  contour?: boolean;
}

/** Where to cut. All coordinates are world space (mm). */
export type SwSectionSpec =
  /** Plane perpendicular to a world axis. */
  | (SectionCommon & { kind: "axis"; axis: SwAxis })
  /** Plane through a cylinder (or cone, or circle) axis, turned by `angle` degrees around it. */
  | (SectionCommon & {
      kind: "cylinder";
      center: Vec3;
      axis: Vec3;
      /** Rotation around the axis in degrees (default 0). */
      angle?: number;
      /** Direction (projected perpendicular to the axis) of the plane normal at angle 0, e.g. the view direction. */
      ref?: Vec3;
    })
  /** Plane parallel to a planar face. */
  | (SectionCommon & { kind: "face"; point: Vec3; normal: Vec3 });

export interface SwBox {
  min: Vec3;
  max: Vec3;
}

const AXIS_INDEX: Record<SwAxis, number> = { x: 0, y: 1, z: 2 };

const boxCenter = (box: SwBox | undefined, i: number) => (box ? (box.min[i] + box.max[i]) / 2 : 0);

/** Unit normal of a cylinder section: `ref` projected off the axis, turned by `angleDeg`. */
export const cylinderSectionNormal = (axis: Vec3, angleDeg = 0, ref?: Vec3): Vec3 => {
  const a = normalize(axis);
  let u: Vec3 | null = null;
  if (ref) {
    const p = sub(ref, scale(a, dot(ref, a)));
    if (Math.hypot(...p) > 1e-6) u = normalize(p);
  }
  u ??= basis(a)[0];
  const w = cross(a, u);
  const t = (angleDeg * Math.PI) / 180;
  return normalize([u[0] * Math.cos(t) + w[0] * Math.sin(t), u[1] * Math.cos(t) + w[1] * Math.sin(t), u[2] * Math.cos(t) + w[2] * Math.sin(t)]);
};

/** The plane `normal · x = constant` (unit normal) of a section; the cut removes `normal · x > constant` unless flipped. */
export const sectionPlane = (spec: SwSectionSpec, box?: SwBox): SwPlane => {
  switch (spec.kind) {
    case "axis": {
      const i = AXIS_INDEX[spec.axis];
      const normal: Vec3 = [0, 0, 0];
      normal[i] = 1;
      return { normal, constant: spec.offset ?? boxCenter(box, i) };
    }
    case "cylinder": {
      const normal = cylinderSectionNormal(spec.axis, spec.angle, spec.ref);
      return { normal, constant: dot(normal, spec.center) + (spec.offset ?? 0) };
    }
    case "face": {
      const normal = normalize(spec.normal);
      return { normal, constant: dot(normal, spec.point) + (spec.offset ?? 0) };
    }
  }
};

/**
 * The three.js clipping plane (`n · p + c >= 0` is kept) for a section plane: it keeps
 * `normal · x <= constant`, or the other side when flipped.
 */
export const clipPlaneOf = (plane: SwPlane, flip = false): { normal: Vec3; constant: number } =>
  flip
    ? { normal: [...plane.normal] as Vec3, constant: -plane.constant }
    : { normal: scale(plane.normal, -1), constant: plane.constant };

/** Useful slider range for `spec.offset` given the model box (contains 0 for cylinder/face). */
export const sectionRange = (spec: SwSectionSpec, box: SwBox): [number, number] => {
  if (spec.kind === "axis") {
    const i = AXIS_INDEX[spec.axis];
    return [box.min[i], box.max[i]];
  }
  const { normal, constant } = sectionPlane({ ...spec, offset: 0 });
  let lo = Infinity;
  let hi = -Infinity;
  for (const x of [box.min[0], box.max[0]])
    for (const y of [box.min[1], box.max[1]])
      for (const z of [box.min[2], box.max[2]]) {
        const t = dot(normal, [x, y, z]) - constant;
        lo = Math.min(lo, t);
        hi = Math.max(hi, t);
      }
  return [Math.min(lo, 0), Math.max(hi, 0)];
};

/**
 * Section spec for a picked element: `face` needs a planar face (the cut goes half way
 * into the model), `cylinder` a cylinder or cone face or a circle edge. Null when the
 * element does not fit.
 */
export const sectionFromDescription = (
  d: SwDescription,
  kind: "face" | "cylinder",
  options: { box?: SwBox; viewDir?: Vec3 } = {},
): SwSectionSpec | null => {
  if (kind === "face") {
    if (d.kind !== "face" || d.type !== "plane" || !d.normal || !d.point) return null;
    const spec: SwSectionSpec = { kind: "face", point: d.point, normal: d.normal, offset: 0 };
    if (options.box) spec.offset = sectionRange(spec, options.box)[0] / 2;
    return spec;
  }
  const ok = (d.kind === "face" && (d.type === "cylinder" || d.type === "cone")) || (d.kind === "edge" && d.type === "circle");
  if (!ok || !d.axis || !d.center) return null;
  return { kind: "cylinder", center: d.center, axis: normalize(d.axis), angle: 0, offset: 0, ...(options.viewDir ? { ref: options.viewDir } : {}) };
};

/**
 * Packs section contours into one world-space SwMesh with only `edges`/`edgeRanges`, so
 * they can be picked and measured like model edges (`{ kind: "edge", mesh, edge }`).
 */
export const contourMesh = (contours: readonly SwSectionContour[]): SwMesh => {
  const segs: number[] = [];
  const edgeRanges: { start: number; count: number; info: SwEdgeInfo; faces: [number, number] }[] = [];
  for (const c of contours) {
    const start = segs.length / 6;
    for (let i = 1; i < c.points.length; i++) segs.push(...c.points[i - 1], ...c.points[i]);
    edgeRanges.push({ start, count: c.points.length - 1, info: c.info, faces: [c.face, -1] });
  }
  return { positions: new Float32Array(0), indices: new Uint32Array(0), edges: new Float32Array(segs), edgeRanges };
};

// ---------- three.js ----------

/** Diagonal hatch, generated without a canvas so it also works off-DOM. */
const hatchTexture = () => {
  const n = 32;
  const data = new Uint8Array(n * n * 4);
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const d = (x + y) % (n / 2);
      const line = d < 1.6 || d > n / 2 - 0.6;
      const k = 4 * (y * n + x);
      data.set(line ? [0xc0, 0x60, 0x5a, 255] : [0xf2, 0xc4, 0xbf, 255], k);
    }
  const tex = new THREE.DataTexture(data, n, n);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
};

/** One section contour as drawn, with the source mesh index for component lookups. */
export interface SwContourSource {
  /** Index of the source mesh in the model. */
  meshIndex: number;
  contour: SwSectionContour;
}

/**
 * Applies a section to a model group built by `buildSwGroup`. `group` holds the cap and
 * the contour lines; add it to the scene. Requires a renderer with `stencil: true` and
 * `localClippingEnabled`.
 */
export class SwSectionView {
  readonly group = new THREE.Group();
  readonly clipPlane = new THREE.Plane(new THREE.Vector3(-1, 0, 0), 0);
  /** World-space contour edges of the current section (`contourMesh`), null when off. */
  contours: SwMesh | null = null;
  contourSources: SwContourSource[] = [];
  private spec: SwSectionSpec | null = null;
  private plane: SwPlane | null = null;
  private model: THREE.Group | null = null;
  private box: SwBox | undefined;
  private stencils: THREE.Mesh[] = [];
  private readonly backMat: THREE.MeshBasicMaterial;
  private readonly frontMat: THREE.MeshBasicMaterial;
  private readonly cap: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private lines: THREE.LineSegments | null = null;
  private readonly lineMat = new THREE.LineBasicMaterial({ color: 0x111111 });
  private readonly extraMaterials = new Set<THREE.Material>();

  constructor() {
    const stencilMat = (side: THREE.Side, op: THREE.StencilOp) =>
      new THREE.MeshBasicMaterial({
        side,
        colorWrite: false,
        depthWrite: false,
        depthTest: false,
        stencilWrite: true,
        stencilFunc: THREE.AlwaysStencilFunc,
        stencilFail: op,
        stencilZFail: op,
        stencilZPass: op,
        clippingPlanes: [this.clipPlane],
      });
    // Back faces +1, front faces −1: inside the solid the count stays non-zero.
    this.backMat = stencilMat(THREE.BackSide, THREE.IncrementWrapStencilOp);
    this.frontMat = stencilMat(THREE.FrontSide, THREE.DecrementWrapStencilOp);
    this.cap = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({
        map: hatchTexture(),
        side: THREE.DoubleSide,
        stencilWrite: true,
        stencilRef: 0,
        stencilFunc: THREE.NotEqualStencilFunc,
        stencilFail: THREE.ReplaceStencilOp,
        stencilZFail: THREE.ReplaceStencilOp,
        stencilZPass: THREE.ReplaceStencilOp,
      }),
    );
    this.cap.renderOrder = 2;
    this.cap.name = "section-cap";
    this.cap.onAfterRender = (renderer) => renderer.clearStencil();
    this.cap.visible = false;
    this.group.add(this.cap);
    this.group.name = "section";
  }

  get active() {
    return this.spec !== null;
  }

  get current(): SwSectionSpec | null {
    return this.spec;
  }

  /** The section plane (unit normal), null when off. */
  get currentPlane(): SwPlane | null {
    return this.plane;
  }

  /** Sets the model (null to clear); keeps the section spec. */
  setModel(model: THREE.Group | null, box?: SwBox) {
    this.removeStencils();
    this.model = model;
    this.box = box;
    this.apply();
  }

  /** Sets or clears the section. Call `updateContours` afterwards (it is the slow part). */
  set(spec: SwSectionSpec | null) {
    this.spec = spec;
    this.apply();
  }

  /** Clips these materials too (selection highlights); they follow on/off changes. */
  track(material: THREE.Material) {
    this.extraMaterials.add(material);
    this.applyClipping(material);
  }

  untrack(material: THREE.Material) {
    this.extraMaterials.delete(material);
  }

  /** true when the world point lies on the cut-away side. */
  isClipped(p: THREE.Vector3) {
    return this.active && this.clipPlane.distanceToPoint(p) < -1e-3;
  }

  private applyClipping(mat: THREE.Material) {
    const want = this.active ? 1 : 0;
    const have = mat.clippingPlanes?.length ?? 0;
    mat.clippingPlanes = this.active ? [this.clipPlane] : null;
    if (want !== have) mat.needsUpdate = true;
  }

  private apply() {
    const spec = this.spec;
    this.plane = spec ? sectionPlane(spec, this.box) : null;
    if (this.plane) {
      const c = clipPlaneOf(this.plane, spec!.flip);
      this.clipPlane.normal.set(...c.normal);
      this.clipPlane.constant = c.constant;
    }
    const materials = new Set<THREE.Material>(this.extraMaterials);
    this.model?.traverse((o) => {
      if (o instanceof THREE.Mesh || o instanceof THREE.LineSegments) {
        if (o.userData.swStencil) return;
        for (const m of Array.isArray(o.material) ? o.material : [o.material]) materials.add(m);
      }
    });
    for (const m of materials) this.applyClipping(m);
    if (spec && this.model) this.addStencils();
    else this.removeStencils();
    this.placeCap();
    if (!spec) this.clearContours();
  }

  private addStencils() {
    if (this.stencils.length || !this.model) return;
    for (const o of this.model.children) {
      if (!(o instanceof THREE.Mesh) || !swMeshData(o)) continue;
      for (const mat of [this.backMat, this.frontMat]) {
        const s = new THREE.Mesh(o.geometry, mat);
        s.renderOrder = 1;
        s.userData.swStencil = true;
        s.raycast = () => {};
        o.add(s);
        this.stencils.push(s);
      }
    }
  }

  private removeStencils() {
    for (const s of this.stencils) s.removeFromParent();
    this.stencils = [];
  }

  private placeCap() {
    const box = this.box;
    this.cap.visible = !!this.spec && !!this.model;
    if (!this.cap.visible || !box) return;
    const min = new THREE.Vector3(...box.min);
    const max = new THREE.Vector3(...box.max);
    const size = max.distanceTo(min) || 1;
    const center = min.clone().add(max).multiplyScalar(0.5);
    const n = this.clipPlane.normal;
    const c = center.clone().sub(n.clone().multiplyScalar(this.clipPlane.distanceToPoint(center)));
    this.cap.position.copy(c);
    this.cap.lookAt(c.clone().add(n));
    // A hair behind the plane, so the contour lines on the plane stay on top.
    this.cap.position.add(n.clone().multiplyScalar(-1e-4 * size));
    this.cap.scale.set(size * 3, size * 3, 1);
    const map = this.cap.material.map!;
    // About one hatch line per 1/25 of the model size.
    map.repeat.set(size * 3 / (size / 12.5), size * 3 / (size / 12.5));
  }

  private clearContours() {
    if (this.lines) {
      this.lines.removeFromParent();
      this.lines.geometry.dispose();
      this.lines = null;
    }
    this.contours = null;
    this.contourSources = [];
  }

  /** Recomputes the exact contour on the visible meshes (call after set/visibility changes). */
  updateContours() {
    this.clearContours();
    const plane = this.plane;
    if (!plane || !this.model || this.spec?.contour === false) return;
    const all: SwSectionContour[] = [];
    for (const o of this.model.children) {
      const data = swMeshData(o);
      if (!data || !o.visible) continue;
      for (const contour of sectionContour(data.swMesh, plane, data.swMesh.matrix)) {
        all.push(contour);
        this.contourSources.push({ meshIndex: data.swIndex, contour });
      }
    }
    if (!all.length) return;
    this.contours = contourMesh(all);
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(this.contours.edges!, 3));
    this.lines = new THREE.LineSegments(g, this.lineMat);
    this.lines.renderOrder = 5;
    this.lines.name = "section-contour";
    this.lines.userData.swContour = true;
    this.group.add(this.lines);
  }

  /** The contour line object (for picking), null when none. */
  get contourLines(): THREE.LineSegments | null {
    return this.lines;
  }

  dispose() {
    this.removeStencils();
    this.clearContours();
    this.backMat.dispose();
    this.frontMat.dispose();
    this.cap.geometry.dispose();
    this.cap.material.map?.dispose();
    this.cap.material.dispose();
    this.lineMat.dispose();
    this.group.removeFromParent();
  }
}
