// Measuring on picked faces, edges and points, in world space. Ported from the
// CAD-Viewer-Projekt (src/geom.js: describe, measurePair, angleBetween, angle3,
// closestOnFace; src/app.js: section contour snapping). Pure math on plain data: the
// viewer draws the returned points itself.

import type { SwEdgeInfo, SwFaceInfo, SwMesh, Vec3 } from "../types.ts";
import { analyzeEdge } from "./analyze.ts";
import {
  add,
  centroid,
  cross,
  deg,
  distance,
  dot,
  invertAffine,
  length,
  lerp,
  type Mat4,
  normalize,
  scale,
  scaleOf,
  sub,
  transformDir,
  transformPoint,
} from "./linalg.ts";

/** A picked element. `matrix` defaults to `mesh.matrix` (column-major 4×4). */
export type SwPick =
  | { kind: "face"; mesh: SwMesh; face: number; matrix?: Mat4 }
  | { kind: "edge"; mesh: SwMesh; edge: number; matrix?: Mat4 }
  /** World-space point, e.g. a snap point or a picked surface point. */
  | { kind: "point"; point: Vec3 };

export type SwMeasureUnit = "mm" | "mm²" | "deg";

/** One measured value. `from`/`to` (world space) is the dimension line to draw, if any. */
export interface SwMeasureItem {
  /** Machine-readable id, e.g. `distance`, `axis-distance`, `angle`, `diameter`. */
  kind: string;
  /** English label hint; apps translate by `kind`. */
  label: string;
  value: number;
  unit: SwMeasureUnit;
  /** true when the value comes from the facets rather than the fitted surface. */
  approx?: boolean;
  from?: Vec3;
  to?: Vec3;
}

/** Properties of one picked element, in world space. */
export interface SwDescription {
  kind: SwPick["kind"];
  type: SwFaceInfo["type"] | SwEdgeInfo["type"] | "point";
  /** English label hint, e.g. `Cylinder (hole)`. */
  label: string;
  items: SwMeasureItem[];
  point?: Vec3;
  center?: Vec3;
  axis?: Vec3;
  normal?: Vec3;
}

/** Angle with the geometry for drawing its arc: centre, unit legs and a radius. */
export type SwAngle =
  | { deg: number; parallel?: false; center: Vec3; u: Vec3; v: Vec3; r: number; skew?: number }
  | { deg: 0; parallel: true };

// ---------- picks in world space ----------

type FaceType = SwFaceInfo["type"];
type EdgeType = SwEdgeInfo["type"];

interface Ent {
  kind: SwPick["kind"];
  type: FaceType | EdgeType | "point";
  p?: Vec3;
  normal?: Vec3;
  point?: Vec3;
  axis?: Vec3;
  center?: Vec3;
  radius?: number;
  start?: Vec3;
  end?: Vec3;
  dir?: Vec3;
  inner?: boolean;
  full?: boolean;
  /** Face info or edge info scaled to world (lengths, areas). */
  area?: number;
  length?: number;
  height?: number;
  arcDeg?: number;
  angle?: number;
  halfAngle?: number;
  apex?: Vec3;
  /** Face vertices or edge polyline, world space. */
  pts: () => Vec3[];
  /** Face triangles, world space. */
  tris?: () => [Vec3, Vec3, Vec3][];
}

const meshPoint = (m: SwMesh, v: number): Vec3 => [m.positions[3 * v], m.positions[3 * v + 1], m.positions[3 * v + 2]];

const lazy = <T>(f: () => T) => {
  let v: T | undefined;
  return () => (v ??= f());
};

/** Vertices of one face, world space. */
const faceVertices = (mesh: SwMesh, face: number, m: Mat4 | undefined): Vec3[] => {
  const r = mesh.faceRanges?.[face] ?? { start: 0, count: mesh.indices.length };
  const seen = new Set<number>();
  const out: Vec3[] = [];
  for (let i = r.start; i < r.start + r.count; i++) {
    const v = mesh.indices[i];
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(transformPoint(m, meshPoint(mesh, v)));
  }
  return out;
};

