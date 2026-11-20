// What a measurement shows, as plain data: values, the primary dimension for a single
// pick (Ø, R, SR, wall thickness), angles, and the default number formatting. No
// three.js and no DOM, so it is testable in Node. Ported from MeKo's CAD-Viewer-Projekt
// (src/app.js: updateSelection, primaryDim, oppositeFace).

import {
  angle3,
  angleBetween,
  describe,
  measurePair,
  type SwAngle,
  type SwDescription,
  type SwMeasureItem,
  type SwPick,
} from "../geometry/measure.ts";
import { add, basis, cross, dot, length, normalize, scale, sub, transformDir, transformPoint } from "../geometry/linalg.ts";
import type { SwMesh, Vec3 } from "../types.ts";

/** Pick filter: `auto` picks snap points, edges and faces; `angle` measures angles. */
export type SwMeasureMode = "auto" | "point" | "edge" | "face" | "angle";

export const MEASURE_MODES: readonly SwMeasureMode[] = ["auto", "point", "edge", "face", "angle"];

/** How a point pick was found: a snap point or a free point on a face. */
export type SwSnapKind = "corner" | "midpoint" | "center" | "surface";

/** A pick made in the viewer, with the component it belongs to. */
export type SwViewerPick = SwPick & {
  /** `componentId` of the picked mesh (assemblies and drawings). */
  componentId?: string;
  /** Index of the picked mesh in `result.meshes`. */
  meshIndex?: number;
  /** Set for point picks. */
  snap?: SwSnapKind;
  /** true for an edge of the section contour. */
  contour?: boolean;
};

/** Angle with its arc geometry (never the parallel case). */
export type SwArc = Extract<SwAngle, { parallel?: false }>;

/** A drawn dimension: a line with a label, or an angle arc. */
export type SwDimension =
  | { kind: "line"; item: SwMeasureItem; from: Vec3; to: Vec3; /** Label at the middle, or past `to` (radii). */ at: "mid" | "end" }
  | { kind: "angle"; item: SwMeasureItem; arc: SwArc };

export interface SwMeasurement {
  picks: SwViewerPick[];
  /** One description per pick. */
  descriptions: SwDescription[];
  /** All values, the primary one first. */
  items: SwMeasureItem[];
  /** The value drawn as a dimension (also `items[0]`), if any. */
  primary?: SwMeasureItem;
  dimensions: SwDimension[];
}

export interface SwMeasureContext {
  /** Camera view direction (world), to lay diameters across the screen. */
  viewDir?: Vec3;
  mode?: SwMeasureMode;
}

const ARC_KINDS = new Set(["angle"]);

const faceVertices = (mesh: SwMesh, face: number, m: ArrayLike<number> | undefined): Vec3[] => {
  const r = mesh.faceRanges?.[face];
  if (!r) return [];
  const seen = new Set<number>();
  const out: Vec3[] = [];
  for (let i = r.start; i < r.start + r.count; i++) {
    const v = mesh.indices[i];
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(transformPoint(m, [mesh.positions[3 * v], mesh.positions[3 * v + 1], mesh.positions[3 * v + 2]]));
  }
  return out;
};

const mean = (pts: Vec3[]): Vec3 => scale(pts.reduce((a, p) => add(a, p), [0, 0, 0] as Vec3), 1 / (pts.length || 1));

const edgeMidpoint = (mesh: SwMesh, edge: number, m: ArrayLike<number> | undefined): Vec3 | undefined => {
  const r = mesh.edgeRanges?.[edge];
  const e = mesh.edges;
  if (!r || !e) return undefined;
  const s = r.start + Math.floor(r.count / 2);
  return transformPoint(m, [e[6 * s], e[6 * s + 1], e[6 * s + 2]]);
};

/** A unit direction perpendicular to `n`, across the screen when possible. */
const across = (n: Vec3, viewDir?: Vec3): Vec3 => {
  if (viewDir) {
    const u = cross(n, viewDir);
    if (length(u) > 1e-3) return normalize(u);
  }
  return basis(normalize(n))[0];
};

/**
 * The nearest planar face of the same mesh facing the opposite way behind a picked
 * plane: the wall thickness when their outlines overlap, else the distance to the
 * nearest parallel face. World space.
 */
