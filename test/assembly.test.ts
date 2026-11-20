import assert from "node:assert/strict";
import { it } from "node:test";
import { readAssembly, readAssemblyMeshes } from "../src/assembly.ts";
import { instancePathOf, parseComponentTree } from "../src/assemblyTree.ts";
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

// ---------- component tree (swXmlContents/COMPINSTANCETREE) ----------

const T_IDENTITY = "1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1";
/** Row-vector convention: rows 0-2 rotation, row 3 translation in metres, last value scale. */
const T_ROT_Z_90_AT_X = "0 1 0 0 -1 0 0 0 0 0 1 0 0.1 0 0 1";
const T_AT_Y = "1 0 0 0 0 1 0 0 0 0 1 0 0 0.02 0 1";

const reference = (id: number, name: string, number: number, model: number, transform: string, extra = "") =>
  `<swReference id="${id}" swComponentName="${name}" swReferenceNumber="${number}" swConfigurationName="Default" ` +
  `swSuppressed="NO" swHidden="NO" swModelRef="${model}" swTransform="${transform}" ${extra}/>`;

/** Top: Sub-1 (rotated, hidden) containing plate-1 and plate-2, plate-3, Sub-2 (suppressed), bolt-1 (suppressed). */
const treeXml = (opts: { hiddenSub?: boolean } = {}) => `<?xml version="1.0" encoding="UTF-8"?>
<swSolidWorks xmlns="http://www.solidworks.com/sw2003/schema">
<swHeader>
<swFile id="1" swDocType="ASSEMBLY" swPath="C:\\cad\\Top.SLDASM"/>
<swFile id="2" swDocType="ASSEMBLY" swPath="C:\\cad\\Sub.SLDASM"/>
<swFile id="3" swDocType="PART" swPath="C:\\parts\\plate.SLDPRT"/>
<swFile id="4" swDocType="PART" swPath="C:\\parts\\bolt.SLDPRT"/>
</swHeader>
<swModelList>
<swModel id="13" swFileRef="3"/>
<swModel id="14" swFileRef="4"/>
<swModel id="12" swFileRef="2">
${reference(20, "plate", 1, 13, T_AT_Y)}
${reference(21, "plate", 2, 13, T_IDENTITY)}
</swModel>
<swModel id="11" swFileRef="1">
${reference(22, "Sub", 1, 12, T_ROT_Z_90_AT_X, opts.hiddenSub === false ? "" : 'swHidden="YES"').replace('swHidden="NO" ', "")}
${reference(23, "plate", 3, 13, T_IDENTITY)}
${reference(24, "Sub", 2, 12, T_IDENTITY).replace('swSuppressed="NO"', 'swSuppressed="YES"')}
${reference(25, "bolt", 1, 14, T_IDENTITY).replace('swSuppressed="NO"', 'swSuppressed="YES"')}
</swModel>
</swModelList>
<swConfigurationList><swConfiguration swMostRecentConfiguration="YES" swModelRef="11"/></swConfigurationList>
</swSolidWorks>`;

const near = (actual: number[] | undefined, expected: number[]) => {
  assert.ok(actual);
  assert.equal(actual.length, expected.length);
  actual.forEach((value, i) => assert.ok(Math.abs(value - expected[i]) < 1e-9, `index ${i}: ${value} != ${expected[i]}`));
};

it("parses the component tree with ids, flags and composed transforms", () => {
  const tree = parseComponentTree(new TextEncoder().encode(treeXml()));
  assert.ok(tree);
  assert.deepEqual(tree.warnings, []);
  assert.deepEqual(tree.roots.map((n) => [n.id, n.kind, n.hidden, n.suppressed]), [
    ["Sub-1", "assembly", true, false],
    ["plate-3", "part", false, false],
    ["Sub-2", "assembly", false, true],
    ["bolt-1", "part", false, true],
  ]);
  const [sub, , suppressedSub] = tree.roots;
  assert.equal(sub.path, "C:\\cad\\Sub.SLDASM");
  assert.equal(sub.configuration, "Default");
  // Hidden propagates; a suppressed sub-assembly is not expanded.
  assert.deepEqual(sub.children.map((n) => [n.id, n.name, n.hidden]), [
    ["Sub-1/plate-1", "plate-1", true],
    ["Sub-1/plate-2", "plate-2", true],
  ]);
  assert.deepEqual(suppressedSub.children, []);

  assert.deepEqual(tree.leaves.map((l) => [l.node.id, l.suppressed]), [
    ["Sub-1/plate-1", false], ["Sub-1/plate-2", false], ["plate-3", false], ["bolt-1", true],
  ]);
  assert.equal(tree.leaves[0].partKey, "C:\\parts\\plate.SLDPRT|Default");
  // Sub-1 rotates 90° about z and sits at x = 100 mm; plate-1 sits at y = 20 mm inside it,
  // so it ends up at x = 100 - 20.
  near(tree.leaves[1].matrix, [0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 100, 0, 0, 1]);
  near(tree.leaves[0].matrix, [0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 80, 0, 0, 1]);
  assert.equal(tree.componentKeys.get("Sub|plate-2"), "C:\\parts\\plate.SLDPRT|Default");
  assert.equal(tree.componentKeys.get("Top|bolt-1"), "C:\\parts\\bolt.SLDPRT|Default");
  assert.equal(tree.componentKeys.has("Top|Sub-1"), false);
});