const faceTriangles = (mesh: SwMesh, face: number, m: Mat4 | undefined): [Vec3, Vec3, Vec3][] => {
  const r = mesh.faceRanges?.[face] ?? { start: 0, count: mesh.indices.length };
  const out: [Vec3, Vec3, Vec3][] = [];
  for (let t = r.start; t + 2 < r.start + r.count; t += 3) {
    out.push([0, 1, 2].map((k) => transformPoint(m, meshPoint(mesh, mesh.indices[t + k]))) as [Vec3, Vec3, Vec3]);
  }
  return out;
};

const edgePolyline = (mesh: SwMesh, edge: number, m: Mat4 | undefined): Vec3[] => {
  const r = mesh.edgeRanges![edge];
  const e = mesh.edges!;
  const out: Vec3[] = [];
  for (let s = r.start; s < r.start + r.count; s++) {
    if (s === r.start) out.push(transformPoint(m, [e[6 * s], e[6 * s + 1], e[6 * s + 2]]));
    out.push(transformPoint(m, [e[6 * s + 3], e[6 * s + 4], e[6 * s + 5]]));
  }
  return out;
};

const toEnt = (pick: SwPick): Ent => {
  if (pick.kind === "point") return { kind: "point", type: "point", p: pick.point, pts: () => [pick.point] };
  const m = pick.matrix ?? pick.mesh.matrix;
  const s = scaleOf(m);
  const P = (v: Vec3) => transformPoint(m, v);
  const D = (v: Vec3) => transformDir(m, v);
  if (pick.kind === "face") {
    const f = pick.mesh.faces?.[pick.face];
    if (!f) throw new Error(`face ${pick.face} has no analysis (call analyzeMesh first)`);
    const base: Ent = {
      kind: "face",
      type: f.type,
      area: f.area * s * s,
      pts: lazy(() => faceVertices(pick.mesh, pick.face, m)),
      tris: lazy(() => faceTriangles(pick.mesh, pick.face, m)),
    };
    switch (f.type) {
      case "plane":
        return { ...base, normal: D(f.normal), point: P(f.point) };
      case "cylinder":
        return {
          ...base,
          axis: D(f.axis),
          center: P(f.center),
          radius: f.radius * s,
          height: f.height * s,
          inner: f.inner,
          full: f.full,
          arcDeg: f.arcDeg,
        };
      case "cone":
        return { ...base, axis: D(f.axis), center: P(f.center), apex: f.apex && P(f.apex), halfAngle: f.halfAngle };
      case "sphere":
        return { ...base, center: P(f.center), radius: f.radius * s, inner: f.inner };
      default:
        return base;
    }
  }
  const r = pick.mesh.edgeRanges?.[pick.edge];
  if (!r || !pick.mesh.edges) throw new Error(`edge ${pick.edge} has no analysis (call analyzeMesh first)`);
  const info = r.info;
  const base: Ent = {
    kind: "edge",
    type: info.type,
    length: info.length * s,
    pts: lazy(() => edgePolyline(pick.mesh, pick.edge, m)),
  };
  if (info.type === "line") {
    const start = P(info.start);
    const end = P(info.end);
    return { ...base, start, end, dir: normalize(sub(end, start)) };
  }
  if (info.type === "circle") {
    return { ...base, center: P(info.center), normal: D(info.normal), radius: info.radius * s, full: info.full, angle: info.angle };
  }
  return base;
};

// ---------- closest points ----------

const closestOnSegment = (p: Vec3, a: Vec3, b: Vec3) => {
  const ab = sub(b, a);
  const t = Math.max(0, Math.min(1, dot(sub(p, a), ab) / (dot(ab, ab) || 1)));
  const q = add(a, scale(ab, t));
  return { point: q, distance: distance(p, q) };
};

const closestOnPolyline = (p: Vec3, pts: Vec3[]) => {
  let best = { point: pts[0], distance: distance(p, pts[0]) };
  for (let i = 1; i < pts.length; i++) {
    const c = closestOnSegment(p, pts[i - 1], pts[i]);
    if (c.distance < best.distance) best = c;
  }
  return best;
};

/** Closest point on triangle abc (Ericson, Real-Time Collision Detection 5.1.5). */
export const closestOnTriangle = (p: Vec3, a: Vec3, b: Vec3, c: Vec3): Vec3 => {
  const ab = sub(b, a), ac = sub(c, a), ap = sub(p, a);
  const d1 = dot(ab, ap), d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return a;
  const bp = sub(p, b), d3 = dot(ab, bp), d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return b;
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) return add(a, scale(ab, d1 / (d1 - d3)));
  const cp = sub(p, c), d5 = dot(ab, cp), d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return c;
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) return add(a, scale(ac, d2 / (d2 - d6)));
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) return add(b, scale(sub(c, b), (d4 - d3) / (d4 - d3 + (d5 - d6))));
  const den = 1 / (va + vb + vc);
  return add(a, add(scale(ab, vb * den), scale(ac, vc * den)));
};

