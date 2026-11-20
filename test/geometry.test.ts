// Geometry analysis and measuring on synthetic meshes built here: a cube and a
// faceted cylinder (shaft or hole), laid out like buildBodyMesh output (own vertices
// per face, one face range per face).

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  analyzeMesh,
  analyzeResult,
  angle3,
  angleBetween,
  closestPoint,
  computeStats,
  describe as describePick,
  eig3,
  fitCircle,
  fitSphere,
  invertAffine,
  massProperties,
  measurePair,
  sectionContour,
  snapPoints,
  transformPoint,
} from "../src/geometry/index.ts";
import { transferables } from "../src/protocol.ts";
import type { SwFaceInfo, SwMesh, SwParseResult, Vec3 } from "../src/types.ts";

interface RawFace {
  pts: Vec3[];
  nrm: Vec3[];
  tris: [number, number, number][];
}

const meshOf = (faces: RawFace[]): SwMesh => {
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  const faceRanges: NonNullable<SwMesh["faceRanges"]> = [];
  for (const f of faces) {
    const base = positions.length / 3;
    f.pts.forEach((p, i) => {
      positions.push(...p);
      normals.push(...f.nrm[i]);
    });
    const start = indices.length;
    for (const t of f.tris) indices.push(base + t[0], base + t[1], base + t[2]);
    faceRanges.push({ start, count: indices.length - start });
  }
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    indices: Uint32Array.from(indices),
    faceRanges,
  };
};

/** Axis-aligned cube centred on the origin, outward normals, CCW from outside. */
const cube = (size = 100): SwMesh => {
  const h = size / 2;
  const faces: RawFace[] = [];
  for (let axis = 0; axis < 3; axis++) {
    for (const s of [-1, 1]) {
      const n: Vec3 = [0, 0, 0];
      n[axis] = s;
      const u = (axis + 1) % 3;
      const v = (axis + 2) % 3;
      const pts = [
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, 1],
      ].map(([a, b]) => {
        const p: Vec3 = [0, 0, 0];
        p[axis] = s * h;
        p[u] = a * h;
        p[v] = b * h;
        return p;
      });
      const tris: [number, number, number][] = s > 0 ? [[0, 1, 2], [0, 2, 3]] : [[0, 2, 1], [0, 3, 2]];
      faces.push({ pts, nrm: pts.map(() => n), tris });
    }
  }
  return meshOf(faces);
};

/**
 * Cylinder along y with radius r and height hgt, n facets. The facet vertices are
 * offset by half a step, so no vertex lies on the x or z extreme. `hole` flips the
 * side normals (a bore) and leaves out the caps.
 */
const cylinder = (r = 10, hgt = 40, n = 32, hole = false): SwMesh => {
  const side: RawFace = { pts: [], nrm: [], tris: [] };
  for (let i = 0; i < n; i++) {
    const a = ((i + 0.5) * 2 * Math.PI) / n;
    const c = Math.cos(a);
    const s = Math.sin(a);
    const nv: Vec3 = hole ? [-c, 0, -s] : [c, 0, s];
    side.pts.push([r * c, -hgt / 2, r * s], [r * c, hgt / 2, r * s]);
    side.nrm.push(nv, nv);
  }
  for (let i = 0; i < n; i++) {
    const a = 2 * i;
    const b = 2 * ((i + 1) % n);
    side.tris.push(hole ? [a, a + 1, b] : [a, b, a + 1], hole ? [b, a + 1, b + 1] : [b, b + 1, a + 1]);
  }
  if (hole) return meshOf([side]);
  const cap = (y: number, up: boolean): RawFace => {
    const pts: Vec3[] = [[0, y, 0]];
    for (let i = 0; i < n; i++) {
      const a = ((i + 0.5) * 2 * Math.PI) / n;
      pts.push([r * Math.cos(a), y, r * Math.sin(a)]);
    }
    const tris: [number, number, number][] = [];
    for (let i = 0; i < n; i++) {
      const a = 1 + i;
      const b = 1 + ((i + 1) % n);
      tris.push(up ? [0, b, a] : [0, a, b]);
    }
    return { pts, nrm: pts.map(() => [0, up ? 1 : -1, 0] as Vec3), tris };
  };
  return meshOf([side, cap(-hgt / 2, false), cap(hgt / 2, true)]);
};

const near = (actual: number, expected: number, tol: number, what = "") =>
  assert.ok(Math.abs(actual - expected) <= tol, `${what} ${actual} ≉ ${expected} (±${tol})`);

const faceIndex = (m: SwMesh, pred: (f: SwFaceInfo) => boolean) => {
  const i = m.faces!.findIndex(pred);
  assert.ok(i >= 0, "face found");
  return i;
};

const planeFace = (m: SwMesh, axis: number, sign: number) =>
  faceIndex(m, (f) => f.type === "plane" && f.normal[axis] * sign > 0.99);