it("never throws on malformed trees", () => {
  assert.equal(parseComponentTree("garbage"), undefined);
  assert.equal(parseComponentTree("<swSolidWorks><swModel"), undefined);
  assert.equal(parseComponentTree(new Uint8Array([0xff, 0xfe, 0x3c, 0x00, 0xd8, 0x00])), undefined);

  const badTransform = parseComponentTree(treeXml().replace(T_AT_Y, "1 2 x"));
  assert.ok(badTransform);
  assert.ok(badTransform.warnings.some((w) => /transform/.test(w)));
  near(badTransform.leaves[0].matrix, badTransform.leaves[1].matrix);

  // Sub references itself: the walk stops instead of recursing forever.
  const cyclic = parseComponentTree(treeXml().replace(reference(21, "plate", 2, 13, T_IDENTITY), reference(21, "Sub", 9, 12, T_IDENTITY)));
  assert.ok(cyclic);
  assert.ok(cyclic.warnings.some((w) => /cyclic/.test(w)));
});

it("maps cache instance names to tree ids, also for files saved as a copy", () => {
  assert.equal(instancePathOf("Sub-1@Top/plate-2@Sub"), "Sub-1/plate-2");
  assert.equal(instancePathOf("plate-1@OldName"), "plate-1");
});

const treeEntry = (xml: string) => ({ "swXmlContents/COMPINSTANCETREE": new TextEncoder().encode(xml) });

it("places tree instances with cached meshes, flags and shared geometry", async () => {
  // Inline caches for plate-3 and Sub-1/plate-1; the cache transforms are deliberately
  // wrong: the tree is the source of placements.
  const stream = Buffer.concat([
    firstComponent, component("plate-3@Top", 5), face,
    nextComponent, component("Sub-1@Top/plate-1@Sub", 5), face,
  ]);
  const result = await readAssembly(container(treeEntry(treeXml())), stream, 6);

  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.components?.map((n) => n.id), ["Sub-1", "plate-3", "Sub-2", "bolt-1"]);
  assert.deepEqual(result.meshes.map((m) => [m.componentId, m.name, m.visible]), [
    ["Sub-1/plate-1", "plate-1", false],
    ["Sub-1/plate-2", "plate-2", false],
    ["plate-3", "plate-3", undefined],
  ]);
  near(result.meshes[0].matrix, [0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 80, 0, 0, 1]);
  near(result.meshes[2].matrix, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  // plate-2 has no own cache and reuses the geometry of the same part.
  assert.equal(result.meshes[1].positions, result.meshes[0].positions);
  assert.equal(result.meshes[1].indices, result.meshes[0].indices);
});

it("resolves directory rows that reuse the geometry of another instance", async () => {
  const signature = u32(0x4462ab09, 0x8307df03);
  const cacheName = "000-000-001";
  const referenceRow = (id: number, instance: string) =>
    Buffer.concat([u32(id), cstring(instance), Buffer.alloc(12), signature, u32(0x11111111, 0x22222222), cstring(""), u32(0xffffffff, 0)]);
  const c = container({
    ...treeEntry(treeXml({ hiddenSub: false })),
    "FaceTessellations/Directory": Buffer.concat([
      u32(2, 1, 3),
      directoryEntry(0, "plate-3@Top", cacheName, signature),
      referenceRow(5, "Sub-1@Top/plate-1@Sub"),
      referenceRow(6, "Sub-1@Top/plate-2@Sub"),
    ]),
    ["FaceTessellations/" + cacheName]: cacheGroup(0, signature, 1),
  });
  const result = await readAssembly(c, undefined, 3);

  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.meshes.map((m) => [m.componentId, m.visible]), [
    ["Sub-1/plate-1", undefined], ["Sub-1/plate-2", undefined], ["plate-3", undefined],
  ]);
  assert.ok(result.meshes.every((m) => m.positions === result.meshes[0].positions));
});

/** Body header of a cache stream: the faces after it belong to body `index`. */
const bodyHeader = (index: number, faces: number) =>
  Buffer.concat([u32(index, 0, 0, faces, 0), u32(1, 1, 0, 0), Buffer.from([0x96, 0, 0x20, 0])]);

const quad = Buffer.concat([
  u32(4, 8, 2, 1, 4),
  u32(12, 100, 2, 4),
  floats([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0], 4),
  u32(12, 100, 2, 4),
  floats([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1], 4),
]);