const closestOnTris = (p: Vec3, tris: [Vec3, Vec3, Vec3][]) => {
  let best = { point: p, distance: Infinity };
  for (const [a, b, c] of tris) {
    const q = closestOnTriangle(p, a, b, c);
    const d = distance(p, q);
    if (d < best.distance) best = { point: q, distance: d };
  }
  return best;
};

/** Closest point on the facets of one face to the world point `p` (world space). */
export const closestOnFace = (mesh: SwMesh, face: number, p: Vec3, matrix: Mat4 | undefined = mesh.matrix) =>
  closestOnTris(p, faceTriangles(mesh, face, matrix));

/** Closest point of a picked element to the world point `p`: facets for faces, the polyline for edges. */
export const closestPoint = (pick: SwPick, p: Vec3): { point: Vec3; distance: number } => {
  if (pick.kind === "point") return { point: pick.point, distance: distance(p, pick.point) };
  const e = toEnt(pick);
  return pick.kind === "face" ? closestOnTris(p, e.tris!()) : closestOnPolyline(p, e.pts());
};

/** Brute-force closest pair over the vertices (sampled to 4000 per side). */
const closestPairs = (A: Vec3[], B: Vec3[]) => {
  let best = Infinity;
  let pa = A[0];
  let pb = B[0];
  const sa = Math.max(1, Math.ceil(A.length / 4000));
  const sb = Math.max(1, Math.ceil(B.length / 4000));
  for (let i = 0; i < A.length; i += sa) {
    for (let j = 0; j < B.length; j += sb) {
      const d = distance(A[i], B[j]);
      if (d < best) {
        best = d;
        pa = A[i];
        pb = B[j];
      }
    }
  }
  return { d: best, pa, pb };
};

// ---------- describe ----------

const item = (kind: string, label: string, value: number, unit: SwMeasureUnit = "mm", extra: Partial<SwMeasureItem> = {}): SwMeasureItem => ({
  kind,
  label,
  value,
  unit,
  ...extra,
});

const FACE_LABEL: Record<FaceType, string> = {
  plane: "Plane",
  cylinder: "Cylinder",
  cone: "Cone",
  sphere: "Sphere",
  other: "Freeform surface",
};

/** Type and dimensions of one picked element (world space). */
export const describe = (pick: SwPick): SwDescription => {
  const e = toEnt(pick);
  const items: SwMeasureItem[] = [];
  if (e.kind === "point") {
    return { kind: "point", type: "point", label: "Point", items, point: e.p };
  }
  if (e.kind === "face") {
    let label = FACE_LABEL[e.type as FaceType];
    if (e.type === "cylinder") {
      if (e.inner) label = "Cylinder (hole)";
      items.push(item("diameter", "Diameter", 2 * e.radius!), item("radius", "Radius", e.radius!));
      if (!e.full) items.push(item("arc-angle", "Arc angle ≈", e.arcDeg!, "deg", { approx: true }));
      items.push(item("height", "Length (axial)", e.height!));
    }
    if (e.type === "sphere") items.push(item("radius", "Sphere radius", e.radius!));
    if (e.type === "cone") items.push(item("half-angle", "Half angle", e.halfAngle!, "deg"));
    items.push(item("area", "Area", e.area!, "mm²"));
    return { kind: "face", type: e.type, label, items, point: e.point, center: e.center, axis: e.axis, normal: e.normal };
  }
  const labels: Record<EdgeType, string> = { line: "Line", circle: e.full ? "Circle" : "Arc", curve: "Curve" };
  if (e.type === "circle") {
    items.push(item("diameter", "Diameter", 2 * e.radius!), item("radius", "Radius", e.radius!));
    if (!e.full) items.push(item("arc-angle", "Arc angle", e.angle!, "deg"), item("length", "Arc length", e.length!));
  } else {
    items.push(item("length", "Length", e.length!));
  }
  return { kind: "edge", type: e.type, label: labels[e.type as EdgeType], items, center: e.center, axis: e.normal };
};

