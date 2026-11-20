import assert from "node:assert/strict";
import { test } from "node:test";
import * as THREE from "three";
import { analyzeMesh } from "../src/geometry/index.ts";
import {
  applyPartColors,
  buildSwGroup,
  disposeObject,
  fitCamera,
  segmentEdges,
  setEdgesVisible,
  swMeshData,
  triangleFaces,
} from "../src/three/scene.ts";
import type { SwMesh } from "../src/types.ts";
import { cube } from "./meshes.ts";

// Two triangles forming a unit quad in the z=0 plane; vertex 3 is used by the second triangle only.
const quad = (extra: Partial<SwMesh> = {}): SwMesh => ({
  positions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]),
  indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
  ...extra,
});

const meshes = (group: THREE.Group) => group.children as THREE.Mesh<THREE.BufferGeometry, THREE.MeshPhongMaterial>[];

const rgbAt = (attr: THREE.BufferAttribute, i: number) => [attr.getX(i), attr.getY(i), attr.getZ(i)];

const assertRgbClose = (actual: number[], expected: number[]) => {
  for (let k = 0; k < 3; k++) assert.ok(Math.abs(actual[k] - expected[k]) < 1e-6, `${actual} != ${expected}`);
};

test("builds one mesh per SwMesh with position and index attributes", () => {
  const a = quad({ name: "a" });
  const b = quad({ name: "b" });
  const group = buildSwGroup([a, b]);
  const ms = meshes(group);
  assert.equal(ms.length, 2);
  assert.deepEqual(
    ms.map((m) => m.name),
    ["a", "b"],
  );
  for (const [m, src] of [
    [ms[0], a],
    [ms[1], b],
  ] as const) {
    assert.ok(m instanceof THREE.Mesh);
    const pos = m.geometry.getAttribute("position") as THREE.BufferAttribute;
    assert.equal(pos.itemSize, 3);
    assert.equal(pos.array, src.positions);
    assert.equal(m.geometry.getIndex()?.array, src.indices);
  }
});

test("uses given normals and computes them when missing", () => {
  const normals = new Float32Array([0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1]);
  const given = meshes(buildSwGroup([quad({ normals })]))[0];
  assert.equal((given.geometry.getAttribute("normal") as THREE.BufferAttribute).array, normals);

  const computed = meshes(buildSwGroup([quad()]))[0];
  const n = computed.geometry.getAttribute("normal") as THREE.BufferAttribute;
  assert.ok(n, "normal attribute is computed");
  assert.equal(n.count, 4);
  // Counter-clockwise quad in the xy plane -> +z normals.
  for (let i = 0; i < 4; i++) assertRgbClose(rgbAt(n, i), [0, 0, 1]);
});

test(
  "computed normals respect the index buffer (vertex 3 is only reachable through indices)",
  () => {
    const computed = meshes(buildSwGroup([quad()]))[0];
    const n = computed.geometry.getAttribute("normal") as THREE.BufferAttribute;
    assertRgbClose(rgbAt(n, 3), [0, 0, 1]);
  },
);

test("base color comes from color, else defaults to 0xcccccc", () => {
  const [colored, plain] = meshes(buildSwGroup([quad({ color: [1, 0, 0] }), quad()]));
  assert.equal(colored.material.color.getHex(), 0xff0000);
  assert.equal(colored.material.vertexColors, false);
  assert.equal(plain.material.color.getHex(), 0xcccccc);
  assert.equal(plain.geometry.getAttribute("color"), undefined);
});

test("colored face ranges become vertex colors over a white material", () => {
  // Face 0 = triangle (0,1,2) uncolored; face 1 = triangle (0,2,3) green. Vertex 3 belongs to face 1 only,
  // vertex 1 to face 0 only.
  const base: [number, number, number] = [0.2, 0.4, 0.6];
  const m = meshes(
    buildSwGroup([
      quad({
        color: base,
        faceRanges: [
          { start: 0, count: 3 },
          { start: 3, count: 3, color: [0, 1, 0] },
        ],
      }),
    ]),
  )[0];
  assert.equal(m.material.vertexColors, true);
  assert.equal(m.material.color.getHex(), 0xffffff);
  const colors = m.geometry.getAttribute("color") as THREE.BufferAttribute;
  assert.ok(colors);
  assert.equal(colors.count, 4);
  const baseLinear = new THREE.Color(...base);
  assertRgbClose(rgbAt(colors, 1), [baseLinear.r, baseLinear.g, baseLinear.b]);
  for (const v of [0, 2, 3]) assertRgbClose(rgbAt(colors, v), [0, 1, 0]);
});

