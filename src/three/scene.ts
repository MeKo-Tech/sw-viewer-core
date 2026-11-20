// Framework-free three.js helpers that turn a parse result into a scene graph. The setup
// mirrors moin-bridge's StepViewer/stepScene so both viewers look the same.

import * as THREE from "three";
import type { Rgb, SwMesh } from "../types.ts";

const DEFAULT_COLOR = 0xcccccc;
/** Colour of the model edges. */
export const EDGE_COLOR = 0x1b2430;

export interface SwGroupOptions {
  /** Add the model edges (`SwMesh.edges`) as dark lines (default true). */
  edges?: boolean;
}

/** What `buildSwGroup` stores in `userData` of each mesh. */
export interface SwMeshUserData {
  /** Index of the source mesh in the `meshes` argument. */
  swIndex: number;
  swMesh: SwMesh;
  componentId?: string;
  /** Face index (into `faceRanges`) per triangle; -1 outside every range. */
  triFace: Int32Array;
  /** The edge lines child, if any. */
  edgeLines?: THREE.LineSegments;
}

/** What `buildSwGroup` stores in `userData` of each edge line object. */
export interface SwEdgeUserData {
  swEdges: true;
  /** Edge index (into `edgeRanges`) per line segment. */
  segEdge: Int32Array;
}

/** Face index per triangle, from the face ranges (all -1 without ranges). */
export const triangleFaces = (m: Pick<SwMesh, "indices" | "faceRanges">): Int32Array => {
  const out = new Int32Array(Math.floor(m.indices.length / 3)).fill(-1);
  m.faceRanges?.forEach(({ start, count }, face) => {
    for (let t = Math.floor(start / 3); t < Math.floor((start + count) / 3); t++) out[t] = face;
  });
  return out;
};

/** Edge index per segment of `mesh.edges`, from the edge ranges. */
export const segmentEdges = (m: Pick<SwMesh, "edges" | "edgeRanges">): Int32Array => {
  const out = new Int32Array(m.edges ? m.edges.length / 6 : 0).fill(-1);
  m.edgeRanges?.forEach(({ start, count }, edge) => out.fill(edge, start, start + count));
  return out;
};

/** The SwMesh user data of a mesh built by `buildSwGroup`, or undefined. */
export const swMeshData = (o: THREE.Object3D): SwMeshUserData | undefined =>
  (o.userData as Partial<SwMeshUserData>).swMesh ? (o.userData as SwMeshUserData) : undefined;

/**
 * Lookup keyed by a tuple of identities (typed arrays, range arrays, strings): assembly
 * instances share the typed arrays of their part, so everything derived from those
 * arrays alone is built once per part instead of once per instance.
 */
class TupleCache<T> {
  private readonly root = new Map<unknown, unknown>();
  get(keys: readonly unknown[], build: () => T): T {
    let level = this.root;
    for (let i = 0; i < keys.length - 1; i++) {
      let next = level.get(keys[i]) as Map<unknown, unknown> | undefined;
      if (!next) level.set(keys[i], (next = new Map()));
      level = next;
    }
    const last = keys[keys.length - 1];
    if (level.has(last)) return level.get(last) as T;
    const value = build();
    level.set(last, value);
    return value;
  }
}

const buildGeometry = (m: SwMesh, baseColor: THREE.Color, vertexColors: boolean) => {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(m.positions, 3));
  // The index must be set first: computeVertexNormals walks it for indexed geometry.
  g.setIndex(new THREE.BufferAttribute(m.indices, 1));
  if (m.normals) {
    g.setAttribute("normal", new THREE.BufferAttribute(m.normals, 3));
  } else {
    g.computeVertexNormals();
  }
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
  return g;
};

/**
 * Builds one three.js mesh per SwMesh. Face-range colors become vertex colors. Each
 * mesh carries its model edges as a `LineSegments` child, starts invisible when the
 * SwMesh says `visible: false`, and keeps its source data in `userData` (`SwMeshUserData`).
 *
 * Instances that share their typed arrays (assembly instances of one part) also share
 * the `BufferGeometry` of the faces and of the edges and the `triFace`/`segEdge`
 * lookups; each mesh keeps its own material, so colours, highlights and clipping stay
 * per instance. `disposeObject` frees shared geometries once; don't dispose a single
 * mesh's geometry while other meshes of the group are still in use.
 */