export const oppositePlane = (
  mesh: SwMesh,
  face: number,
  matrix: ArrayLike<number> | undefined = mesh.matrix,
): { face: number; distance: number; overlap: boolean } | null => {
  const f0 = mesh.faces?.[face];
  if (f0?.type !== "plane") return null;
  const n = transformDir(matrix, f0.normal);
  const p0 = transformPoint(matrix, f0.point);
  const [u, w] = basis(n);
  const box = (pts: Vec3[]) => {
    const lo = [Infinity, Infinity];
    const hi = [-Infinity, -Infinity];
    for (const p of pts) {
      const x = dot(p, u);
      const y = dot(p, w);
      lo[0] = Math.min(lo[0], x);
      lo[1] = Math.min(lo[1], y);
      hi[0] = Math.max(hi[0], x);
      hi[1] = Math.max(hi[1], y);
    }
    return { lo, hi };
  };
  const ba = box(faceVertices(mesh, face, matrix));
  let best: { face: number; distance: number; overlap: boolean } | null = null;
  mesh.faces!.forEach((f, i) => {
    if (i === face || f.type !== "plane") return;
    const fn = transformDir(matrix, f.normal);
    if (dot(fn, n) > -0.999999) return;
    const t = dot(sub(p0, transformPoint(matrix, f.point)), n);
    if (t <= 1e-6) return;
    const bb = box(faceVertices(mesh, i, matrix));
    const e = 1e-6;
    const overlap = ba.lo[0] < bb.hi[0] - e && bb.lo[0] < ba.hi[0] - e && ba.lo[1] < bb.hi[1] - e && bb.lo[1] < ba.hi[1] - e;
    if (!best || (overlap && !best.overlap) || (overlap === best.overlap && t < best.distance)) best = { face: i, distance: t, overlap };
  });
  return best;
};

/**
 * The automatic dimension for one picked element: Ø across full cylinders and circles,
 * R on arcs and partial cylinders, SR on spheres, the opening angle of cones, the length
 * of lines and curves, and the wall thickness (or distance to the next parallel face)
 * of planes. Null for points and freeform faces.
 */
export const primaryDimension = (
  pick: SwPick,
  desc: SwDescription,
  viewDir?: Vec3,
): { item: SwMeasureItem; dimension?: SwDimension } | null => {
  if (pick.kind === "point") return null;
  const m = pick.matrix ?? pick.mesh.matrix;
  const find = (kind: string) => desc.items.find((x) => x.kind === kind);
  const line = (item: SwMeasureItem, from: Vec3, to: Vec3, at: "mid" | "end" = "mid") => {
    const it = { ...item, from, to };
    return { item: it, dimension: { kind: "line" as const, item: it, from, to, at } };
  };

  const circular = (pick.kind === "face" && desc.type === "cylinder") || (pick.kind === "edge" && desc.type === "circle");
  if (circular && desc.center && desc.axis) {
    const r = find("radius")!.value;
    const full = !find("arc-angle");
    if (full) {
      const u = across(desc.axis, viewDir);
      const label = pick.kind === "face" && desc.label.includes("hole") ? "Hole diameter" : "Diameter";
      return line({ kind: "diameter", label, value: 2 * r, unit: "mm" }, sub(desc.center, scale(u, r)), add(desc.center, scale(u, r)));
    }
    // Arc or partial cylinder: radius towards the middle of the element.
    let mid: Vec3 | undefined;
    if (pick.kind === "face") mid = mean(faceVertices(pick.mesh, pick.face, m));
    else mid = edgeMidpoint(pick.mesh, pick.edge, m);
    const a = normalize(desc.axis);
    let dir = mid ? sub(mid, desc.center) : across(a, viewDir);
    dir = sub(dir, scale(a, dot(dir, a)));
    dir = length(dir) > 1e-9 ? normalize(dir) : across(a, viewDir);
    return line({ kind: "radius", label: "Radius", value: r, unit: "mm" }, desc.center, add(desc.center, scale(dir, r)), "end");
  }
  if (pick.kind === "face" && desc.type === "sphere" && desc.center) {
    const r = find("radius")!.value;
    const c = mean(faceVertices(pick.mesh, pick.face, m));
    const d = sub(c, desc.center);
    const dir = length(d) > 1e-9 ? normalize(d) : across([0, 0, 1], viewDir);
    return line({ kind: "sphere-radius", label: "Sphere radius", value: r, unit: "mm" }, desc.center, add(desc.center, scale(dir, r)), "end");
  }
  if (pick.kind === "face" && desc.type === "cone") {
    const h = find("half-angle");
    return h ? { item: { kind: "cone-angle", label: "Opening angle", value: 2 * h.value, unit: "deg" } } : null;
  }
  if (pick.kind === "edge" && desc.type === "line") {
    const info = pick.mesh.edgeRanges?.[pick.edge]?.info;
    const len = find("length")!;
    if (info?.type === "line") return line({ ...len, label: "Edge length" }, transformPoint(m, info.start), transformPoint(m, info.end));
    return { item: len };
  }
  if (pick.kind === "edge" && desc.type === "curve") {
    const len = find("length");
    return len ? { item: { ...len, label: "Curve length" } } : null;
  }
  if (pick.kind === "face" && desc.type === "plane" && desc.point && desc.normal) {
    const opp = oppositePlane(pick.mesh, pick.face, m);
    if (!opp) return null;
    const to = sub(desc.point, scale(desc.normal, opp.distance));
    return line(
      opp.overlap
        ? { kind: "wall-thickness", label: "Wall thickness", value: opp.distance, unit: "mm" }
        : { kind: "parallel-distance", label: "Distance to the next parallel face", value: opp.distance, unit: "mm" },
      desc.point,
      to,
    );
  }
  return null;
};

const isArc = (a: SwAngle | null): a is SwArc => !!a && !a.parallel;

