// Recognises analytic surfaces on the SolidWorks faces, extracts the model edges and
// sums the mass properties. Ported from the CAD-Viewer-Projekt (src/geom.js:
// analyzeFace, analyzeEdge, buildModel) and rewritten on flat typed arrays so a part
// with a million vertices analyses in well under a second.

import type { SwEdgeInfo, SwFaceInfo, SwMesh, SwModelStats, SwParseResult, Vec3 } from "../types.ts";
import {
  add,
  basis,
  centroid,
  cross,
  det3,
  distance,
  dot,
  eig3,
  fitCircle,
  fitSphere,
  length,
  normalize,
  type Points,
  pointAt,
  scale,
  scaleOf,
  scatter,
  solve,
  sub,
  transformDir,
  transformPoint,
} from "./linalg.ts";

/** Above this many unique vertices per parse result the analysis is skipped. */
export const GEOMETRY_VERTEX_BUDGET = 1_500_000;

/** Vertices closer than this (mm) count as one when edges are traced. */
const WELD = 1e-4;
/** Edge polylines split where the direction turns by more than this. */
const KINK_COS = Math.cos((50 * Math.PI) / 180);

const tolerance = (size: number) => Math.max(2e-4, size * 2e-5);

/**
 * Classifies one face from its vertices and vertex normals (flat xyz, mesh space).
 *
 * - plane: all normals within 1e-5 of their mean and points within tolerance of the plane;
 * - cylinder: normals perpendicular to the axis (smallest eigenvector of the normals'
 *   scatter matrix), points on a fitted circle; inner/outer from the normal direction,
 *   full when points fall into all 12 sectors of 30°;
 * - cone: constant normal component along that axis;
 * - sphere: points on a fitted sphere;
 * - other: anything else (freeform).
 *
 * The tolerance is max(2e-4 mm, face size × 2e-5).
 */
export const analyzeFace = (pts: Points, nrm: Points, area: number): SwFaceInfo => {
  const n = pts.length / 3;
  if (n < 3) return { type: "other", area };
  let lo: Vec3 = [Infinity, Infinity, Infinity];
  let hi: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < 3; k++) {
      const v = pts[3 * i + k];
      if (v < lo[k]) lo[k] = v;
      if (v > hi[k]) hi[k] = v;
    }
  }
  const tol = tolerance(distance(lo, hi) || 1);

  // Plane
  const nm = normalize(centroid(nrm, n));
  let maxDev = 0;
  for (let i = 0; i < n; i++) maxDev = Math.max(maxDev, 1 - dot(pointAt(nrm, i), nm));
  if (maxDev < 1e-5) {
    const c = centroid(pts, n);
    let pd = 0;
    for (let i = 0; i < n; i++) pd = Math.max(pd, Math.abs(dot(sub(pointAt(pts, i), c), nm)));
    if (pd < tol) return { type: "plane", area, normal: nm, point: c };
  }

  // Cylinder: normals perpendicular to the axis
  const axis = normalize(eig3(scatter(nrm, [0, 0, 0], n))[0].vector);
  let axDev = 0;
  for (let i = 0; i < n; i++) axDev = Math.max(axDev, Math.abs(dot(pointAt(nrm, i), axis)));
  if (axDev < 2e-3 && n >= 4) {
    const cf = fitCircle(pts, axis, n);
    if (cf && cf.residual < tol && cf.radius < 1e5) {
      let tmin = Infinity;
      let tmax = -Infinity;
      const bins = new Set<number>();
      const angles = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        const d = sub(pointAt(pts, i), cf.center);
        const t = dot(d, axis);
        tmin = Math.min(tmin, t);
        tmax = Math.max(tmax, t);
        const a = Math.atan2(dot(d, cf.w), dot(d, cf.u));
        bins.add(Math.floor((a + Math.PI) / (Math.PI / 6)) % 12);
        angles[i] = a;
      }
      const p0 = pointAt(pts, 0);
      const d0 = sub(p0, cf.center);
      const radial = sub(d0, scale(axis, dot(d0, axis)));
      const full = bins.size === 12;
      return {
        type: "cylinder",
        area,
        axis,
        center: add(cf.center, scale(axis, (tmin + tmax) / 2)),
        radius: cf.radius,
        height: tmax - tmin,
        inner: dot(radial, pointAt(nrm, 0)) < 0,
        full,
        arcDeg: full ? 360 : arcSpan(angles),
      };
    }
  }

  // Cone: constant normal component along the axis
  {
    let mean = 0;
    for (let i = 0; i < n; i++) mean += dot(pointAt(nrm, i), axis);
    mean /= n;
    let dev = 0;
    for (let i = 0; i < n; i++) dev = Math.max(dev, Math.abs(dot(pointAt(nrm, i), axis) - mean));
    if (dev < 2e-3 && Math.abs(mean) > 2e-3 && Math.abs(mean) < 0.9999) {
      const halfAngle = (Math.asin(Math.min(1, Math.abs(mean))) * 180) / Math.PI;
      return { type: "cone", area, axis, halfAngle, ...coneAxis(pts, nrm, axis, n) };
    }
  }

  const sf = n >= 5 ? fitSphere(pts, n) : null;
  if (sf && sf.residual < tol) {
    return {
      type: "sphere",
      area,
      center: sf.center,
      radius: sf.radius,
      inner: dot(sub(pointAt(pts, 0), sf.center), pointAt(nrm, 0)) < 0,
    };
  }
  return { type: "other", area };
};