export const buildSwGroup = (meshes: SwMesh[], options: SwGroupOptions = {}): THREE.Group => {
  const group = new THREE.Group();
  const edgeMaterial = new THREE.LineBasicMaterial({ color: EDGE_COLOR });
  let edgeMaterialUsed = false;
  const geometries = new TupleCache<THREE.BufferGeometry>();
  const triFaces = new TupleCache<Int32Array>();
  const edgeGeometries = new TupleCache<{ geometry: THREE.BufferGeometry; segEdge: Int32Array }>();
  meshes.forEach((m, swIndex) => {
    const baseColor = m.color ? new THREE.Color(...m.color) : new THREE.Color(DEFAULT_COLOR);
    const vertexColors = m.faceRanges?.some((range) => range.color) ?? false;
    // The colour attribute bakes in the base colour; without it the colour lives in the material.
    const colorKey = vertexColors ? `${baseColor.r},${baseColor.g},${baseColor.b}` : "";
    const g = geometries.get([m.positions, m.indices, m.normals, vertexColors ? m.faceRanges : undefined, colorKey], () =>
      buildGeometry(m, baseColor, vertexColors),
    );
    const material = new THREE.MeshPhongMaterial({
      color: vertexColors ? 0xffffff : baseColor,
      vertexColors,
      specular: 0,
      side: THREE.DoubleSide,
      // Pushes the faces back a little, so the edge lines on top don't z-fight.
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
    });
    const mesh = new THREE.Mesh(g, material);
    if (m.name) mesh.name = m.name;
    if (m.matrix) {
      mesh.matrixAutoUpdate = false;
      mesh.matrix.fromArray(m.matrix);
      mesh.matrixWorldNeedsUpdate = true;
    }
    if (m.visible === false) mesh.visible = false;
    const triFace = triFaces.get([m.indices, m.faceRanges], () => triangleFaces(m));
    const data: SwMeshUserData = { swIndex, swMesh: m, triFace };
    if (m.componentId !== undefined) data.componentId = m.componentId;
    const edges = m.edges;
    if ((options.edges ?? true) && edges?.length) {
      const shared = edgeGeometries.get([edges, m.edgeRanges], () => {
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute("position", new THREE.BufferAttribute(edges, 3));
        return { geometry, segEdge: segmentEdges(m) };
      });
      const lines = new THREE.LineSegments(shared.geometry, edgeMaterial);
      edgeMaterialUsed = true;
      lines.name = "edges";
      const edgeData: SwEdgeUserData = { swEdges: true, segEdge: shared.segEdge };
      lines.userData = edgeData;
      mesh.add(lines);
      data.edgeLines = lines;
    }
    mesh.userData = data;
    group.add(mesh);
  });
  if (!edgeMaterialUsed) edgeMaterial.dispose();
  return group;
};

/** Shows or hides the edge lines below `obj`. */
export const setEdgesVisible = (obj: THREE.Object3D, visible: boolean) => {
  obj.traverse((o) => {
    if ((o.userData as Partial<SwEdgeUserData>).swEdges) o.visible = visible;
  });
};

/**
 * Colours whole meshes by component id (`colors`, e.g. from `partColors`), or restores
 * the file colours for null. Meshes without an entry keep their file colours.
 */
export const applyPartColors = (group: THREE.Object3D, colors: ReadonlyMap<string, Rgb> | null) => {
  for (const o of group.children) {
    const data = swMeshData(o);
    if (!data || !(o instanceof THREE.Mesh)) continue;
    const mat = o.material as THREE.MeshPhongMaterial;
    const ud = mat.userData as { fileColor?: THREE.Color; fileVertexColors?: boolean };
    ud.fileColor ??= mat.color.clone();
    ud.fileVertexColors ??= mat.vertexColors;
    const c = data.componentId !== undefined ? colors?.get(data.componentId) : undefined;
    const vertexColors = c ? false : ud.fileVertexColors;
    if (c) mat.color.setRGB(c[0], c[1], c[2], THREE.SRGBColorSpace);
    else mat.color.copy(ud.fileColor);
    if (mat.vertexColors !== vertexColors) {
      mat.vertexColors = vertexColors;
      mat.needsUpdate = true;
    }
  }
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

/** Frees the geometries and materials below `obj` (meshes, lines and points). */
export const disposeObject = (obj: THREE.Object3D) => {
  const seen = new Set<{ dispose(): void }>();
  const free = (x: { dispose(): void }) => {
    if (seen.has(x)) return;
    seen.add(x);
    x.dispose();
  };
  obj.traverse((o) => {
    if (o instanceof THREE.Mesh || o instanceof THREE.Line || o instanceof THREE.Points) {
      free(o.geometry);
      const materials: THREE.Material[] = Array.isArray(o.material) ? o.material : [o.material];
      for (const mat of materials) {
        free(mat);
        if ("map" in mat && mat.map instanceof THREE.Texture) free(mat.map);
      }
    }
  });
};
