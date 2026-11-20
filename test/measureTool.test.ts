// SwMeasureTool picking without a browser: a stub canvas and just enough of `document`
// for the CSS2D markers.

import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import * as THREE from "three";
import { analyzeMesh } from "../src/geometry/index.ts";
import { SwMeasureTool } from "../src/three/measure.ts";
import { buildSwGroup } from "../src/three/scene.ts";
import { SwSectionView } from "../src/three/section.ts";
import type { SwMesh } from "../src/types.ts";
import { cube } from "./meshes.ts";

const W = 400;
const H = 300;

before(() => {
  const g = globalThis as { document?: unknown };
  g.document ??= {
    createElement: () => ({
      style: {},
      className: "",
      textContent: "",
      dataset: {},
      parentNode: null,
      ownerDocument: { defaultView: { Element: class {} } },
      remove() {},
      setAttribute() {},
    }),
  };
});

const setup = (meshes: SwMesh[]) => {
  const model = buildSwGroup(meshes);
  const scene = new THREE.Scene();
  scene.add(model);
  const camera = new THREE.PerspectiveCamera(45, W / H, 1, 10000);
  camera.position.set(0, 0, 400);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  camera.updateProjectionMatrix();
  model.updateMatrixWorld(true);
  const canvas = {
    addEventListener() {},
    removeEventListener() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: W, height: H }),
    clientHeight: H,
    style: {},
  } as unknown as HTMLCanvasElement;
  const section = new SwSectionView();
  const tool = new SwMeasureTool({
    canvas,
    camera,
    target: new THREE.Vector3(),
    scene,
    section,
    model: () => model,
    edgesVisible: () => true,
  });
  /** Screen position of a world point. */
  const screen = (p: THREE.Vector3) => {
    const v = p.clone().project(camera);
    return [((v.x + 1) / 2) * W, ((1 - v.y) / 2) * H] as const;
  };
  return { tool, model, screen };
};

const instances = (n: number): SwMesh[] => {
  const src = cube(40);
  analyzeMesh(src);
  // A row of 40 mm cubes along x, 60 mm apart, centred on the origin.
  return Array.from({ length: n }, (_, i) => ({
    ...src,
    componentId: `C-${i}`,
    matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 60 * (i - (n - 1) / 2), 0, 0, 1],
  }));
};

describe("SwMeasureTool", () => {
  it("snaps to the corner of the instance under the cursor among many", () => {
    const meshes = instances(9);
    const { tool, screen } = setup(meshes);
    // Front top right corner of instance 5 (centre x = 60).
    const [sx, sy] = screen(new THREE.Vector3(80, 20, 20));
    const hit = tool.pickAt(sx + 2, sy - 1, "point");
    assert.equal(hit?.pick.kind, "point");
    assert.equal(hit?.pick.snap, "corner");
    assert.equal(hit?.pick.meshIndex, 5);
    assert.equal(hit?.pick.componentId, "C-5");
    if (hit?.pick.kind === "point") {
      assert.ok(Math.hypot(hit.pick.point[0] - 80, hit.pick.point[1] - 20, hit.pick.point[2] - 20) < 1e-6);
    }
  });

  it("gives surface points their mesh and component, and prunes them when hidden", () => {
    const meshes = instances(3);
    const { tool, model, screen } = setup(meshes);
    // Middle of the front face of instance 0 (centre x = -60), away from any snap point.
    const [sx, sy] = screen(new THREE.Vector3(-60, 0, 20));
    const hit = tool.pickAt(sx, sy, "point");
    assert.equal(hit?.pick.snap, "surface");
    assert.equal(hit?.pick.meshIndex, 0);
    assert.equal(hit?.pick.componentId, "C-0");

    tool.setMode("point");
    const click = (x: number, y: number) =>
      (tool as unknown as { click(ev: { clientX: number; clientY: number }): void }).click({ clientX: x, clientY: y });
    click(sx, sy);
    const [cx, cy] = screen(new THREE.Vector3(80, 20, 20));
    click(cx, cy);
    assert.deepEqual(tool.picks.map((p) => p.meshIndex), [0, 2]);
    model.children[0].visible = false;
    tool.pruneHidden();
    assert.deepEqual(tool.picks.map((p) => p.meshIndex), [2]);
  });

  it("projects only instances near the cursor", () => {
    const meshes = instances(200);
    const { tool, screen } = setup(meshes);
    let projected = 0;
    const project = THREE.Vector3.prototype.project;
    THREE.Vector3.prototype.project = function (this: THREE.Vector3, camera: THREE.Camera) {
      projected++;
      return project.call(this, camera);
    };
    try {
      // Corner of instance 100 (centre x = 30).
      const [sx, sy] = screen(new THREE.Vector3(50, 20, 20));
      const hit = tool.pickAt(sx, sy, "point");
      assert.equal(hit?.pick.snap, "corner");
    } finally {
      THREE.Vector3.prototype.project = project;
    }
    // A cube has 8 corners; without the culling all 200 instances would be projected.
    assert.ok(projected < 8 * 10, `${projected} projections`);
  });
});
