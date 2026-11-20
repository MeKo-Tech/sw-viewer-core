// Face-table scanner against small synthetic streams, built here so the tests need
// no sample parts.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { scanFaceTables } from "../src/displayMesh.ts";

/** One face table: a strip-length channel (u32) followed by a position and a
 *  normal channel (float32×3), each with the 16-byte header the scanner expects. */
const faceTable = (stripLengths: number[]) => {
  const n = stripLengths.reduce((s, x) => s + x, 0);
  const d = new Uint8Array(16 + 4 * stripLengths.length + 2 * (16 + 12 * n));
  const v = new DataView(d.buffer);
  const header = (at: number, itemSize: number, kind: number, count: number) => {
    v.setUint32(at, itemSize, true);
    v.setUint32(at + 4, kind, true);
    v.setUint32(at + 8, 2, true);
    v.setUint32(at + 12, count, true);
  };
  header(0, 4, 8, stripLengths.length);
  stripLengths.forEach((len, i) => v.setUint32(16 + 4 * i, len, true));
  const posAt = 16 + 4 * stripLengths.length;
  header(posAt, 12, 100, n);
  for (let i = 0; i < 3 * n; i++) {
    v.setFloat32(posAt + 16 + 4 * i, i, true);
  }
  header(posAt + 16 + 12 * n, 12, 100, n);
  return d;
};

const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

describe("scanFaceTables", () => {
  it("finds every face table in the stream", () => {
    const stream = concat(new Uint8Array(5), faceTable([3]), faceTable([4]));

    const faces = scanFaceTables(stream);

    assert.equal(faces.length, 2);
    assert.equal(faces[0]?.positions.length, 9);
    assert.deepEqual([...(faces[1]?.stripLengths ?? [])], [4]);
  });

  it("accepts faces up to the vertex cap", () => {
    const stream = concat(faceTable([3]), faceTable([3]));

    assert.equal(scanFaceTables(stream, 6).length, 2);
  });

  it("throws once the faces together exceed the vertex cap", () => {
    // Each face stays under the cap; only the running total crosses it.
    const stream = concat(faceTable([3]), faceTable([3]));

    assert.throws(() => scanFaceTables(stream, 5), /display mesh too large/);
  });
});