// ---------- measure a pair ----------

const PAR = 1 - 1e-6;
const projLine = (p: Vec3, o: Vec3, dir: Vec3) => add(o, scale(dir, dot(sub(p, o), dir)));

const axisOf = (e: Ent): { o: Vec3; dir: Vec3 } | null => {
  if (e.kind === "face" && (e.type === "cylinder" || e.type === "cone")) return { o: e.center!, dir: e.axis! };
  if (e.kind === "edge" && e.type === "circle") return { o: e.center!, dir: e.normal! };
  if (e.kind === "edge" && e.type === "line") return { o: e.start!, dir: e.dir! };
  return null;
};
const planeOf = (e: Ent) => (e.kind === "face" && e.type === "plane" ? { o: e.point!, n: e.normal! } : null);
const isPt = (e: Ent) =>
  e.kind === "point" || (e.kind === "edge" && e.type === "circle") || (e.kind === "face" && e.type === "sphere");
const ptOf = (e: Ent) => (e.kind === "point" ? e.p! : e.center!);
const acosDeg = (c: number) => deg(Math.acos(Math.min(1, c)));

/**
 * Distances and angles between two picked elements (world space): plane–plane
 * distance or angle, axis distances (cylinders, cones, circles, lines), point
 * distances to planes, axes, spheres, circles and freeform faces, with a closest
 * vertex distance between the meshes as fallback.
 */
