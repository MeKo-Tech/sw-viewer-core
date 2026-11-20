import assert from "node:assert/strict";
import { it } from "node:test";
import { readAssemblyMeshes } from "../src/assembly.ts";
import type { SwContainer, SwEntry } from "../src/container.ts";

const u16 = (value: number) => {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(value);
  return b;
};

const u32 = (...values: number[]) => {
  const b = Buffer.alloc(4 * values.length);
  values.forEach((n, i) => b.writeUInt32LE(n, 4 * i));
  return b;
};

const floats = (values: number[], bytes: 4 | 8) => {
  const b = Buffer.alloc(bytes * values.length);
  values.forEach((n, i) => {
    if (bytes === 4) b.writeFloatLE(n, bytes * i);
    else b.writeDoubleLE(n, bytes * i);
  });
  return b;
};

const cstring = (value: string) =>
  Buffer.concat([
    Buffer.from([255, 254, 255]),
    value.length < 255 ? Buffer.from([value.length]) : Buffer.concat([Buffer.from([255]), u16(value.length)]),
    Buffer.from(value, "utf16le"),
  ]);

const className = "uoTempAssemblySHDData_c";
const firstComponent = Buffer.concat([u16(0xffff), u16(1), u16(className.length), Buffer.from(className)]);
const nextComponent = u16(0x8038);

const component = (
  name: string,
  x: number,
  path = "C:\\parts\\plate.SLDPRT",
  rotation: number[] = [],
  transformKind = 0
) =>
  Buffer.concat([
    cstring(name),
    Buffer.from([rotation.length ? 1 : 0]),
    floats([...rotation, x, 0, 0, 1], 8),
    Buffer.from([transformKind]),
    Buffer.alloc(82), // bounding box and flags
    cstring("Default"),
    Buffer.alloc(12),
    cstring("plate"),
    cstring(path),
  ]);

const faceTable = (vertices: number) => Buffer.concat([
  u32(4, 8, 2, 1, vertices),
  u32(12, 100, 2, vertices),
  floats([0, 0, 0, 1, 0, 0, 0, 1, 0].slice(0, vertices * 3), 4),
  u32(12, 100, 2, vertices),
  floats([0, 0, 1, 0, 0, 1, 0, 0, 1].slice(0, vertices * 3), 4),
]);

const face = faceTable(3);

const container = (streams: Record<string, Uint8Array> = {}): SwContainer => {
  const entries: SwEntry[] = Object.entries(streams).map(([name, bytes]) => ({
    name,
    size: bytes.length,
    compressedSize: bytes.length,
    read: async () => bytes,
  }));
  return { kind: "zip", entries, find: (name) => entries.find((e) => e.name === name) };
};

const directoryEntry = (id: number, instance: string, stream: string, signature: Buffer) =>
  Buffer.concat([u32(id + 1), cstring(instance), Buffer.alloc(20), signature, cstring(stream), u32(id, 1, 100, 80, 6)]);

const cacheGroup = (id: number, signature: Buffer, faceCount: number, data = face) =>
  Buffer.concat([u32(id), signature, u32(faceCount), Buffer.alloc(40), data]);

it("places inline meshes per component and shares geometry with a repeated instance", async () => {
  const name = "sub-1@Top/plate-1@Sub";
  const repeat = "sub-1@Top/plate-2@Sub";
  const stream = Buffer.concat([
    firstComponent, component(name, 0.125), face,
    nextComponent, component(repeat, 0.25, undefined, [0, 1, 0, -1, 0, 0, 0, 0, 1]),
  ]);

  const { meshes, warnings } = await readAssemblyMeshes(container(), stream, 3);

  assert.deepEqual(meshes.map((mesh) => mesh.name), [name, repeat]);
  assert.deepEqual(meshes[0].matrix, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 125, 0, 0, 1]);
  assert.deepEqual(meshes[1].matrix, [0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 250, 0, 0, 1]);
  assert.deepEqual([...meshes[1].positions], [0, 0, 0, 1000, 0, 0, 0, 1000, 0]);
  assert.equal(meshes[0].positions, meshes[1].positions);
  assert.equal(meshes[0].indices, meshes[1].indices);
  assert.deepEqual(warnings, []);
});

it("does not assign a repeated instance an ambiguous inline mesh", async () => {
  const stream = Buffer.concat([
    firstComponent, component("plate-1@Asm", 0), face,
    nextComponent, component("plate-2@Asm", 0.25), face,
    nextComponent, component("plate-3@Asm", 0.5),
  ]);

  const { meshes, warnings } = await readAssemblyMeshes(container(), stream, 6);

  assert.deepEqual(meshes.map((mesh) => mesh.name), ["plate-1@Asm", "plate-2@Asm"]);
  assert.ok(warnings.length > 0);
});