/** Covered angle in degrees: the full turn minus the largest gap between the point angles. */
const arcSpan = (angles: Float64Array) => {
  const a = angles.slice().sort();
  let gap = 2 * Math.PI - (a[a.length - 1] - a[0]);
  for (let i = 1; i < a.length; i++) gap = Math.max(gap, a[i] - a[i - 1]);
  return 360 - (gap * 180) / Math.PI;
};

/**
 * Axis position and apex of a cone: every normal line crosses the axis, so the axis
 * point is the least-squares intersection of the normals projected into the plane
 * perpendicular to `axis`; the apex is where the fitted radius drops to zero.
 */
const coneAxis = (pts: Points, nrm: Points, axis: Vec3, n: number): { center: Vec3; apex?: Vec3 } => {
  const [u, w] = basis(axis);
  const c0 = centroid(pts, n);
  let a = 0, b = 0, c = 0, r0 = 0, r1 = 0;
  for (let i = 0; i < n; i++) {
    const d = sub(pointAt(pts, i), c0);
    const x = dot(d, u);
    const y = dot(d, w);
    const q = pointAt(nrm, i);
    let nx = dot(q, u);
    let ny = dot(q, w);
    const l = Math.hypot(nx, ny) || 1;
    nx /= l;
    ny /= l;
    // (cx - x)·ny − (cy - y)·nx = 0
    const rhs = x * ny - y * nx;
    a += ny * ny;
    b += -ny * nx;
    c += nx * nx;
    r0 += ny * rhs;
    r1 += -nx * rhs;
  }
  const s = solve([[a, b], [b, c]], [r0, r1]);
  const origin = s ? add(c0, add(scale(u, s[0]), scale(w, s[1]))) : c0;
  // r = k·t + m along the axis
  let st = 0, sr = 0, stt = 0, str = 0, tmin = Infinity, tmax = -Infinity;
  for (let i = 0; i < n; i++) {
    const d = sub(pointAt(pts, i), origin);
    const t = dot(d, axis);
    const r = length(sub(d, scale(axis, t)));
    st += t;
    sr += r;
    stt += t * t;
    str += t * r;
    tmin = Math.min(tmin, t);
    tmax = Math.max(tmax, t);
  }
  const center = add(origin, scale(axis, (tmin + tmax) / 2));
  const den = n * stt - st * st;
  if (!s || Math.abs(den) < 1e-12) return { center };
  const k = (n * str - st * sr) / den;
  const m = (sr - k * st) / n;
  if (Math.abs(k) < 1e-9) return { center };
  return { center, apex: add(origin, scale(axis, -m / k)) };
};