export const measurePair = (pa: SwPick, pb: SwPick): SwMeasureItem[] => {
  const a = toEnt(pa);
  const b = toEnt(pb);
  const out: SwMeasureItem[] = [];
  const P1 = planeOf(a), P2 = planeOf(b), X1 = axisOf(a), X2 = axisOf(b);
  const pointEnt = a.kind === "point" ? a : b.kind === "point" ? b : null;
  const other = pointEnt === a ? b : a;

  if (pointEnt && other.kind === "face" && other.type !== "plane") {
    const p = pointEnt.p!;
    if (other.type === "cylinder") {
      const q = projLine(p, other.center!, other.axis!);
      const d = distance(p, q);
      out.push(item("point-axis", "Distance point – axis", d, "mm", { from: p, to: q }));
      const s = d > 1e-9 ? add(q, scale(sub(p, q), other.radius! / d)) : undefined;
      out.push(item("point-surface", "Distance point – surface", Math.abs(d - other.radius!), "mm", s && { from: p, to: s }));
    } else if (other.type === "sphere") {
      const d = distance(p, other.center!);
      out.push(item("point-center", "Distance point – sphere centre", d, "mm", { from: p, to: other.center }));
      const s = d > 1e-9 ? add(other.center!, scale(sub(p, other.center!), other.radius! / d)) : undefined;
      out.push(item("point-surface", "Distance point – sphere", Math.abs(d - other.radius!), "mm", s && { from: p, to: s }));
    } else {
      const c = closestOnTris(p, other.tris!());
      out.push(item("point-face", "Distance point – face", c.distance, "mm", c.distance > 1e-6 ? { from: p, to: c.point, approx: true } : { approx: true }));
    }
    return out;
  }
  if (pointEnt && other.kind === "edge" && other.type === "curve") {
    const c = closestOnPolyline(pointEnt.p!, other.pts());
    out.push(item("point-edge", "Distance point – edge", c.distance, "mm", c.distance > 1e-6 ? { from: pointEnt.p, to: c.point } : {}));
    return out;
  }
  if (pointEnt && other.kind === "edge" && other.type === "circle") {
    const p = pointEnt.p!;
    const c = other.center!;
    const n = other.normal!;
    const h = dot(sub(p, c), n);
    const radial = sub(sub(p, c), scale(n, h));
    const rad = length(radial);
    out.push(item("point-center", "Distance point – circle centre", distance(p, c), "mm", { from: p, to: c }));
    const onCircle = rad > 1e-9 ? add(c, scale(radial, other.radius! / rad)) : undefined;
    out.push(item("point-circle", "Distance point – circle", Math.hypot(h, rad - other.radius!), "mm", onCircle && { from: p, to: onCircle }));
    out.push(item("point-circle-axis", "Distance point – circle axis", rad, "mm", { from: p, to: add(c, scale(n, h)) }));
    return out;
  }

  if (P1 && P2) {
    const c = Math.abs(dot(P1.n, P2.n));
    if (c > PAR) {
      const d = dot(sub(P2.o, P1.o), P1.n);
      out.push(item("distance", "Distance (parallel)", Math.abs(d), "mm", { from: sub(P2.o, scale(P1.n, d)), to: P2.o }));
    } else {
      out.push(item("angle", "Angle", acosDeg(c), "deg"));
    }
  } else if ((P1 && X2) || (P2 && X1)) {
    const P = (P1 ?? P2)!;
    const X = (P1 ? X2 : X1)!;
    const E = P1 ? b : a;
    const c = Math.abs(dot(P.n, X.dir));
    if (E.kind === "edge" && E.type === "circle") {
      const d = dot(sub(E.center!, P.o), P.n);
      out.push(item("center-plane", "Distance circle centre – plane", Math.abs(d), "mm", { from: E.center, to: sub(E.center!, scale(P.n, d)) }));
    } else if (E.kind === "edge" && E.type === "line") {
      const da = dot(sub(E.start!, P.o), P.n);
      const db = dot(sub(E.end!, P.o), P.n);
      if (c < 1e-6) {
        out.push(item("edge-plane", "Distance edge – plane", Math.abs(da), "mm", { from: E.start, to: sub(E.start!, scale(P.n, da)) }));
      } else {
        out.push(item("angle", "Angle edge – plane", 90 - acosDeg(c), "deg"));
        const [q, dq] = Math.abs(da) < Math.abs(db) ? [E.start!, da] : [E.end!, db];
        out.push(item("endpoint-plane", "Distance nearest end point – plane", Math.abs(dq), "mm", Math.abs(dq) > 1e-6 ? { from: q, to: sub(q, scale(P.n, dq)) } : {}));
      }
    } else if (c < 1 - PAR) {
      const d = dot(sub(X.o, P.o), P.n);
      out.push(item("axis-plane", "Distance axis – plane", Math.abs(d), "mm", { from: X.o, to: sub(X.o, scale(P.n, d)) }));
    } else {
      if (c < PAR) out.push(item("angle", "Angle axis – plane", 90 - acosDeg(c), "deg"));
      const d = dot(sub(X.o, P.o), P.n);
      out.push(item("center-plane", "Distance centre – plane", Math.abs(d), "mm", { from: X.o, to: sub(X.o, scale(P.n, d)) }));
    }
  } else if ((P1 && isPt(b)) || (P2 && isPt(a))) {
    const P = (P1 ?? P2)!;
    const p = ptOf(P1 ? b : a);
    const d = dot(sub(p, P.o), P.n);
    out.push(item("point-plane", "Distance point – plane", Math.abs(d), "mm", { from: p, to: sub(p, scale(P.n, d)) }));
  } else if (X1 && X2 && !(isPt(a) && isPt(b) && (a.kind === "point" || b.kind === "point"))) {
    const c = Math.abs(dot(X1.dir, X2.dir));
    const bothLines = a.type === "line" && b.type === "line";
    if (c > PAR) {
      const q = projLine(X2.o, X1.o, X1.dir);
      const d = distance(X2.o, q);
      out.push(item(bothLines ? "edge-distance" : "axis-distance", bothLines ? "Distance between edges (parallel)" : "Axis distance", d, "mm", { from: q, to: X2.o }));
    } else {
      out.push(item("angle", bothLines ? "Angle between edges" : "Angle between axes", acosDeg(c), "deg"));
      const w = normalize(cross(X1.dir, X2.dir));
      out.push(item("skew-distance", bothLines ? "Shortest distance (extended edges)" : "Shortest axis distance", Math.abs(dot(sub(X2.o, X1.o), w)), "mm"));
    }
    if (isPt(a) && isPt(b)) {
      const d = distance(ptOf(a), ptOf(b));
      out.push(item("center-distance", "Centre distance", d, "mm", { from: ptOf(a), to: ptOf(b) }));
    }
  } else if (isPt(a) && isPt(b)) {
    const p = ptOf(a);
    const q = ptOf(b);
    const dd = sub(q, p);
    out.push(
      item("distance", "Distance", length(dd), "mm", { from: p, to: q }),
      item("dx", "dX", Math.abs(dd[0])),
      item("dy", "dY", Math.abs(dd[1])),
      item("dz", "dZ", Math.abs(dd[2]))
    );
  } else if ((X1 && isPt(b)) || (X2 && isPt(a))) {
    const X = (X1 ?? X2)!;
    const owner = X1 ? a : b;
    const p = ptOf(X1 ? b : a);
    const q = projLine(p, X.o, X.dir);
    const line = owner.kind === "edge" && owner.type === "line";
    out.push(item(line ? "point-line" : "point-axis", line ? "Distance point – line" : "Distance point – axis", distance(p, q), "mm", { from: p, to: q }));
  }

  const hasDistance = out.some((x) => x.unit === "mm");
  if (!out.length || !hasDistance) {
    const cp = closestPairs(a.pts(), b.pts());
    if (!out.length || cp.d > 1e-6) {
      out.push(item("min-distance", "Min. distance (≈, mesh)", cp.d, "mm", { approx: true, ...(cp.d > 1e-6 ? { from: cp.pa, to: cp.pb } : {}) }));
    }
  }
  return out;
};

