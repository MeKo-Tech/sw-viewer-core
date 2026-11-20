// Framework-free three.js helpers that turn a parse result into a scene graph. The setup
// mirrors moin-bridge's StepViewer/stepScene so both viewers look the same.

import * as THREE from "three";
import type { SwMesh } from "../types.ts";

const DEFAULT_COLOR = 0xcccccc;

/** Builds one three.js mesh per SwMesh. Face-range colors become vertex colors. */
export const buildSwGroup = (meshes: SwMesh[]): THREE.Group => {
  const group = new THREE.Group();
  for (const m of meshes) {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(m.positions, 3));
    // The index must be set first: computeVertexNormals walks it for indexed geometry.
    g.setIndex(new THREE.BufferAttribute(m.indices, 1));
    if (m.normals) {
      g.setAttribute("normal", new THREE.BufferAttribute(m.normals, 3));
    } else {
      g.computeVertexNormals();
    }
    const baseColor = m.color ? new THREE.Color(...m.color) : new THREE.Color(DEFAULT_COLOR);
    const vertexColors = m.faceRanges?.some((range) => range.color) ?? false;
    if (vertexColors && m.faceRanges) {
      const colors = new Float32Array(m.positions.length);
      for (let i = 0; i < colors.length; i += 3) {
        colors[i] = baseColor.r;
        colors[i + 1] = baseColor.g;
        colors[i + 2] = baseColor.b;
      }
      for (const { start, count, color } of m.faceRanges) {
        if (!color) continue;
        for (let i = start; i < start + count; i++) {
          colors.set(color, 3 * m.indices[i]);
        }
      }
      g.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    }
    const material = new THREE.MeshPhongMaterial({
      color: vertexColors ? 0xffffff : baseColor,
      vertexColors,
      specular: 0,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(g, material);
    if (m.name) mesh.name = m.name;
    if (m.matrix) {
      mesh.matrixAutoUpdate = false;
      mesh.matrix.fromArray(m.matrix);
      mesh.matrixWorldNeedsUpdate = true;
    }
    group.add(mesh);
  }
  return group;
};

/** Minimal controls shape, so callers can pass OrbitControls or anything similar. */
export interface CameraTarget {
  target: THREE.Vector3;
  update(): unknown;
}

/** Points `camera` at `obj` from an isometric direction and sizes near/far to it. */
export const fitCamera = (camera: THREE.PerspectiveCamera, obj: THREE.Object3D, controls?: CameraTarget) => {
  obj.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(obj);
  const center = box.getCenter(new THREE.Vector3());
  const maxDim = Math.max(...box.getSize(new THREE.Vector3()).toArray()) || 1;
  camera.near = maxDim * 0.01;
  camera.far = maxDim * 100;
  const d = maxDim * 1.5;
  camera.position.set(center.x + d, center.y + d, center.z + d);
  camera.lookAt(center);
  camera.updateProjectionMatrix();
  if (controls) {
    controls.target.copy(center);
    controls.update();
  }
};

/** Frees the geometries and materials below `obj`. */
export const disposeObject = (obj: THREE.Object3D) => {
  obj.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      o.geometry.dispose();
      const materials: THREE.Material[] = Array.isArray(o.material) ? o.material : [o.material];
      for (const mat of materials) mat.dispose();
    }
  });
};