/** Classifies an edge polyline as line, circle (or arc) or free curve. */
export const analyzeEdge = (pts: Vec3[], closed: boolean): SwEdgeInfo => {
  let len = 0;
  for (let i = 1; i < pts.length; i++) len += distance(pts[i], pts[i - 1]);
  if (pts.length < 2) return { type: "curve", length: len, closed };
  const a = pts[0];
  const b = pts[pts.length - 1];
  const tol = tolerance(Math.max(len, 1e-9));
  if (!closed) {
    const dir = normalize(sub(b, a));
    let dev = 0;
    for (const p of pts) {
      const d = sub(p, a);
      dev = Math.max(dev, length(sub(d, scale(dir, dot(d, dir)))));
    }
    if (dev < tol) return { type: "line", start: a, end: b, length: distance(a, b) };
  }
  if (pts.length >= 3) {
    const flat = new Float64Array(3 * pts.length);
    pts.forEach((p, i) => flat.set(p, 3 * i));
    const c = centroid(flat);
    const normal = normalize(eig3(scatter(flat, c))[0].vector);
    let pd = 0;
    for (const p of pts) pd = Math.max(pd, Math.abs(dot(sub(p, c), normal)));
    if (pd < tol) {
      const cf = fitCircle(flat, normal);
      if (cf && cf.residual < Math.max(tol, cf.radius * 1e-4)) {
        if (!closed && cf.radius > 50 * Math.max(len, 1e-6)) return { type: "curve", length: len, closed };
        let ang = 0;
        for (let i = 1; i < pts.length; i++) {
          const p = sub(pts[i - 1], cf.center);
          const q = sub(pts[i], cf.center);
          ang += Math.atan2(length(cross(p, q)), dot(p, q));
        }
        return {
          type: "circle",
          center: cf.center,
          normal,
          radius: cf.radius,
          full: closed,
          angle: closed ? 360 : (ang * 180) / Math.PI,
          length: closed ? 2 * Math.PI * cf.radius : len,
        };
      }
    }
  }
  return { type: "curve", length: len, closed };
};

/** Face ranges of a mesh; a mesh without them is one face. */
const rangesOf = (mesh: SwMesh) => mesh.faceRanges ?? [{ start: 0, count: mesh.indices.length }];

/** murmur3 finaliser: spreads the high bits into the low bits a table mask keeps. */
const mix = (h: number) => {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
};

/**
 * Welds vertices whose coordinates round to the same 1e-4 mm grid cell. Returns the
 * welded id per vertex and the welded positions.
 */
const weld = (positions: Float32Array) => {
  const nv = positions.length / 3;
  let cap = 1;
  while (cap < 2 * nv) cap <<= 1;
  const mask = cap - 1;
  const table = new Int32Array(cap).fill(-1);
  const keys = new Float64Array(3 * nv);
  const ids = new Int32Array(nv);
  let count = 0;
  for (let i = 0; i < nv; i++) {
    const x = Math.round(positions[3 * i] / WELD);
    const y = Math.round(positions[3 * i + 1] / WELD);
    const z = Math.round(positions[3 * i + 2] / WELD);
    let h = mix(Math.imul(x | 0, 73856093) ^ Math.imul(y | 0, 19349663) ^ Math.imul(z | 0, 83492791)) & mask;
    for (;;) {
      const slot = table[h];
      if (slot < 0) {
        table[h] = count;
        keys[3 * count] = x;
        keys[3 * count + 1] = y;
        keys[3 * count + 2] = z;
        ids[i] = count++;
        break;
      }
      if (keys[3 * slot] === x && keys[3 * slot + 1] === y && keys[3 * slot + 2] === z) {
        ids[i] = slot;
        break;
      }
      h = (h + 1) & mask;
    }
  }
  return { ids, count };
};

