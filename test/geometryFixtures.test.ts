// Geometry analysis on the CAD-Viewer-Projekt sample parts (SW_VIEWER_FIXTURES), with
// the reference values from that project's documentation and tests.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { angleBetween, measurePair, sectionContour } from "../src/geometry/index.ts";
import { parseSwFile } from "../src/parse.ts";
import type { SwFaceInfo, SwMesh, SwParseResult } from "../src/types.ts";
import { readFixture, skipUnless } from "./fixtures.ts";

const RADIUS = 0.005;
const REL = 0.005;

const near = (actual: number, expected: number, tol: number, what = "") =>
  assert.ok(Math.abs(actual - expected) <= tol, `${what} ${actual} ≉ ${expected} (±${tol})`);
const nearRel = (actual: number, expected: number, what = "") => near(actual, expected, Math.abs(expected) * REL, what);

const load = async (name: string): Promise<SwParseResult> => parseSwFile(readFixture(name));

const count = <T extends { type: string }>(xs: T[]) => {
  const out: Record<string, number> = {};
  for (const x of xs) out[x.type] = (out[x.type] ?? 0) + 1;
  return out;
};

const find = (m: SwMesh, pred: (f: SwFaceInfo) => boolean) => {
  const i = m.faces!.findIndex(pred);
  assert.ok(i >= 0, "face found");
  return { kind: "face" as const, mesh: m, face: i };
};

describe("geometry fixtures", () => {
  it("wuerfel: 100 mm cube", { skip: skipUnless("wuerfel.sldprt") }, async () => {
    const r = await load("wuerfel.sldprt");
    const m = r.meshes[0];
    assert.deepEqual(count(m.faces!), { plane: 6 });
    assert.deepEqual(count(m.edgeRanges!.map((e) => e.info)), { line: 12 });
    nearRel(r.stats!.area, 60_000, "area mm²");
    nearRel(r.stats!.volume, 1_000_000, "volume mm³");
    assert.deepEqual(r.stats!.bboxMin.map(Math.round), [-50, -50, -50]);
    assert.deepEqual(r.stats!.bboxMax.map(Math.round), [50, 50, 50]);
  });

  it("wuerfel_L20: Ø20 bore", { skip: skipUnless("wuerfel_L20.sldprt") }, async () => {
    const r = await load("wuerfel_L20.sldprt");
    const m = r.meshes[0];
    assert.deepEqual(count(m.faces!), { plane: 6, cylinder: 1 });
    const hole = find(m, (f) => f.type === "cylinder");
    const f = m.faces![hole.face];
    assert.ok(f.type === "cylinder" && f.inner && f.full);
    near(f.radius, 10, RADIUS, "bore radius");
    const side = find(m, (f) => f.type === "plane" && Math.abs(f.normal[1]) < 0.01);
    const [d] = measurePair(hole, side);
    assert.equal(d.kind, "axis-plane");
    near(d.value, 50, 1e-3, "axis to side face");
    // Section across the bore axis.
    const axis = f.axis;
    const contour = sectionContour(m, { normal: axis, constant: 0 }).find((c) => c.face === hole.face);
    assert.ok(contour && contour.info.type === "circle" && contour.closed);
    near(2 * contour.info.radius, 20, 2 * RADIUS, "section diameter");
  });

  it("wuerfel_R10: R10 fillets and SR10 corners", { skip: skipUnless("wuerfel_R10.sldprt") }, async () => {
    const r = await load("wuerfel_R10.sldprt");
    const m = r.meshes[0];
    assert.equal(m.faces!.length, 26);
    assert.deepEqual(count(m.faces!), { plane: 6, cylinder: 12, sphere: 8 });
    for (const f of m.faces!) {
      if (f.type === "cylinder") {
        near(f.radius, 10, RADIUS, "fillet");
        assert.ok(!f.full && !f.inner);
        near(f.arcDeg, 90, 0.5, "fillet arc");
      }
      if (f.type === "sphere") near(f.radius, 10, RADIUS, "corner");
    }
  });

  it("zylinder: Ø50×80", { skip: skipUnless("zylinder.sldprt") }, async () => {
    const r = await load("zylinder.sldprt");
    const m = r.meshes[0];
    const cyl = m.faces!.find((f) => f.type === "cylinder");
    assert.ok(cyl && cyl.type === "cylinder");
    near(cyl.radius, 25, RADIUS, "radius");
    const s = r.stats!;
    const size = s.bboxMax.map((v, i) => v - s.bboxMin[i]);
    near(size[0], 50, 1e-3, "bbox x");
    near(size[1], 80, 1e-3, "bbox y");
    near(size[2], 50, 1e-3, "bbox z");
  });

  it("Teil: Ø25 shaft, pentagon and freeform faces", { skip: skipUnless("Teil.sldprt") }, async () => {
    const r = await load("Teil.sldprt");
    const m = r.meshes[0];
    const shaft = m.faces!.find((f) => f.type === "cylinder");
    assert.ok(shaft && shaft.type === "cylinder");
    near(2 * shaft.radius, 25, 2 * RADIUS, "shaft diameter");
    near(shaft.height, 60, 1e-3, "shaft length");
    // Pentagon prism: side planes with horizontal normals.
    const sides = m.faces!.flatMap((f, i) => (f.type === "plane" && Math.abs(f.normal[1]) < 1e-3 ? [i] : []));
    assert.equal(sides.length, 5);
    const angles = sides.slice(1).map((j) => angleBetween({ kind: "face", mesh: m, face: sides[0] }, { kind: "face", mesh: m, face: j }));
    assert.ok(angles.some((a) => a && !a.parallel && Math.abs(a.deg - 108) < 0.01), "108° pentagon angle");
    assert.ok((count(m.faces!).other ?? 0) > 0, "freeform faces");
    const free = find(m, (f) => f.type === "other");
    const [d] = measurePair({ kind: "point", point: [0, 40, 0] }, free);
    assert.equal(d.kind, "point-face");
    assert.ok(d.value > 0 && d.from && d.to);
  });
});