const twoPartTree = `<swSolidWorks><swHeader>
<swFile id="1" swDocType="ASSEMBLY" swPath="Top.SLDASM"/>
<swFile id="2" swDocType="PART" swPath="a.SLDPRT"/>
<swFile id="3" swDocType="PART" swPath="b.SLDPRT"/>
</swHeader><swModelList>
<swModel id="12" swFileRef="2"/><swModel id="13" swFileRef="3"/>
<swModel id="11" swFileRef="1">
${reference(20, "b", 1, 13, T_IDENTITY)}
${reference(21, "a", 1, 12, T_AT_Y)}
${reference(22, "a", 2, 12, T_IDENTITY, 'swHidden="YES"').replace('swHidden="NO" ', "")}
</swModel></swModelList></swSolidWorks>`;

it("falls back to body headers and the directory order when the directory rows do not parse", async () => {
  const stream = Buffer.concat([face, bodyHeader(1, 1), quad]);
  // Version 3 is unknown to the row reader; the instance names and stream names still give the order.
  const directory = Buffer.concat([u32(3, 1, 2), u32(1), cstring("a-1@OldTop"), cstring("000-000-001"), u32(2), cstring("b-1@OldTop"), cstring("000-000-001")]);
  const c = container({
    ...treeEntry(twoPartTree),
    "FaceTessellations/Directory": directory,
    "FaceTessellations/000-000-001": stream,
  });
  const result = await readAssembly(c, undefined, 7);

  assert.deepEqual(result.meshes.map((m) => [m.componentId, m.positions.length / 3, m.visible]), [
    ["b-1", 4, undefined], ["a-1", 3, undefined], ["a-2", 3, false],
  ]);
  assert.equal(result.meshes[1].positions, result.meshes[2].positions);
  assert.equal(result.meshes[1].matrix?.[13], 20);
  assert.ok(result.warnings.some((w) => /directory order/.test(w)));

  // Without a directory, bodies follow the order in which parts first appear in the tree.
  const swapped = Buffer.concat([quad, bodyHeader(1, 1), face]);
  const noDirectory = await readAssembly(container({ ...treeEntry(twoPartTree), "FaceTessellations/000-000-001": swapped }), undefined, 7);
  assert.deepEqual(noDirectory.meshes.map((m) => [m.componentId, m.positions.length / 3]), [["b-1", 4], ["a-1", 3], ["a-2", 3]]);

  await assert.rejects(readAssembly(c, undefined, 6), /too large/i);
});

it("does not guess when a cache stream has no body headers", async () => {
  const c = container({ ...treeEntry(twoPartTree), "FaceTessellations/000-000-001": Buffer.concat([face, quad]) });
  const result = await readAssembly(c, undefined, 7);
  assert.deepEqual(result.meshes, []);
  assert.equal(result.components?.length, 3);
  assert.ok(result.warnings.some((w) => /unavailable for 3 of 3/.test(w)));
});

it("keeps the cache placements when the tree is unreadable or matches nothing", async () => {
  const stream = Buffer.concat([firstComponent, component("plate-1@Asm", 0.125), face]);
  const garbage = await readAssembly(container(treeEntry("not xml")), stream, 3);
  assert.deepEqual(garbage.meshes.map((m) => m.name), ["plate-1@Asm"]);
  assert.equal(garbage.components, undefined);
  assert.ok(garbage.warnings.some((w) => /tree could not be read/.test(w)));

  const unmatched = await readAssembly(container(treeEntry(twoPartTree)), stream, 3);
  assert.deepEqual(unmatched.meshes.map((m) => m.name), ["plate-1@Asm"]);
  assert.equal(unmatched.components?.length, 3);
  assert.ok(unmatched.warnings.some((w) => /without the component tree/.test(w)));

  assert.deepEqual(await readAssembly(container(), undefined, 3), { meshes: [], warnings: [] });
});

it("suffixes same-named siblings in order and handles many of them quickly", () => {
  const tree = (refs: string) => `<swSolidWorks><swHeader><swFile id="1" swDocType="ASSEMBLY" swPath="Top.SLDASM"/>
<swFile id="2" swDocType="PART" swPath="a.SLDPRT"/></swHeader><swModelList><swModel id="12" swFileRef="2"/>
<swModel id="11" swFileRef="1">${refs}</swModel></swModelList></swSolidWorks>`;
  const r = (name: string) => `<swReference swComponentName="${name}" swModelRef="12" swTransform="${T_IDENTITY}"/>`;
  // A literal "a#3" takes that id first; the suffix counter skips it.
  const small = parseComponentTree(tree([r("a"), r("a"), r("a#3"), r("a"), r("b"), r("a")].join("")))!;
  assert.deepEqual(small.roots.map((n) => n.id), ["a", "a#2", "a#3", "a#4", "b", "a#5"]);

  const t0 = performance.now();
  const big = parseComponentTree(tree(r("a").repeat(20_000)))!;
  assert.ok(performance.now() - t0 < 1000, "took too long");
  assert.equal(big.roots.length, 20_000);
  assert.equal(new Set(big.roots.map((n) => n.id)).size, 20_000);
  assert.equal(big.roots.at(-1)!.id, "a#20000");
});