/** Twice the triangle area (length of the edge cross product). */
const triArea2 = (p: Float32Array, a: number, b: number, c: number) => {
  const ux = p[3 * b] - p[3 * a], uy = p[3 * b + 1] - p[3 * a + 1], uz = p[3 * b + 2] - p[3 * a + 2];
  const vx = p[3 * c] - p[3 * a], vy = p[3 * c + 1] - p[3 * a + 1], vz = p[3 * c + 2] - p[3 * a + 2];
  return Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
};

/** Area-weighted vertex normals for meshes saved without normals. */
const vertexNormals = (mesh: SwMesh) => {
  const p = mesh.positions;
  const out = new Float32Array(p.length);
  const ix = mesh.indices;
  for (let t = 0; t + 2 < ix.length; t += 3) {
    const a = ix[t], b = ix[t + 1], c = ix[t + 2];
    const ux = p[3 * b] - p[3 * a], uy = p[3 * b + 1] - p[3 * a + 1], uz = p[3 * b + 2] - p[3 * a + 2];
    const vx = p[3 * c] - p[3 * a], vy = p[3 * c + 1] - p[3 * a + 1], vz = p[3 * c + 2] - p[3 * a + 2];
    const g = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
    for (const v of [a, b, c]) for (let k = 0; k < 3; k++) out[3 * v + k] += g[k];
  }
  for (let v = 0; v < out.length; v += 3) {
    const l = Math.hypot(out[v], out[v + 1], out[v + 2]) || 1;
    out[v] /= l;
    out[v + 1] /= l;
    out[v + 2] /= l;
  }
  return out;
};

/**
 * Fills `mesh.faces`, `mesh.edges` and `mesh.edgeRanges` (mesh space).
 *
 * Edges are the triangle sides used once within a face (its boundary), with vertices
 * welded on a 1e-4 mm grid. They are grouped by the pair of faces they border,
 * chained into polylines and split where the direction turns by more than 50°.
 */
