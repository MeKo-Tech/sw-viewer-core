// Decoder for the tessellated display mesh in the "Contents/DisplayLists" entry.
// Layout: docs/format.md. Derived from hex inspection of sample files; validated by
// comparing the enclosed mesh volume with the volume SolidWorks reports.

import type { SwMesh } from "./types.ts";

/** Channel header: item size, kind, flags, item count (all u32 LE). */
const KIND_INT = 8;
const KIND_FLOAT = 100;
const FLAGS = 2;
/** SolidWorks stores metres; the viewers (and STEP) work in millimetres. */
const M_TO_MM = 1000;

export interface FaceTess {
  /** Byte offset of the face table in the stream (diagnostics). */
  offset: number;
  stripLengths: Uint32Array;
  positions: Float32Array;
  normals: Float32Array;
}

const isChannel = (
  v: DataView,
  at: number,
  itemSize: number,
  kind: number,
  count?: number
) =>
  at + 16 <= v.byteLength &&
  v.getUint32(at, true) === itemSize &&
  v.getUint32(at + 4, true) === kind &&
  v.getUint32(at + 8, true) === FLAGS &&
  (count === undefined || v.getUint32(at + 12, true) === count);

const readFloats = (v: DataView, at: number, n: number) => {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = v.getFloat32(at + 4 * i, true);
  }
  return out;
};

/**
 * Finds every face table: a strip-length channel (u32) immediately followed by a
 * position and a normal channel (float32×3) whose vertex count equals the sum of
 * the strip lengths. Scanning for this signature is robust against the surrounding
 * MFC records, which we don't need to understand to draw the part.
 */
export const scanFaceTables = (stream: Uint8Array): FaceTess[] => {
  const v = new DataView(stream.buffer, stream.byteOffset, stream.byteLength);
  const faces: FaceTess[] = [];
  const end = stream.byteLength - 16;
  let o = 0;
  while (o <= end) {
    // Cheap first-byte test before the full header check.
    if (stream[o] !== 4 || !isChannel(v, o, 4, KIND_INT)) {
      o++;
      continue;
    }
    const k = v.getUint32(o + 12, true);
    const posAt = o + 16 + 4 * k;
    if (k === 0 || k > 1_000_000 || posAt + 16 > stream.byteLength) {
      o++;
      continue;
    }
    let n = 0;
    const stripLengths = new Uint32Array(k);
    for (let i = 0; i < k; i++) {
      stripLengths[i] = v.getUint32(o + 16 + 4 * i, true);
      n += stripLengths[i];
    }
    const norAt = posAt + 16 + 12 * n;
    if (
      n > 0 &&
      isChannel(v, posAt, 12, KIND_FLOAT, n) &&
      norAt + 16 + 12 * n <= stream.byteLength &&
      isChannel(v, norAt, 12, KIND_FLOAT, n)
    ) {
      faces.push({
        offset: o,
        stripLengths,
        positions: readFloats(v, posAt + 16, 3 * n),
        normals: readFloats(v, norAt + 16, 3 * n),
      });
      o = norAt + 16 + 12 * n;
      continue;
    }
    o++;
  }
  return faces;
};

/** Triangle strips → triangle list. Every second triangle flips its winding. */
const stripIndices = (strips: Uint32Array, base: number, out: number[]) => {
  let b = base;
  for (const len of strips) {
    for (let i = 0; i + 2 < len; i++) {
      if (i % 2 === 0) {
        out.push(b + i, b + i + 1, b + i + 2);
      } else {
        out.push(b + i + 1, b + i, b + i + 2);
      }
    }
    b += len;
  }
};

/**
 * All faces merged into one mesh in millimetres. `faceRanges` keeps the index
 * range of every face so a viewer can pick or highlight single faces later.
 */
export const buildBodyMesh = (faces: FaceTess[]): SwMesh | null => {
  const vertexCount = faces.reduce((s, f) => s + f.positions.length / 3, 0);
  if (vertexCount === 0) {
    return null;
  }
  const positions = new Float32Array(3 * vertexCount);
  const normals = new Float32Array(3 * vertexCount);
  const indices: number[] = [];
  const faceRanges: SwMesh["faceRanges"] = [];
  let base = 0;
  for (const f of faces) {
    for (let i = 0; i < f.positions.length; i++) {
      positions[3 * base + i] = f.positions[i] * M_TO_MM;
    }
    normals.set(f.normals, 3 * base);
    const start = indices.length;
    stripIndices(f.stripLengths, base, indices);
    faceRanges.push({ start, count: indices.length - start });
    base += f.positions.length / 3;
  }
  return {
    positions,
    normals,
    indices: Uint32Array.from(indices),
    faceRanges,
  };
};

/** Signed volume of a closed, outward-wound mesh (mm³ for a mesh in mm). */
export const signedVolume = (m: Pick<SwMesh, "positions" | "indices">) => {
  const p = m.positions;
  let v = 0;
  for (let t = 0; t < m.indices.length; t += 3) {
    const a = 3 * m.indices[t];
    const b = 3 * m.indices[t + 1];
    const c = 3 * m.indices[t + 2];
    v +=
      p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) -
      p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) +
      p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c]);
  }
  return v / 6;
};