it("pairs separate cache groups with their directory entries and validates the face count", async () => {
  const alpha = "plate-1@Asm";
  const beta = "other-1@Asm";
  const stream = Buffer.concat([
    firstComponent, component(alpha, 0.0625),
    nextComponent, component(beta, 0.25, "C:\\parts\\" + "a".repeat(255) + ".SLDPRT"),
  ]);
  const signature = u32(0x4462ab09, 0x8307df03);
  const otherSignature = u32(0x19f967e7, 0x16151434);
  const cacheName = "000-000-005";
  const c = container({
    "FaceTessellations/Directory": Buffer.concat([
      u32(2, 5, 2),
      directoryEntry(0, alpha, cacheName, signature),
      directoryEntry(1, beta, cacheName, otherSignature),
    ]),
    ["FaceTessellations/" + cacheName]: Buffer.concat([
      cacheGroup(1, otherSignature, 1),
      cacheGroup(0, signature, 2), // only one face is available for alpha
    ]),
  });

  const { meshes, warnings } = await readAssemblyMeshes(c, stream, 6);

  assert.deepEqual(meshes.map((mesh) => mesh.name), [beta]);
  assert.equal(meshes[0].matrix?.[12], 250);
  assert.ok(warnings.length > 0);
  await assert.rejects(readAssemblyMeshes(c, stream, 5), /too large/i);
});

it("leaves geometry without a validated component unrendered", async () => {
  const result = await readAssemblyMeshes(container(), face, 3);

  assert.deepEqual(result.meshes, []);
  assert.ok(result.warnings.length > 0);
});

it("keeps the face ranges of surrounding instances when a transform is unsupported", async () => {
  const stream = Buffer.concat([
    firstComponent, component("plate-1@Asm", 0), face,
    nextComponent, component("plate-2@Asm", 0.25, undefined, [], 1), face,
    nextComponent, component("plate-3@Asm", 0.5), face,
  ]);

  const { meshes, warnings } = await readAssemblyMeshes(container(), stream, 9);

  assert.deepEqual(meshes.map((mesh) => mesh.name), ["plate-1@Asm", "plate-3@Asm"]);
  assert.deepEqual(meshes.map((mesh) => mesh.indices.length), [3, 3]);
  assert.ok(warnings.length > 0);
});

it("leaves assembly previews empty when cached faces contain no triangles", async () => {
  const instance = "plate-1@Asm";
  const placement = Buffer.concat([firstComponent, component(instance, 0)]);
  const shortFace = faceTable(2);
  const inlineResult = await readAssemblyMeshes(container(), Buffer.concat([placement, shortFace]), 2);
  assert.deepEqual(inlineResult.meshes, []);
  assert.ok(inlineResult.warnings.length > 0);

  const signature = u32(0x4462ab09, 0x8307df03);
  const cacheName = "000-000-005";
  const c = container({
    "FaceTessellations/Directory": Buffer.concat([u32(2, 5, 1), directoryEntry(0, instance, cacheName, signature)]),
    ["FaceTessellations/" + cacheName]: cacheGroup(0, signature, 1, shortFace),
  });
  const separateResult = await readAssemblyMeshes(c, placement, 2);
  assert.deepEqual(separateResult.meshes, []);
  assert.ok(separateResult.warnings.length > 0);
});

it("stops an oversized face group at a cache with an ambiguous signature", async () => {
  const alpha = "plate-1@Asm";
  const beta = "other-1@Asm";
  const stream = Buffer.concat([
    firstComponent, component(alpha, 0),
    nextComponent, component(beta, 0, "C:\\parts\\other.SLDPRT"),
  ]);
  const signature = u32(0x4462ab09, 0x8307df03);
  const repeatedSignature = u32(0x19f967e7, 0x16151434);
  const cacheName = "000-000-005";
  const c = container({
    "FaceTessellations/Directory": Buffer.concat([
      u32(2, 5, 2),
      directoryEntry(0, alpha, cacheName, signature),
      directoryEntry(1, beta, cacheName, repeatedSignature),
    ]),
    ["FaceTessellations/" + cacheName]: Buffer.concat([
      cacheGroup(0, signature, 2),
      cacheGroup(1, repeatedSignature, 1),
      cacheGroup(1, repeatedSignature, 1),
    ]),
  });

  const { meshes, warnings } = await readAssemblyMeshes(c, stream, 9);

  assert.deepEqual(meshes, []);
  assert.ok(warnings.length > 0);
});