export const analyzeMesh = (mesh: SwMesh): void => {
  const p = mesh.positions;
  const ix = mesh.indices;
  const nrm = mesh.normals && mesh.normals.length === p.length ? mesh.normals : vertexNormals(mesh);
  const ranges = rangesOf(mesh);
  const nv = p.length / 3;
  const { ids, count: nw } = weld(p);

  const stamp = new Int32Array(nv).fill(-1);
  const faces: SwFaceInfo[] = [];
  // Boundary segments: welded endpoints and up to two bordering faces.
  const segA: number[] = [];
  const segB: number[] = [];
  const segF0: number[] = [];
  const segF1: number[] = [];
  // Open-addressing table over welded vertex pairs (i < j). Faces are processed in
  // order, so `last` + `cnt` count a side's uses within the current face, and `seg`
  // links a side that was a boundary of an earlier face to its segment.
  let cap = 1;
  while (cap < 2.5 * (ix.length / 2 + 1)) cap <<= 1;
  const mask = cap - 1;
  const ki = new Int32Array(cap).fill(-1);
  const kj = new Int32Array(cap);
  const last = new Int32Array(cap);
  const seg = new Int32Array(cap);
  const cnt = new Uint8Array(cap);
  let touched = new Int32Array(1024);

  ranges.forEach((r, fi) => {
    const verts: number[] = [];
    let area2 = 0;
    let nt = 0;
    if (touched.length < r.count) touched = new Int32Array(2 * r.count);
    const mark = (v: number) => {
      if (stamp[v] !== fi) {
        stamp[v] = fi;
        verts.push(v);
      }
    };
    const edge = (a: number, b: number) => {
      if (a === b) return;
      const i = a < b ? a : b;
      const j = a < b ? b : a;
      let h = mix(Math.imul(i, 0x9e3779b1) ^ j) & mask;
      for (;;) {
        if (ki[h] < 0) {
          ki[h] = i;
          kj[h] = j;
          seg[h] = -1;
          break;
        }
        if (ki[h] === i && kj[h] === j) break;
        h = (h + 1) & mask;
      }
      if (last[h] !== fi + 1) {
        last[h] = fi + 1;
        cnt[h] = 0;
        touched[nt++] = h;
      }
      if (cnt[h] < 2) cnt[h]++;
    };
    for (let t = r.start; t + 2 < r.start + r.count; t += 3) {
      const a = ix[t], b = ix[t + 1], c = ix[t + 2];
      mark(a);
      mark(b);
      mark(c);
      const g = triArea2(p, a, b, c);
      if (g < 1e-12) continue;
      area2 += g;
      const wa = ids[a], wb = ids[b], wc = ids[c];
      edge(wa, wb);
      edge(wb, wc);
      edge(wc, wa);
    }
    for (let k = 0; k < nt; k++) {
      const h = touched[k];
      if (cnt[h] !== 1) continue;
      const s = seg[h];
      if (s < 0) {
        seg[h] = segA.length;
        segA.push(ki[h]);
        segB.push(kj[h]);
        segF0.push(fi);
        segF1.push(-1);
      } else if (segF1[s] < 0 && segF0[s] !== fi) {
        segF1[s] = fi;
      }
    }
    const fp = new Float64Array(3 * verts.length);
    const fn = new Float64Array(3 * verts.length);
    verts.forEach((v, i) => {
      for (let k = 0; k < 3; k++) {
        fp[3 * i + k] = p[3 * v + k];
        fn[3 * i + k] = nrm[3 * v + k];
      }
    });
    faces.push(analyzeFace(fp, fn, area2 / 2));
  });

  // Welded positions: first vertex of each weld cell.
  const wpos = new Float64Array(3 * nw);
  for (let v = nv - 1; v >= 0; v--) {
    const w = ids[v];
    wpos[3 * w] = p[3 * v];
    wpos[3 * w + 1] = p[3 * v + 1];
    wpos[3 * w + 2] = p[3 * v + 2];
  }
  const wp = (w: number): Vec3 => [wpos[3 * w], wpos[3 * w + 1], wpos[3 * w + 2]];

  const groups = new Map<number, number[]>();
  const nf = ranges.length + 1;
  for (let s = 0; s < segA.length; s++) {
    const key = segF0[s] * nf + (segF1[s] + 1);
    let g = groups.get(key);
    if (!g) groups.set(key, (g = []));
    g.push(s);
  }

  const out: number[] = [];
  const edgeRanges: NonNullable<SwMesh["edgeRanges"]> = [];
  const used = new Uint8Array(segA.length);
  for (const segs of groups.values()) {
    const adj = new Map<number, number[]>();
    for (const s of segs) {
      for (const v of [segA[s], segB[s]]) {
        let l = adj.get(v);
        if (!l) adj.set(v, (l = []));
        l.push(s);
      }
    }
    const walk = (start: number) => {
      const chain = [start];
      let cur = start;
      for (;;) {
        const s = adj.get(cur)?.find((x) => !used[x]);
        if (s === undefined) break;
        used[s] = 1;
        cur = segA[s] === cur ? segB[s] : segA[s];
        chain.push(cur);
        if (cur === start) break;
      }
      return chain;
    };
    const chains: number[][] = [];
    // Open ends first, so open chains are not cut in the middle.
    for (const [v, l] of adj) {
      if (l.length === 2) continue;
      while (adj.get(v)!.some((x) => !used[x])) chains.push(walk(v));
    }
    for (const s of segs) if (!used[s]) chains.push(walk(segA[s]));

    const fpair: [number, number] = [segF0[segs[0]], segF1[segs[0]]];
    for (const ch of chains) {
      if (ch.length < 2) continue;
      const closed = ch[0] === ch[ch.length - 1];
      const pieces: number[][] = [];
      let cur = [ch[0]];
      for (let i = 1; i < ch.length; i++) {
        cur.push(ch[i]);
        const next = i < ch.length - 1 ? ch[i + 1] : closed ? ch[1] : -1;
        if (next < 0) continue;
        const d1 = normalize(sub(wp(ch[i]), wp(ch[i - 1])));
        const d2 = normalize(sub(wp(next), wp(ch[i])));
        if (dot(d1, d2) < KINK_COS) {
          pieces.push(cur);
          cur = [ch[i]];
        }
      }
      if (cur.length > 1) pieces.push(cur);
      // A closed chain split at kinks: the piece through the start joins the last one.
      if (closed && pieces.length > 1 && pieces[pieces.length - 1].at(-1) === ch[0]) {
        const d1 = normalize(sub(wp(ch[0]), wp(ch[ch.length - 2])));
        const d2 = normalize(sub(wp(ch[1]), wp(ch[0])));
        if (dot(d1, d2) >= KINK_COS) {
          const last = pieces.pop()!;
          pieces[0] = last.concat(pieces[0].slice(1));
        }
      }
      for (const pc of pieces) {
        const pts = pc.map(wp);
        const isClosed = pieces.length === 1 && closed;
        const start = out.length / 6;
        for (let i = 1; i < pts.length; i++) out.push(...pts[i - 1], ...pts[i]);
        edgeRanges.push({ start, count: pts.length - 1, info: analyzeEdge(pts, isClosed), faces: fpair });
      }
    }
  }

  mesh.faces = faces;
  mesh.edges = new Float32Array(out);
  mesh.edgeRanges = edgeRanges;
};

