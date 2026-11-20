// Synthetic meshes for tests: a cube and a faceted cylinder (shaft or hole), laid out
// like buildBodyMesh output (own vertices per face, one face range per face).

import type { SwMesh, Vec3 } from "../src/types.ts";

export interface RawFace {
  pts: Vec3[];
  nrm: Vec3[];
  tris: [number, number, number][];
}

export const meshOf = (faces: RawFace[]): SwMesh => {
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
export const cube = (size = 100): SwMesh => {
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
export const cylinder = (r = 10, hgt = 40, n = 32, hole = false): SwMesh => {
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