// ---------- angles ----------

interface DirInfo {
  kind: "line" | "plane";
  p: Vec3;
  d: Vec3;
  ref: Vec3;
  size: number;
}

const dirInfo = (e: Ent): DirInfo | null => {
  if (e.kind === "edge" && e.type === "line") {
    return { kind: "line", p: e.start!, d: e.dir!, ref: scale(add(e.start!, e.end!), 0.5), size: e.length! };
  }
  if (e.kind === "face" && e.type === "plane") {
    const flat = e.pts().flat();
    return { kind: "plane", p: e.point!, d: e.normal!, ref: centroid(flat), size: Math.sqrt(e.area!) };
  }
  if (e.kind === "face" && (e.type === "cylinder" || e.type === "cone")) {
    return { kind: "line", p: e.center!, d: e.axis!, ref: e.center!, size: e.height ?? Math.sqrt(e.area!) };
  }
  if (e.kind === "edge" && e.type === "circle") {
    return { kind: "line", p: e.center!, d: e.normal!, ref: e.center!, size: e.radius! };
  }
  return null;
};

const angleOf = (u: Vec3, v: Vec3) => deg(Math.acos(Math.max(-1, Math.min(1, dot(normalize(u), normalize(v))))));

const closestLineLine = (p1: Vec3, d1: Vec3, p2: Vec3, d2: Vec3): [Vec3, Vec3] => {
  const w = sub(p1, p2);
  const a = dot(d1, d1), b = dot(d1, d2), c = dot(d2, d2), d = dot(d1, w), e = dot(d2, w);
  const den = a * c - b * b;
  const s = den > 1e-12 ? (b * e - c * d) / den : 0;
  const t = den > 1e-12 ? (a * e - b * d) / den : e / c;
  return [add(p1, scale(d1, s)), add(p2, scale(d2, t))];
};

/**
 * Angle between two lines, planes or axes (lines, cylinder/cone axes, circle normals)
 * with the arc geometry: `center` on the intersection, unit legs `u` and `v` pointing
 * towards the picked elements, and a radius. Null for elements without a direction.
 */