describe("linalg", () => {
  it("eig3 sorts eigenpairs ascending", () => {
    const e = eig3([
      [2, 1, 0],
      [1, 2, 0],
      [0, 0, 5],
    ]);
    near(e[0].value, 1, 1e-12);
    near(e[1].value, 3, 1e-12);
    near(e[2].value, 5, 1e-12);
    near(Math.abs(e[0].vector[0] + e[0].vector[1]), 0, 1e-12, "eigenvector of 1");
  });

  it("fits a circle and a sphere exactly", () => {
    const circle: number[] = [];
    const sphere: number[] = [];
    for (let i = 0; i < 12; i++) {
      const a = (i * Math.PI) / 7;
      circle.push(3 + 5 * Math.cos(a), 2, -1 + 5 * Math.sin(a));
      sphere.push(1 + 4 * Math.cos(a) * Math.cos(i), 2 + 4 * Math.sin(a) * Math.cos(i), 3 + 4 * Math.sin(i));
    }
    const c = fitCircle(circle, [0, 1, 0])!;
    near(c.radius, 5, 1e-9);
    assert.deepEqual(c.center.map((x) => +x.toFixed(9)), [3, 2, -1]);
    const s = fitSphere(sphere)!;
    near(s.radius, 4, 1e-9);
    assert.deepEqual(s.center.map((x) => +x.toFixed(9)), [1, 2, 3]);
  });

  it("inverts an affine matrix", () => {
    const c = Math.cos(0.3), s = Math.sin(0.3);
    const m = [c * 2, s * 2, 0, 0, -s * 2, c * 2, 0, 0, 0, 0, 2, 0, 5, -7, 9, 1];
    const p: Vec3 = [1, 2, 3];
    const q = transformPoint(invertAffine(m)!, transformPoint(m, p));
    q.forEach((x, i) => near(x, p[i], 1e-12));
  });
});

describe("analyzeMesh: cube", () => {
  const m = cube();
  analyzeMesh(m);

  it("finds six planes and twelve straight edges", () => {
    assert.equal(m.faces!.length, 6);
    assert.ok(m.faces!.every((f) => f.type === "plane"));
    assert.equal(m.edgeRanges!.length, 12);
    for (const e of m.edgeRanges!) {
      assert.equal(e.info.type, "line");
      near(e.info.length, 100, 1e-9);
      assert.ok(e.faces[0] >= 0 && e.faces[1] >= 0, "edge borders two faces");
    }
    assert.equal(m.edges!.length, 6 * m.edgeRanges!.reduce((s, e) => s + e.count, 0));
  });

  it("sums volume and area", () => {
    const mp = massProperties(m);
    near(mp.volume, 1e6, 1e-6);
    near(mp.area, 6e4, 1e-6);
  });

  it("lists corners and edge midpoints as snap points", () => {
    const snaps = snapPoints(m);
    assert.equal(snaps.filter((s) => s.kind === "corner").length, 8);
    assert.equal(snaps.filter((s) => s.kind === "midpoint").length, 12);
  });

  it("measures parallel and perpendicular planes", () => {
    const top = { kind: "face" as const, mesh: m, face: planeFace(m, 1, 1) };
    const bottom = { kind: "face" as const, mesh: m, face: planeFace(m, 1, -1) };
    const side = { kind: "face" as const, mesh: m, face: planeFace(m, 0, 1) };
    const [d] = measurePair(top, bottom);
    assert.equal(d.kind, "distance");
    near(d.value, 100, 1e-9);
    assert.ok(d.from && d.to);
    const [a] = measurePair(top, side);
    assert.equal(a.kind, "angle");
    near(a.value, 90, 1e-9);
    const arc = angleBetween(top, side);
    assert.ok(arc && !arc.parallel);
    near(arc.deg, 90, 1e-9);
    assert.deepEqual(angleBetween(top, bottom), { deg: 0, parallel: true });
  });

  it("measures points against planes and edges", () => {
    const top = { kind: "face" as const, mesh: m, face: planeFace(m, 1, 1) };
    const [d] = measurePair({ kind: "point", point: [0, 0, 0] }, top);
    assert.equal(d.kind, "point-plane");
    near(d.value, 50, 1e-9);
    const edge = m.edgeRanges!.findIndex((e) => e.info.type === "line" && Math.abs(e.info.start[1] - e.info.end[1]) > 99);
    const [pl] = measurePair({ kind: "point", point: [0, 0, 0] }, { kind: "edge", mesh: m, edge });
    assert.equal(pl.kind, "point-line");
    near(pl.value, Math.SQRT2 * 50, 1e-9);
    const c = closestPoint(top, [10, 80, 0]);
    near(c.distance, 30, 1e-9);
    near(angle3([1, 0, 0], [0, 0, 0], [0, 1, 0])!.deg, 90, 1e-12);
  });

  it("applies the instance matrix", () => {
    const moved: SwMesh = { ...m, matrix: [0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 1000, 0, 0, 1] };
    const stats = computeStats([m, moved])!;
    near(stats.volume, 2e6, 1e-3);
    near(stats.area, 1.2e5, 1e-3);
    assert.deepEqual(stats.bboxMin, [-50, -50, -50]);
    assert.deepEqual(stats.bboxMax, [1050, 50, 50]);
    const top = planeFace(m, 1, 1);
    const desc = describePick({ kind: "face", mesh: moved, face: top });
    // y+ rotates to x−.
    near(desc.normal![0], -1, 1e-9);
    near(desc.point![0], 950, 1e-9);
    const [d] = measurePair({ kind: "point", point: [1000, 0, 0] }, { kind: "face", mesh: moved, face: top });
    near(d.value, 50, 1e-9);
  });
});