/**
 * Computes what to show for the current picks: one pick gives its description and
 * primary dimension, two picks distances and angles, three points (in angle mode) the
 * angle at the middle point. Null without picks.
 */
export const computeMeasurement = (picks: SwViewerPick[], ctx: SwMeasureContext = {}): SwMeasurement | null => {
  if (!picks.length) return null;
  const descriptions = picks.map((p) => describe(p));
  const out: SwMeasurement = { picks, descriptions, items: [], dimensions: [] };

  if (picks.length === 1) {
    const prim = primaryDimension(picks[0], descriptions[0], ctx.viewDir);
    const rest = descriptions[0].items;
    if (prim) {
      out.primary = prim.item;
      if (prim.dimension) out.dimensions.push(prim.dimension);
      // The primary value replaces its duplicate among the description items.
      const dup = rest.findIndex((x) => x.unit === prim.item.unit && Math.abs(x.value - prim.item.value) < 1e-9 && x.kind === prim.item.kind);
      out.items = [prim.item, ...rest.filter((_, i) => i !== dup)];
    } else {
      out.items = [...rest];
    }
    return out;
  }

  if (picks.length === 3) {
    const pts = picks.map((p) => (p.kind === "point" ? p.point : null));
    if (pts.every((p): p is Vec3 => !!p)) {
      const g = angle3(pts[0], pts[1], pts[2]);
      if (isArc(g)) {
        const item: SwMeasureItem = { kind: "angle", label: "Angle (at point 2)", value: g.deg, unit: "deg" };
        out.primary = item;
        out.items = [item, { kind: "supplementary-angle", label: "Supplementary angle", value: 180 - g.deg, unit: "deg" }];
        out.dimensions.push({ kind: "angle", item, arc: g });
      }
    }
    return out;
  }

  const [a, b] = picks;
  let items = measurePair(a, b);
  const g = angleBetween(a, b);
  if (isArc(g)) {
    const item: SwMeasureItem = { kind: "angle", label: "Angle", value: g.deg, unit: "deg" };
    items = [item, { kind: "supplementary-angle", label: "Supplementary angle", value: 180 - g.deg, unit: "deg" }, ...items.filter((x) => !ARC_KINDS.has(x.kind))];
    if (g.skew !== undefined && g.skew > 1e-6 && !items.some((x) => x.kind === "skew-distance")) {
      items.push({ kind: "skew-distance", label: "Shortest distance (skew)", value: g.skew, unit: "mm" });
    }
    out.dimensions.push({ kind: "angle", item, arc: g });
    out.primary = item;
  } else if (g?.parallel && ctx.mode === "angle") {
    items = [{ kind: "angle", label: "Angle (parallel)", value: 0, unit: "deg" }, ...items];
    out.primary = items[0];
  }
  if (ctx.mode !== "angle" || !out.dimensions.length) {
    const lineItem = items.find((x) => x.from && x.to);
    if (lineItem) {
      out.dimensions.push({ kind: "line", item: lineItem, from: lineItem.from!, to: lineItem.to!, at: "mid" });
      out.primary ??= lineItem;
    }
  }
  out.primary ??= items[0];
  if (out.primary) items = [out.primary, ...items.filter((x) => x !== out.primary)];
  out.items = items;
  return out;
};

// ---------- formatting ----------

export interface SwFormatOptions {
  /** BCP 47 locale for the numbers, e.g. `de-DE` (default `en-US`). */
  locale?: string;
  /** Decimals for lengths and areas (default 3). */
  digits?: number;
  /** Decimals for angles (default 2). */
  angleDigits?: number;
}

/** Fixed-decimals number; values that round to zero print as 0 (no `-0.000`). */
export const formatNumber = (x: number, digits = 3, locale = "en-US") => {
  const v = Math.abs(x) < 0.5 * 10 ** -digits ? 0 : x;
  return v.toLocaleString(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits, useGrouping: false });
};

/** Symbol in front of a dimension value, by item kind. */
export const DIMENSION_PREFIX: Readonly<Record<string, string>> = {
  diameter: "Ø",
  radius: "R",
  "sphere-radius": "SR",
};

const number = (item: SwMeasureItem, o: SwFormatOptions) =>
  formatNumber(item.value, item.unit === "deg" ? (o.angleDigits ?? 2) : (o.digits ?? 3), o.locale);

/** Value with unit for tables, e.g. `20.000 mm`, `≈ 12.000 mm²`, `90.00°`. */
export const formatMeasureValue = (item: SwMeasureItem, o: SwFormatOptions = {}) => {
  const n = `${DIMENSION_PREFIX[item.kind] ?? ""}${number(item, o)}`;
  const v = item.unit === "deg" ? `${n}°` : `${n} ${item.unit}`;
  return item.approx ? `≈ ${v}` : v;
};

/** Short text on a dimension label, e.g. `Ø20.000`, `R5.000`, `45.00°`. */
export const formatDimension = (item: SwMeasureItem, o: SwFormatOptions = {}) => {
  const n = `${DIMENSION_PREFIX[item.kind] ?? ""}${number(item, o)}`;
  return item.unit === "deg" ? `${n}°` : n;
};