/** Volume (mm³, absolute) and area (mm²) of one mesh in mesh space. */
export interface MassProperties {
  volume: number;
  area: number;
}

/**
 * Divergence-theorem volume and surface area. Each triangle is oriented along its
 * vertex normals first, so strips with mixed winding still sum correctly.
 */
export const massProperties = (mesh: Pick<SwMesh, "positions" | "indices" | "normals">): MassProperties => {
  const p = mesh.positions;
  const n = mesh.normals && mesh.normals.length === p.length ? mesh.normals : undefined;
  const ix = mesh.indices;
  let vol = 0;
  let area2 = 0;
  for (let t = 0; t + 2 < ix.length; t += 3) {
    const a = 3 * ix[t], b = 3 * ix[t + 1], c = 3 * ix[t + 2];
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    const gx = uy * vz - uz * vy, gy = uz * vx - ux * vz, gz = ux * vy - uy * vx;
    const g = Math.hypot(gx, gy, gz);
    if (g < 1e-12) continue;
    area2 += g;
    let v =
      p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) -
      p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) +
      p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c]);
    if (n) {
      const s =
        gx * (n[a] + n[b] + n[c]) + gy * (n[a + 1] + n[b + 1] + n[c + 1]) + gz * (n[a + 2] + n[b + 2] + n[c + 2]);
      if (s < 0) v = -v;
    }
    vol += v;
  }
  return { volume: Math.abs(vol / 6), area: area2 / 2 };
};

/**
 * Bounding box, volume and area of all meshes in world space (via `matrix`). Every
 * mesh counts, hidden instances included, since they are part of the model the
 * viewer can show. The box includes the analytic extent of full outer cylinders in
 * `mesh.faces` (the facets lie inside the true circle). Matrices are assumed rigid
 * or uniformly scaled. Returns undefined without meshes.
 */