describe("analyzeMesh: cylinder", () => {
  it("fits the exact radius of a faceted shaft and widens the box to it", () => {
    const m = cylinder();
    analyzeMesh(m);
    assert.deepEqual(m.faces!.map((f) => f.type), ["cylinder", "plane", "plane"]);
    const f = m.faces![0];
    assert.ok(f.type === "cylinder");
    near(f.radius, 10, 1e-4);
    near(f.height, 40, 1e-4);
    assert.equal(f.full, true);
    assert.equal(f.inner, false);
    assert.equal(Math.abs(f.axis[1]) > 0.999, true);
    const circles = m.edgeRanges!.filter((e) => e.info.type === "circle");
    assert.equal(m.edgeRanges!.length, 2);
    assert.equal(circles.length, 2);
    for (const c of circles) {
      assert.ok(c.info.type === "circle" && c.info.full);
      near(c.info.radius, 10, 1e-4);
    }
    const stats = computeStats([m])!;
    // The facets reach only r·cos(π/32) in x and z.
    near(stats.bboxMax[0], 10, 1e-4);
    near(stats.bboxMin[2], -10, 1e-4);
    near(stats.bboxMax[1], 20, 1e-6);
    const d = describePick({ kind: "face", mesh: m, face: 0 });
    assert.equal(d.label, "Cylinder");
    near(d.items.find((x) => x.kind === "diameter")!.value, 20, 2e-4);
  });

  it("recognises a bore and measures its axis", () => {
    const hole = cylinder(10, 100, 24, true);
    analyzeMesh(hole);
    const f = hole.faces![0];
    assert.ok(f.type === "cylinder" && f.inner && f.full);
    assert.equal(describePick({ kind: "face", mesh: hole, face: 0 }).label, "Cylinder (hole)");
    const shaft = cylinder(5, 40, 24);
    analyzeMesh(shaft);
    const moved: SwMesh = { ...shaft, matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 30, 0, 40, 1] };
    const r = measurePair({ kind: "face", mesh: hole, face: 0 }, { kind: "face", mesh: moved, face: 0 });
    assert.equal(r[0].kind, "axis-distance");
    near(r[0].value, 50, 1e-4);
    const p = measurePair({ kind: "point", point: [0, 0, 20] }, { kind: "face", mesh: hole, face: 0 });
    assert.deepEqual(p.map((x) => x.kind), ["point-axis", "point-surface"]);
    near(p[1].value, 10, 1e-4);
  });

  it("snaps the section contour onto the fitted surface", () => {
    const m = cylinder();
    analyzeMesh(m);
    const across = sectionContour(m, { normal: [0, 1, 0], constant: 5 });
    const ring = across.find((c) => c.face === 0)!;
    assert.ok(ring.closed && ring.info.type === "circle");
    near(ring.info.radius, 10, 1e-4);
    // Lengthwise at z = 6: lines at x = ±8 on the true cylinder; facets lie inside.
    const along = sectionContour(m, { normal: [0, 0, 1], constant: 6 }).filter((c) => c.face === 0);
    assert.equal(along.length, 2);
    for (const c of along) {
      assert.equal(c.info.type, "line");
      for (const p of c.points) near(Math.abs(p[0]), 8, 1e-4);
    }
    // World-space plane on a moved instance.
    const moved: SwMesh = { ...m, matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 100, 0, 1] };
    const ringW = sectionContour(moved, { normal: [0, 2, 0], constant: 210 }).find((c) => c.face === 0)!;
    assert.ok(ringW.info.type === "circle");
    near(ringW.info.center[1], 105, 1e-4);
  });
});

describe("analyzeResult", () => {
  it("analyses shared geometry once and fills stats", () => {
    const base = cube(10);
    const inst: SwMesh = { ...base, matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 20, 0, 0, 1] };
    const r: SwParseResult = { kind: "assembly", meshes: [base, inst], warnings: [] };
    analyzeResult(r);
    assert.equal(inst.faces, base.faces);
    assert.equal(inst.edges, base.edges);
    assert.deepEqual(r.stats!.bboxMax, [25, 5, 5]);
    near(r.stats!.volume, 2000, 1e-6);
    // Edge buffers are transferred once.
    assert.equal(transferables(r).filter((b) => b === base.edges!.buffer).length, 1);
  });

  it("skips the analysis above the vertex budget but keeps the stats", () => {
    const r: SwParseResult = { kind: "part", meshes: [cube()], warnings: [] };
    analyzeResult(r, 10);
    assert.equal(r.meshes[0].faces, undefined);
    assert.match(r.warnings[0], /geometry analysis skipped/);
    near(r.stats!.area, 6e4, 1e-6);
  });
});
