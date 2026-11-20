// Section plane maths and the three.js section view, without a WebGL renderer.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as THREE from "three";
import { analyzeMesh, describe as describePick } from "../src/geometry/index.ts";
import { parseSwFile } from "../src/parse.ts";
import { buildSwGroup } from "../src/three/scene.ts";
import {
  clipPlaneOf,
  contourMesh,
  cylinderSectionNormal,
  sectionFromDescription,
  sectionPlane,
  sectionRange,
  SwSectionView,
  type SwBox,
} from "../src/three/section.ts";
import type { Vec3 } from "../src/types.ts";
import { readFixture, skipUnless } from "./fixtures.ts";
import { cube, cylinder } from "./meshes.ts";

const box: SwBox = { min: [-10, -20, -30], max: [10, 20, 50] };
const near = (a: number, b: number, tol = 1e-9) => assert.ok(Math.abs(a - b) <= tol, `${a} ≉ ${b}`);
const nearVec = (a: Vec3, b: Vec3, tol = 1e-9) => a.forEach((x, i) => near(x, b[i], tol));

describe("section plane maths", () => {
  it("axis sections default to the box centre", () => {
    assert.deepEqual(sectionPlane({ kind: "axis", axis: "z" }, box), { normal: [0, 0, 1], constant: 10 });
    assert.deepEqual(sectionPlane({ kind: "axis", axis: "x", offset: 3 }, box), { normal: [1, 0, 0], constant: 3 });
    assert.deepEqual(sectionRange({ kind: "axis", axis: "y" }, box), [-20, 20]);
  });

  it("the clip plane keeps normal·x <= constant, or the other side when flipped", () => {
    const plane = sectionPlane({ kind: "axis", axis: "x", offset: 2 });
    const keep = (c: { normal: Vec3; constant: number }, p: Vec3) => new THREE.Plane(new THREE.Vector3(...c.normal), c.constant).distanceToPoint(new THREE.Vector3(...p)) >= 0;
    const c = clipPlaneOf(plane);
    assert.equal(keep(c, [1, 0, 0]), true);
    assert.equal(keep(c, [3, 0, 0]), false);
    const f = clipPlaneOf(plane, true);
    assert.equal(keep(f, [1, 0, 0]), false);
    assert.equal(keep(f, [3, 0, 0]), true);
  });

  it("face sections are parallel to the face, offset along its normal", () => {
    const p = sectionPlane({ kind: "face", point: [0, 0, 5], normal: [0, 0, 2], offset: -1 });
    nearVec(p.normal, [0, 0, 1]);
    near(p.constant, 4);
    // The range runs from the far side of the box to 0 (the face itself) and beyond.
    assert.deepEqual(sectionRange({ kind: "face", point: [0, 0, 50], normal: [0, 0, 1] }, box), [-80, 0]);
  });

  it("cylinder sections contain the axis and turn around it", () => {
    const axis: Vec3 = [0, 1, 0];
    const n0 = cylinderSectionNormal(axis, 0, [1, 1, 0]);
    nearVec(n0, [1, 0, 0]);
    const n90 = cylinderSectionNormal(axis, 90, [1, 1, 0]);
    near(Math.abs(n90[2]), 1);
    near(n90[1], 0);
    // Without a usable reference a perpendicular basis vector is used.
    near(Math.abs(cylinderSectionNormal(axis, 0, [0, 1, 0])[1]), 0);
    const p = sectionPlane({ kind: "cylinder", center: [5, 0, 0], axis, ref: [1, 0, 0] });
    nearVec(p.normal, [1, 0, 0]);
    near(p.constant, 5);
  });

  it("builds specs from picked faces", () => {
    const shaft = cylinder(10, 40);
    analyzeMesh(shaft);
    const side = describePick({ kind: "face", mesh: shaft, face: 0 });
    const cyl = sectionFromDescription(side, "cylinder", { viewDir: [0, 0, 1] });
    assert.equal(cyl?.kind, "cylinder");
    assert.equal(sectionFromDescription(side, "face"), null);
    const top = describePick({ kind: "face", mesh: shaft, face: 2 });
    const face = sectionFromDescription(top, "face", { box: { min: [-10, -20, -10], max: [10, 20, 10] } });
    assert.equal(face?.kind, "face");
    // Half way into the part.
    near(face!.offset!, -20);
    assert.equal(sectionFromDescription(top, "cylinder"), null);
  });

  it("packs contours into a pickable edge mesh", () => {
    const m = contourMesh([
      { face: 3, points: [[0, 0, 0], [1, 0, 0], [1, 1, 0]], closed: false, info: { type: "curve", length: 2, closed: false } },
      { face: 4, points: [[5, 5, 5], [6, 5, 5]], closed: false, info: { type: "line", start: [5, 5, 5], end: [6, 5, 5], length: 1 } },
    ]);
    assert.equal(m.edges!.length, 3 * 6);
    assert.deepEqual(m.edgeRanges!.map((r) => [r.start, r.count, r.faces[0]]), [[0, 2, 3], [2, 1, 4]]);
  });
});

describe("SwSectionView", () => {
  it("clips the model materials, adds stencil meshes and a cap, and removes them again", () => {
    const m = cube(10);
    analyzeMesh(m);
    const group = buildSwGroup([m]);
    const view = new SwSectionView();
    view.setModel(group, { min: [-5, -5, -5], max: [5, 5, 5] });
    const mesh = group.children[0] as THREE.Mesh<THREE.BufferGeometry, THREE.Material>;
    view.set({ kind: "axis", axis: "x" });
    assert.deepEqual(mesh.material.clippingPlanes, [view.clipPlane]);
    assert.equal(mesh.children.filter((c) => c.userData.swStencil).length, 2);
    assert.equal(view.group.getObjectByName("section-cap")!.visible, true);
    assert.equal(view.isClipped(new THREE.Vector3(3, 0, 0)), true);
    assert.equal(view.isClipped(new THREE.Vector3(-3, 0, 0)), false);

    view.updateContours();
    // The x = 0 cut through a cube gives four straight contour lines.
    assert.equal(view.contours!.edgeRanges!.length, 4);
    assert.ok(view.contours!.edgeRanges!.every((r) => r.info.type === "line"));
    assert.ok(view.contourLines);

    view.set(null);
    assert.equal(mesh.material.clippingPlanes, null);
    assert.equal(mesh.children.filter((c) => c.userData.swStencil).length, 0);
    assert.equal(view.contours, null);
    view.dispose();
  });

  it("wuerfel_L20: the section through the bore gives an exact Ø20 contour", { skip: skipUnless("wuerfel_L20.sldprt") }, async () => {
    const r = await parseSwFile(readFixture("wuerfel_L20.sldprt"));
    const group = buildSwGroup(r.meshes);
    const view = new SwSectionView();
    view.setModel(group, { min: r.stats!.bboxMin, max: r.stats!.bboxMax });
    view.set({ kind: "axis", axis: "y", offset: 0 });
    view.updateContours();
    const circles = view.contours!.edgeRanges!.filter((e) => e.info.type === "circle");
    assert.equal(circles.length, 1);
    const d = describePick({ kind: "edge", mesh: view.contours!, edge: view.contours!.edgeRanges!.indexOf(circles[0]) });
    near(d.items.find((x) => x.kind === "diameter")!.value, 20, 1e-3);
    view.dispose();
  });
});