export const computeStats = (meshes: SwMesh[]): SwModelStats | undefined => {
  if (!meshes.length) return undefined;
  const mass = new Map<Float32Array, MassProperties>();
  const lo: Vec3 = [Infinity, Infinity, Infinity];
  const hi: Vec3 = [-Infinity, -Infinity, -Infinity];
  const grow = (k: number, a: number, b: number) => {
    if (a < lo[k]) lo[k] = a;
    if (b > hi[k]) hi[k] = b;
  };
  let volume = 0;
  let area = 0;
  for (const mesh of meshes) {
    let mp = mass.get(mesh.positions);
    if (!mp) mass.set(mesh.positions, (mp = massProperties(mesh)));
    const m = mesh.matrix;
    const s = scaleOf(m);
    volume += mp.volume * (m ? Math.abs(det3(m)) : 1);
    area += mp.area * s * s;
    const p = mesh.positions;
    // Only vertices that triangles use.
    const seen = new Uint8Array(p.length / 3);
    for (const v of mesh.indices) {
      if (seen[v]) continue;
      seen[v] = 1;
      const w = transformPoint(m, [p[3 * v], p[3 * v + 1], p[3 * v + 2]]);
      for (let k = 0; k < 3; k++) grow(k, w[k], w[k]);
    }
    for (const f of mesh.faces ?? []) {
      if (f.type !== "cylinder" || !f.full || f.inner) continue;
      const c = transformPoint(m, f.center);
      const ax = transformDir(m, f.axis);
      const r = f.radius * s;
      const h = f.height * s;
      for (let k = 0; k < 3; k++) {
        const ext = r * Math.sqrt(Math.max(0, 1 - ax[k] ** 2)) + (h / 2) * Math.abs(ax[k]);
        grow(k, c[k] - ext, c[k] + ext);
      }
    }
  }
  if (!Number.isFinite(lo[0])) return { bboxMin: [0, 0, 0], bboxMax: [0, 0, 0], volume, area };
  return { bboxMin: lo, bboxMax: hi, volume, area };
};

/** Snap point for measuring: edge ends, line midpoints and circle centres (mesh space). */
export interface SwSnapPoint {
  point: Vec3;
  kind: "corner" | "midpoint" | "center";
  /** Index into `mesh.edgeRanges`. */
  edge: number;
}

/** Snap points of an analysed mesh, deduplicated on the 1e-4 mm grid. */
export const snapPoints = (mesh: SwMesh): SwSnapPoint[] => {
  const out: SwSnapPoint[] = [];
  const seen = new Set<string>();
  const e = mesh.edges;
  if (!e || !mesh.edgeRanges) return out;
  const push = (point: Vec3, kind: SwSnapPoint["kind"], edge: number) => {
    const key = `${kind}:${point.map((x) => Math.round(x / WELD)).join(",")}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ point, kind, edge });
  };
  mesh.edgeRanges.forEach((r, i) => {
    const first: Vec3 = [e[6 * r.start], e[6 * r.start + 1], e[6 * r.start + 2]];
    const l = 6 * (r.start + r.count - 1) + 3;
    const last: Vec3 = [e[l], e[l + 1], e[l + 2]];
    const info = r.info;
    if (info.type !== "circle" || !info.full) {
      push(first, "corner", i);
      push(last, "corner", i);
    }
    if (info.type === "circle") push(info.center, "center", i);
    if (info.type === "line") push(scale(add(info.start, info.end), 0.5), "midpoint", i);
  });
  return out;
};

/**
 * Analyses every distinct mesh of a parse result once (assembly instances share their
 * `positions`) and sets `result.stats`. Skips the face/edge analysis with a warning
 * when the distinct meshes have more than `budget` vertices together; the stats are
 * computed either way. Never throws: a failure becomes a warning.
 */
export const analyzeResult = (result: SwParseResult, budget = GEOMETRY_VERTEX_BUDGET): void => {
  if (!result.meshes.length) return;
  try {
    const unique = new Map<Float32Array, SwMesh>();
    for (const m of result.meshes) if (!unique.has(m.positions)) unique.set(m.positions, m);
    let vertices = 0;
    for (const m of unique.values()) vertices += m.positions.length / 3;
    if (vertices > budget) {
      result.warnings.push(
        `geometry analysis skipped: ${vertices} vertices exceed the budget of ${budget}`
      );
    } else {
      for (const m of unique.values()) analyzeMesh(m);
      for (const m of result.meshes) {
        const src = unique.get(m.positions)!;
        if (src === m) continue;
        m.faces = src.faces;
        m.edges = src.edges;
        m.edgeRanges = src.edgeRanges;
      }
    }
    result.stats = computeStats(result.meshes);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    result.warnings.push(`geometry analysis failed: ${message}`);
  }
};
