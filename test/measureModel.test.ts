// Measurement results and number formatting (no WebGL, no DOM).

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { analyzeMesh } from "../src/geometry/index.ts";
import {
  computeMeasurement,
  formatDimension,
  formatMeasureValue,
  formatNumber,
  oppositePlane,
  primaryDimension,
} from "../src/three/measureModel.ts";
import { describe as describePick } from "../src/geometry/index.ts";
import type { SwFaceInfo, SwMesh } from "../src/types.ts";
import { cube, cylinder } from "./meshes.ts";

const near = (a: number, b: number, tol = 1e-6) => assert.ok(Math.abs(a - b) <= tol, `${a} ≉ ${b}`);

const analyzed = (m: SwMesh) => {
  analyzeMesh(m);
  return m;
};
const faceOf = (m: SwMesh, pred: (f: SwFaceInfo) => boolean) => m.faces!.findIndex(pred);

describe("formatting", () => {
  it("formats numbers with fixed decimals and no negative zero", () => {
    assert.equal(formatNumber(20, 3), "20.000");
    assert.equal(formatNumber(-0.0001, 3), "0.000");
    assert.equal(formatNumber(1234.5, 2, "de-DE"), "1234,50");
  });

  it("prefixes diameters, radii and sphere radii; angles get degrees", () => {
    assert.equal(formatDimension({ kind: "diameter", label: "", value: 20, unit: "mm" }), "Ø20.000");
    assert.equal(formatDimension({ kind: "radius", label: "", value: 5, unit: "mm" }), "R5.000");
    assert.equal(formatDimension({ kind: "sphere-radius", label: "", value: 5, unit: "mm" }), "SR5.000");
    assert.equal(formatDimension({ kind: "angle", label: "", value: 45, unit: "deg" }), "45.00°");
    assert.equal(formatDimension({ kind: "distance", label: "", value: 12.5, unit: "mm" }, { locale: "de-DE", digits: 1 }), "12,5");
  });

  it("table values carry the unit and mark approximations", () => {
    assert.equal(formatMeasureValue({ kind: "area", label: "", value: 100, unit: "mm²" }), "100.000 mm²");
    assert.equal(formatMeasureValue({ kind: "min-distance", label: "", value: 3, unit: "mm", approx: true }), "≈ 3.000 mm");
    assert.equal(formatMeasureValue({ kind: "angle", label: "", value: 90, unit: "deg" }), "90.00°");
  });
});

describe("primary dimension", () => {
  it("a full cylinder gets a diameter across the screen", () => {
    const m = analyzed(cylinder(10, 40, 48));
    const pick = { kind: "face" as const, mesh: m, face: faceOf(m, (f) => f.type === "cylinder") };
    const p = primaryDimension(pick, describePick(pick), [0, 0, -1])!;
    assert.equal(p.item.kind, "diameter");
    near(p.item.value, 20, 1e-3);
    assert.equal(p.dimension?.kind, "line");
    if (p.dimension?.kind === "line") {
      // Perpendicular to the axis (y) and the view direction (z): along x.
      near(Math.abs(p.dimension.to[0] - p.dimension.from[0]), 20, 1e-3);
      near(p.dimension.from[1], p.dimension.to[1]);
    }
  });

  it("a hole is labelled as hole diameter", () => {
    const m = analyzed(cylinder(10, 40, 48, true));
    const pick = { kind: "face" as const, mesh: m, face: 0 };
    assert.equal(primaryDimension(pick, describePick(pick))!.item.label, "Hole diameter");
  });

  it("a plane gets the wall thickness to the opposite face", () => {
    const m = analyzed(cube(10));
    const top = faceOf(m, (f) => f.type === "plane" && f.normal[1] > 0.99);
    const bottom = faceOf(m, (f) => f.type === "plane" && f.normal[1] < -0.99);
    const opp = oppositePlane(m, top)!;
    assert.equal(opp.face, bottom);
    assert.equal(opp.overlap, true);
    near(opp.distance, 10);
    const pick = { kind: "face" as const, mesh: m, face: top };
    const p = primaryDimension(pick, describePick(pick))!;
    assert.equal(p.item.kind, "wall-thickness");
    near(p.item.value, 10);
  });

  it("a straight edge gets its length between the end points", () => {
    const m = analyzed(cube(10));
    const pick = { kind: "edge" as const, mesh: m, edge: 0 };
    const p = primaryDimension(pick, describePick(pick))!;
    assert.equal(p.item.label, "Edge length");
    near(p.item.value, 10);
  });

  it("points have none", () => {
    const pick = { kind: "point" as const, point: [0, 0, 0] as [number, number, number] };
    assert.equal(primaryDimension(pick, describePick(pick)), null);
  });
});

describe("computeMeasurement", () => {
  it("is null without picks", () => {
    assert.equal(computeMeasurement([]), null);
  });

  it("one pick: the primary value first, without its duplicate", () => {
    const m = analyzed(cylinder(10, 40, 48));
    const r = computeMeasurement([{ kind: "face", mesh: m, face: faceOf(m, (f) => f.type === "cylinder") }])!;
    assert.equal(r.items[0], r.primary);
    assert.equal(r.items.filter((x) => x.kind === "diameter").length, 1);
    assert.ok(r.items.some((x) => x.kind === "radius"));
    assert.equal(r.dimensions.length, 1);
  });

  it("two parallel planes: distance with a dimension line", () => {
    const m = analyzed(cube(10));
    const a = faceOf(m, (f) => f.type === "plane" && f.normal[0] > 0.99);
    const b = faceOf(m, (f) => f.type === "plane" && f.normal[0] < -0.99);
    const r = computeMeasurement([
      { kind: "face", mesh: m, face: a },
      { kind: "face", mesh: m, face: b },
    ])!;
    assert.equal(r.primary?.kind, "distance");
    near(r.primary!.value, 10);
    assert.equal(r.dimensions[0].kind, "line");
  });

  it("two perpendicular planes: angle with an arc and its supplement", () => {
    const m = analyzed(cube(10));
    const a = faceOf(m, (f) => f.type === "plane" && f.normal[0] > 0.99);
    const b = faceOf(m, (f) => f.type === "plane" && f.normal[1] > 0.99);
    const r = computeMeasurement(
      [
        { kind: "face", mesh: m, face: a },
        { kind: "face", mesh: m, face: b },
      ],
      { mode: "angle" },
    )!;
    assert.equal(r.primary?.kind, "angle");
    near(r.primary!.value, 90);
    assert.ok(r.items.some((x) => x.kind === "supplementary-angle"));
    assert.deepEqual(r.dimensions.map((d) => d.kind), ["angle"]);
  });

  it("three points: angle at the middle point", () => {
    const r = computeMeasurement([
      { kind: "point", point: [1, 0, 0] },
      { kind: "point", point: [0, 0, 0] },
      { kind: "point", point: [0, 1, 0] },
    ])!;
    near(r.primary!.value, 90);
    assert.equal(r.dimensions[0].kind, "angle");
  });
});
