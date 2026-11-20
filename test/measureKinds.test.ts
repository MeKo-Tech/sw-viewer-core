// Measured value kinds and element shapes: one kind per meaning, every produced kind
// listed in SW_MEASURE_KINDS, and the English hints taken from the per-kind tables.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  analyzeMesh,
  defaultMeasureItemLabels,
  defaultShapeLabels,
  describe as describePick,
  snapPoints,
  SW_MEASURE_KINDS,
  SW_SHAPES,
  type SwDescription,
  type SwMeasureItem,
  type SwPick,
} from "../src/geometry/index.ts";
import { parseSwFile } from "../src/parse.ts";
import { computeMeasurement, type SwViewerPick } from "../src/three/measureModel.ts";
import type { SwMesh, Vec3 } from "../src/types.ts";
import { haveFixture, readFixture } from "./fixtures.ts";
import { cube, cylinder } from "./meshes.ts";

const analyzed = (m: SwMesh) => {
  analyzeMesh(m);
  return m;
};

const kinds = new Set<string>(SW_MEASURE_KINDS);
const shapes = new Set<string>(SW_SHAPES);

/** Faces, edges and snap points of a mesh, at most `cap` of each. */
const picksOf = (m: SwMesh, cap = 20): SwViewerPick[] => [
  ...(m.faces ?? []).slice(0, cap).map((_, face) => ({ kind: "face" as const, mesh: m, face })),
  ...(m.edgeRanges ?? []).slice(0, cap).map((_, edge) => ({ kind: "edge" as const, mesh: m, edge })),
  ...snapPoints(m)
    .slice(0, cap)
    .map((s) => ({ kind: "point" as const, point: s.point })),
  { kind: "point" as const, point: [1000, 3, 7] as Vec3 },
];

/** Every item and description the measurement model produces for the picks, alone, in pairs and as point triples. */
const sweep = (picks: SwViewerPick[]) => {
  const items: SwMeasureItem[] = [];
  const descriptions: SwDescription[] = [];
  const add = (r: ReturnType<typeof computeMeasurement>) => {
    if (!r) return;
    items.push(...r.items);
    descriptions.push(...r.descriptions);
  };
  for (const p of picks) add(computeMeasurement([p]));
  for (let i = 0; i < picks.length; i++)
    for (let j = i + 1; j < picks.length; j++) {
      add(computeMeasurement([picks[i], picks[j]]));
      add(computeMeasurement([picks[i], picks[j]], { mode: "angle" }));
    }
  const pts = picks.filter((p) => p.kind === "point");
  if (pts.length >= 3) add(computeMeasurement(pts.slice(0, 3), { mode: "angle" }));
  return { items, descriptions };
};

const assertListed = ({ items, descriptions }: ReturnType<typeof sweep>) => {
  assert.ok(items.length > 0);
  for (const it of items) {
    assert.ok(kinds.has(it.kind), `kind ${it.kind} missing from SW_MEASURE_KINDS`);
    assert.equal(it.label, defaultMeasureItemLabels[it.kind], `label of ${it.kind}`);
  }
  for (const d of descriptions) {
    assert.ok(shapes.has(d.shape), `shape ${d.shape} missing from SW_SHAPES`);
    assert.equal(d.label, defaultShapeLabels[d.shape]);
  }
  return new Set(items.map((x) => x.kind));
};

describe("measure kinds", () => {
  it("are unique, each with its own English text", () => {
    assert.equal(kinds.size, SW_MEASURE_KINDS.length);
    assert.deepEqual(Object.keys(defaultMeasureItemLabels).sort(), [...SW_MEASURE_KINDS].sort());
    const texts = Object.values(defaultMeasureItemLabels);
    assert.equal(new Set(texts).size, texts.length, "two kinds share a text");
    assert.equal(shapes.size, SW_SHAPES.length);
    assert.deepEqual(Object.keys(defaultShapeLabels).sort(), [...SW_SHAPES].sort());
    assert.equal(new Set(Object.values(defaultShapeLabels)).size, SW_SHAPES.length);
  });

  it("every kind produced on cubes, cylinders and holes is listed", () => {
    const seen = new Set<string>();
    for (const m of [cube(10), cylinder(10, 40, 48), cylinder(10, 40, 48, true)]) {
      for (const k of assertListed(sweep(picksOf(analyzed(m))))) seen.add(k);
    }
    for (const k of ["distance", "plane-distance", "angle", "three-point-angle", "edge-length", "diameter", "hole-diameter"]) {
      assert.ok(seen.has(k), `${k} not produced`);
    }
  });

  for (const name of ["wuerfel_L20.sldprt", "wuerfel_R10.sldprt", "zylinder.sldprt", "Teil.sldprt"]) {
    it(`every kind produced on ${name} is listed`, { skip: haveFixture(name) ? false : "fixture missing" }, async () => {
      const r = await parseSwFile(readFixture(name));
      assertListed(sweep(picksOf(r.meshes[0])));
    });
  }

  it("a hole and a shaft get different kinds and shapes", () => {
    const shaft = analyzed(cylinder(10, 40, 48));
    const hole = analyzed(cylinder(10, 40, 48, true));
    const side = (m: SwMesh): SwPick => ({ kind: "face", mesh: m, face: m.faces!.findIndex((f) => f.type === "cylinder") });
    const a = computeMeasurement([side(shaft)])!;
    const b = computeMeasurement([side(hole)])!;
    assert.equal(a.primary?.kind, "diameter");
    assert.equal(b.primary?.kind, "hole-diameter");
    assert.equal(b.items.filter((x) => x.kind === "hole-diameter").length, 1, "primary replaces its duplicate");
    assert.deepEqual([a.descriptions[0].shape, a.descriptions[0].inner, a.descriptions[0].full], ["cylinder", false, true]);
    assert.deepEqual([b.descriptions[0].shape, b.descriptions[0].inner], ["hole", true]);
  });

  it("parallel planes, points, and three points get different kinds", () => {
    const m = analyzed(cube(10));
    const plane = (axis: number, sign: number): SwPick => ({
      kind: "face",
      mesh: m,
      face: m.faces!.findIndex((f) => f.type === "plane" && f.normal[axis] * sign > 0.99),
    });
    assert.equal(computeMeasurement([plane(0, 1), plane(0, -1)])!.primary?.kind, "plane-distance");
    assert.equal(computeMeasurement([plane(0, 1), plane(0, -1)], { mode: "angle" })!.primary?.kind, "parallel-angle");
    assert.equal(computeMeasurement([plane(0, 1), plane(1, 1)], { mode: "angle" })!.primary?.kind, "angle");
    const pt = (p: Vec3): SwPick => ({ kind: "point", point: p });
    assert.equal(computeMeasurement([pt([0, 0, 0]), pt([1, 0, 0])])!.primary?.kind, "distance");
    assert.equal(computeMeasurement([pt([1, 0, 0]), pt([0, 0, 0]), pt([0, 1, 0])])!.primary?.kind, "three-point-angle");
  });

  it("line edges have an edge length, points a point shape", () => {
    const m = analyzed(cube(10));
    const d = describePick({ kind: "edge", mesh: m, edge: 0 });
    assert.equal(d.shape, "line");
    assert.deepEqual(d.items.map((x) => x.kind), ["edge-length"]);
    assert.equal(describePick({ kind: "point", point: [0, 0, 0] }).shape, "point");
  });
});