export const angleBetween = (pa: SwPick, pb: SwPick): SwAngle | null => {
  const A = dirInfo(toEnt(pa));
  const B = dirInfo(toEnt(pb));
  if (!A || !B) return null;
  const toward = (X: Vec3, ref: Vec3, d: Vec3) => {
    const s = dot(sub(ref, X), d);
    return Math.abs(s) > 1e-9 ? normalize(scale(d, Math.sign(s))) : normalize(d);
  };
  if (A.kind === "line" && B.kind === "line") {
    if (Math.abs(dot(A.d, B.d)) > 1 - 1e-10) return { deg: 0, parallel: true };
    const [q1, q2] = closestLineLine(A.p, A.d, B.p, B.d);
    const X = scale(add(q1, q2), 0.5);
    const u = toward(X, A.ref, A.d);
    const v = toward(X, B.ref, B.d);
    const r = Math.max(1e-6, 0.35 * Math.min(distance(A.ref, X) || 1, distance(B.ref, X) || 1));
    return { deg: angleOf(u, v), center: X, u, v, r, skew: distance(q1, q2) };
  }
  if (A.kind === "plane" && B.kind === "plane") {
    const L = cross(A.d, B.d);
    if (length(L) < 1e-9) return { deg: 0, parallel: true };
    const Ln = normalize(L);
    const d1 = dot(A.d, A.p), d2 = dot(B.d, B.p);
    const X0 = scale(add(scale(cross(B.d, L), d1), scale(cross(L, A.d), d2)), 1 / dot(L, L));
    const mid = scale(add(A.ref, B.ref), 0.5);
    const X = add(X0, scale(Ln, dot(sub(mid, X0), Ln)));
    const pr = (c: Vec3) => {
      const w = sub(c, X);
      return normalize(sub(w, scale(Ln, dot(w, Ln))));
    };
    const u = pr(A.ref);
    const v = pr(B.ref);
    const r = 0.3 * Math.min(A.size, B.size, distance(A.ref, X) || A.size, distance(B.ref, X) || B.size);
    return { deg: angleOf(u, v), center: X, u, v, r };
  }
  const P = A.kind === "plane" ? A : B;
  const Ln = A.kind === "plane" ? B : A;
  const s = dot(Ln.d, P.d);
  if (Math.abs(s) < 1e-10) return { deg: 0, parallel: true };
  const X = add(Ln.p, scale(Ln.d, dot(sub(P.p, Ln.p), P.d) / s));
  let u = toward(X, Ln.ref, Ln.d);
  if (dot(u, P.d) < 0) u = scale(u, -1);
  let v = sub(u, scale(P.d, dot(u, P.d)));
  if (length(v) < 1e-9) v = cross(P.d, Math.abs(P.d[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]);
  v = normalize(v);
  const r = 0.3 * Math.min(P.size, distance(Ln.ref, X) || P.size);
  return { deg: angleOf(u, v), center: X, u, v, r };
};

/** Angle p1–p2–p3 at p2 with arc geometry; null when a leg has zero length. */
export const angle3 = (p1: Vec3, p2: Vec3, p3: Vec3): SwAngle | null => {
  const u = sub(p1, p2);
  const v = sub(p3, p2);
  if (length(u) < 1e-9 || length(v) < 1e-9) return null;
  return { deg: angleOf(u, v), center: p2, u: normalize(u), v: normalize(v), r: 0.35 * Math.min(length(u), length(v)) };
};

// ---------- section contour ----------

/** Plane `normal · x = constant` (world space; `normal` need not be unit length). */
export interface SwPlane {
  normal: Vec3;
  constant: number;
}

/** One contour polyline of a section, on one face (world space). */
export interface SwSectionContour {
  /** Index into `mesh.faces`. */
  face: number;
  points: Vec3[];
  closed: boolean;
  info: SwEdgeInfo;
}

/**
 * Cuts the facets of `mesh` with a plane and chains the cut segments per face. On
 * cylinders (axis parallel or perpendicular to the plane) and spheres the points are
 * moved onto the fitted surface, so a Ø20 hole's contour measures exactly Ø20.
 */
export const sectionContour = (mesh: SwMesh, plane: SwPlane, matrix: Mat4 | undefined = mesh.matrix): SwSectionContour[] => {
  // Plane into mesh space: N·(A x + t) = c  ⇔  (Aᵀ N)·x = c − N·t
  let n: Vec3 = plane.normal;
  let d = plane.constant;
  const nl = length(n) || 1;
  n = scale(n, 1 / nl);
  d /= nl;
  let back = (q: Vec3) => q;
  if (matrix) {
    const m = matrix;
    const nm: Vec3 = [
      m[0] * n[0] + m[1] * n[1] + m[2] * n[2],
      m[4] * n[0] + m[5] * n[1] + m[6] * n[2],
      m[8] * n[0] + m[9] * n[1] + m[10] * n[2],
    ];
    const dm = d - (n[0] * m[12] + n[1] * m[13] + n[2] * m[14]);
    const l = length(nm) || 1;
    n = scale(nm, 1 / l);
    d = dm / l;
    if (!invertAffine(m)) return [];
    back = (q: Vec3) => transformPoint(m, q);
  }

  const p = mesh.positions;
  const ix = mesh.indices;
  const ranges = mesh.faceRanges ?? [{ start: 0, count: ix.length }];
  const key = (q: Vec3) => `${Math.round(q[0] * 1e4)},${Math.round(q[1] * 1e4)},${Math.round(q[2] * 1e4)}`;
  const out: SwSectionContour[] = [];
  // Intersection of edge (i, j) in a canonical vertex order, so both triangles that
  // share the edge produce the identical point.
  const cut = (qi: Vec3, si: number, qj: Vec3, sj: number): Vec3 => {
    const swap = qi[0] > qj[0] || (qi[0] === qj[0] && (qi[1] > qj[1] || (qi[1] === qj[1] && qi[2] > qj[2])));
    return swap ? lerp(qj, qi, sj / (sj - si)) : lerp(qi, qj, si / (si - sj));
  };

  ranges.forEach((r, fi) => {
    const segs: [Vec3, Vec3][] = [];
    for (let t = r.start; t + 2 < r.start + r.count; t += 3) {
      const P = [0, 1, 2].map((k) => {
        const v = 3 * ix[t + k];
        return [p[v], p[v + 1], p[v + 2]] as Vec3;
      });
      const s = P.map((q) => dot(n, q) - d);
      const X: Vec3[] = [];
      for (let k = 0; k < 3; k++) {
        const sa = s[k];
        const sb = s[(k + 1) % 3];
        if ((sa < 0 && sb > 0) || (sa > 0 && sb < 0)) X.push(cut(P[k], sa, P[(k + 1) % 3], sb));
        else if (sa === 0) X.push(P[k]);
      }
      if (X.length >= 2 && distance(X[0], X[1]) > 1e-9) segs.push([X[0], X[1]]);
    }
    if (!segs.length) return;

    const adj = new Map<string, number[]>();
    segs.forEach((sg, i) => {
      for (const q of sg) {
        const k = key(q);
        let l = adj.get(k);
        if (!l) adj.set(k, (l = []));
        l.push(i);
      }
    });
    const used = new Uint8Array(segs.length);
    const extend = (pts: Vec3[], atEnd: boolean) => {
      let cur = atEnd ? pts[pts.length - 1] : pts[0];
      for (;;) {
        const ck = key(cur);
        const nx = adj.get(ck)?.find((j) => !used[j]);
        if (nx === undefined) break;
        used[nx] = 1;
        cur = key(segs[nx][0]) === ck ? segs[nx][1] : segs[nx][0];
        if (atEnd) pts.push(cur);
        else pts.unshift(cur);
      }
    };
    const F = mesh.faces?.[fi];
    for (let i = 0; i < segs.length; i++) {
      if (used[i]) continue;
      used[i] = 1;
      const pts: Vec3[] = [segs[i][0], segs[i][1]];
      extend(pts, true);
      extend(pts, false);
      const closed = pts.length > 3 && key(pts[0]) === key(pts[pts.length - 1]);
      if (F) snapToSurface(pts, F, n, d);
      const world = pts.map(back);
      out.push({ face: fi, points: world, closed, info: analyzeEdge(world, closed) });
    }
  });
  return out;
};

/** Moves section points from the facets onto the fitted cylinder or sphere (mesh space). */
const snapToSurface = (pts: Vec3[], F: SwFaceInfo, n: Vec3, d: number) => {
  if (F.type === "cylinder" && Math.abs(dot(n, F.axis)) < 1e-6) {
    // Plane parallel to the axis: two straight lines at ±s0 from the axis.
    const q = normalize(cross(n, F.axis));
    const h = dot(n, F.center) - d;
    const s0 = Math.sqrt(Math.max(0, F.radius * F.radius - h * h));
    for (let k = 0; k < pts.length; k++) {
      const r = dot(sub(pts[k], F.center), q);
      pts[k] = add(pts[k], scale(q, Math.sign(r) * s0 - r));
    }
  } else if ((F.type === "cylinder" && Math.abs(Math.abs(dot(n, F.axis)) - 1) < 1e-6) || F.type === "sphere") {
    // Plane perpendicular to the axis, or any plane through a sphere: a circle.
    const h = dot(n, F.center) - d;
    const cp = sub(F.center, scale(n, h));
    const r0 = F.type === "sphere" ? Math.sqrt(Math.max(0, F.radius * F.radius - h * h)) : F.radius;
    for (let k = 0; k < pts.length; k++) {
      const v = sub(pts[k], cp);
      const l = length(v);
      if (l > 1e-9) pts[k] = add(cp, scale(v, r0 / l));
    }
  }
};