test("face ranges without any color produce no color attribute", () => {
  const m = meshes(
    buildSwGroup([
      quad({
        faceRanges: [
          { start: 0, count: 3 },
          { start: 3, count: 3 },
        ],
      }),
    ]),
  )[0];
  assert.equal(m.geometry.getAttribute("color"), undefined);
  assert.equal(m.material.vertexColors, false);
  assert.equal(m.material.color.getHex(), 0xcccccc);
});

// Column-major translation by (10, 0, 0).
const translateX10 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 10, 0, 0, 1];

test("matrix is applied verbatim with matrixAutoUpdate off", () => {
  const [withMatrix, without] = meshes(buildSwGroup([quad({ matrix: translateX10 }), quad()]));
  assert.equal(withMatrix.matrixAutoUpdate, false);
  assert.deepEqual(withMatrix.matrix.toArray(), translateX10);
  assert.equal(without.matrixAutoUpdate, true);
  assert.deepEqual(without.matrix.toArray(), new THREE.Matrix4().toArray());
});

const fakeControls = () => {
  let updates = 0;
  return {
    target: new THREE.Vector3(),
    update() {
      updates++;
    },
    get updates() {
      return updates;
    },
  };
};

const assertVecClose = (v: THREE.Vector3, x: number, y: number, z: number) => {
  assert.ok(v.distanceTo(new THREE.Vector3(x, y, z)) < 1e-6, `${v.toArray()} != ${[x, y, z]}`);
};

const lookDir = (camera: THREE.Camera) => camera.getWorldDirection(new THREE.Vector3());

test("fitCamera aims at the box center and scales near/far with size", () => {
  const camera = new THREE.PerspectiveCamera();
  const controls = fakeControls();
  fitCamera(camera, buildSwGroup([quad()]), controls);
  assertVecClose(controls.target, 0.5, 0.5, 0);
  assert.equal(controls.updates, 1);
  const toCenter = new THREE.Vector3(0.5, 0.5, 0).sub(camera.position).normalize();
  assert.ok(lookDir(camera).dot(toCenter) > 1 - 1e-6);
  assert.ok(Math.abs(camera.near - 0.01) < 1e-9);
  assert.ok(Math.abs(camera.far - 100) < 1e-9);

  // Scaled 10x: near/far scale with the size.
  const big = quad({ positions: new Float32Array([0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 10, 0]) });
  const camera2 = new THREE.PerspectiveCamera();
  fitCamera(camera2, buildSwGroup([big]));
  assert.ok(Math.abs(camera2.near - 0.1) < 1e-9);
  assert.ok(Math.abs(camera2.far - 1000) < 1e-9);
  assert.ok(camera2.position.distanceTo(new THREE.Vector3(5, 5, 0)) > camera.position.distanceTo(new THREE.Vector3(0.5, 0.5, 0)));
});

test("fitCamera respects the assembly matrix", () => {
  const camera = new THREE.PerspectiveCamera();
  const controls = fakeControls();
  fitCamera(camera, buildSwGroup([quad({ matrix: translateX10 })]), controls);
  assertVecClose(controls.target, 10.5, 0.5, 0);
  const toCenter = new THREE.Vector3(10.5, 0.5, 0).sub(camera.position).normalize();
  assert.ok(lookDir(camera).dot(toCenter) > 1 - 1e-6);
});

test("disposeObject disposes geometries and materials", () => {
  const group = buildSwGroup([quad(), quad({ color: [1, 0, 0] })]);
  const disposed: unknown[] = [];
  for (const m of meshes(group)) {
    m.geometry.addEventListener("dispose", (e) => disposed.push(e.target));
    m.material.addEventListener("dispose", (e) => disposed.push(e.target));
  }
  // Array materials are handled too.
  const extraMats = [new THREE.MeshBasicMaterial(), new THREE.MeshBasicMaterial()];
  const extra = new THREE.Mesh(new THREE.BufferGeometry(), extraMats);
  extra.geometry.addEventListener("dispose", (e) => disposed.push(e.target));
  for (const mat of extraMats) mat.addEventListener("dispose", (e) => disposed.push(e.target));
  group.add(extra);

  disposeObject(group);
  const expected = [
    ...meshes(group)
      .slice(0, 2)
      .flatMap((m) => [m.geometry, m.material]),
    extra.geometry,
    ...extraMats,
  ];
  assert.equal(disposed.length, expected.length);
  for (const o of expected) assert.ok(disposed.includes(o));
});

// ---------- edges, face lookup, visibility, colours ----------


const analyzedCube = () => {
  const m = cube(10);
  analyzeMesh(m);
  return m;
};

test("each mesh gets its edges as a LineSegments child sharing mesh.edges", () => {
  const m = analyzedCube();
  const mesh = meshes(buildSwGroup([m]))[0];
  const data = swMeshData(mesh)!;
  assert.ok(data.edgeLines instanceof THREE.LineSegments);
  assert.equal(data.edgeLines.parent, mesh);
  assert.equal((data.edgeLines.geometry.getAttribute("position") as THREE.BufferAttribute).array, m.edges);
  // Segment -> edge mapping covers every segment of the 12 cube edges.
  const segEdge = (data.edgeLines.userData as { segEdge: Int32Array }).segEdge;
  assert.equal(segEdge.length, m.edges!.length / 6);
  assert.ok(segEdge.every((e) => e >= 0 && e < 12));
  assert.equal(mesh.material.polygonOffset, true);

  const noEdges = meshes(buildSwGroup([m], { edges: false }))[0];
  assert.equal(swMeshData(noEdges)!.edgeLines, undefined);
  assert.equal(noEdges.children.length, 0);
});

test("setEdgesVisible toggles only the edge lines", () => {
  const group = buildSwGroup([analyzedCube(), analyzedCube()]);
  setEdgesVisible(group, false);
  for (const m of meshes(group)) {
    assert.equal(m.visible, true);
    assert.equal(swMeshData(m)!.edgeLines!.visible, false);
  }
  setEdgesVisible(group, true);
  for (const m of meshes(group)) assert.equal(swMeshData(m)!.edgeLines!.visible, true);
});

test("triangleFaces maps every triangle to its face range", () => {
  const m = analyzedCube();
  const tf = triangleFaces(m);
  assert.equal(tf.length, m.indices.length / 3);
  // cube(): six faces of two triangles each, in order.
  assert.deepEqual([...tf], [0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5]);
  assert.deepEqual([...triangleFaces(quad())], [-1, -1]);
  assert.deepEqual([...segmentEdges(quad())], []);
  const data = swMeshData(meshes(buildSwGroup([m]))[0])!;
  assert.deepEqual([...data.triFace], [...tf]);
  assert.equal(data.swIndex, 0);
  assert.equal(data.swMesh, m);
});

test("meshes saved hidden start invisible and carry their componentId", () => {
  const [a, b] = meshes(buildSwGroup([quad({ componentId: "A-1", visible: false }), quad({ componentId: "B-1" })]));
  assert.equal(a.visible, false);
  assert.equal(b.visible, true);
  assert.equal(swMeshData(a)!.componentId, "A-1");
  assert.equal(swMeshData(b)!.componentId, "B-1");
});

test("applyPartColors colours meshes by component and restores the file colours", () => {
  const group = buildSwGroup([
    quad({ componentId: "A-1", color: [1, 0, 0] }),
    quad({ componentId: "B-1", faceRanges: [{ start: 0, count: 3, color: [0, 1, 0] }, { start: 3, count: 3 }] }),
    quad(),
  ]);
  const [a, b, c] = meshes(group);
  applyPartColors(group, new Map([["A-1", [0, 0, 1]], ["B-1", [0, 0, 1]]]));
  assert.equal(a.material.color.getHexString(), "0000ff");
  assert.equal(b.material.vertexColors, false);
  assert.equal(b.material.color.getHexString(), "0000ff");
  assert.equal(c.material.color.getHex(), 0xcccccc);
  applyPartColors(group, null);
  assert.equal(a.material.color.getHex(), 0xff0000);
  assert.equal(b.material.vertexColors, true);
  assert.equal(b.material.color.getHex(), 0xffffff);
});

test("disposeObject also frees line geometries and shared materials once", () => {
  const group = buildSwGroup([analyzedCube(), analyzedCube()]);
  const disposed = new Map<unknown, number>();
  group.traverse((o) => {
    if (o instanceof THREE.Mesh || o instanceof THREE.LineSegments) {
      for (const x of [o.geometry, o.material]) {
        if (!disposed.has(x)) {
          disposed.set(x, 0);
          x.addEventListener("dispose", () => disposed.set(x, disposed.get(x)! + 1));
        }
      }
    }
  });
  disposeObject(group);
  // 2 mesh geometries + 2 mesh materials + 2 line geometries + 1 shared edge material.
  assert.equal(disposed.size, 7);
  for (const n of disposed.values()) assert.equal(n, 1);
});
