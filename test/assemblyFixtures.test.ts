// Assemblies from the CAD-Viewer-Projekt test data (SW_VIEWER_FIXTURES, see fixtures.ts).
// Reference boxes are the root model's swBoundingBox stored in COMPINSTANCETREE, which
// SolidWorks computes from the exact geometry.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readAssembly } from "../src/assembly.ts";
import { openSwContainer, type SwContainer, type SwEntry } from "../src/container.ts";
import { MAX_VERTICES } from "../src/displayMesh.ts";
import { parseSwFile } from "../src/parse.ts";
import type { SwComponentNode, SwMesh } from "../src/types.ts";
import { findAll, parseXml } from "../src/xml.ts";
import { readFixture, skipUnless } from "./fixtures.ts";

const worldBox = (meshes: SwMesh[]) => {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const m of meshes) {
    const M = m.matrix ?? [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const p = m.positions;
    for (let i = 0; i < p.length; i += 3) {
      for (let j = 0; j < 3; j++) {
        const v = M[j] * p[i] + M[4 + j] * p[i + 1] + M[8 + j] * p[i + 2] + M[12 + j];
        min[j] = Math.min(min[j], v);
        max[j] = Math.max(max[j], v);
      }
    }
  }
  return { min, max };
};

/** swBoundingBox of the root assembly model in mm: min xyz, max xyz. */
const storedBox = async (c: SwContainer) => {
  const root = parseXml(await c.find("swXmlContents/COMPINSTANCETREE")!.read())!;
  const rootFile = findAll(root, "swFile")[0].attributes.id;
  const model = findAll(root, "swModel").find((m) => m.attributes.swFileRef === rootFile && m.attributes.swBoundingBox)!;
  const b = model.attributes.swBoundingBox.trim().split(/\s+/).map((v) => Number(v) * 1000);
  return { min: b.slice(0, 3), max: b.slice(3, 6) };
};

const assertBox = (actual: { min: number[]; max: number[] }, expected: { min: number[]; max: number[] }, tolerance: number) => {
  for (let j = 0; j < 3; j++) {
    assert.ok(Math.abs(actual.min[j] - expected.min[j]) <= tolerance, `min[${j}] ${actual.min[j]} vs ${expected.min[j]}`);
    assert.ok(Math.abs(actual.max[j] - expected.max[j]) <= tolerance, `max[${j}] ${actual.max[j]} vs ${expected.max[j]}`);
  }
};

const walk = (nodes: SwComponentNode[]): SwComponentNode[] => nodes.flatMap((n) => [n, ...walk(n.children)]);

/** A container whose entries can be replaced or removed. */
const patched = (c: SwContainer, replace: Record<string, Uint8Array | null>): SwContainer => {
  const entries: SwEntry[] = c.entries
    .filter((e) => replace[e.name] !== null)
    .map((e) => {
      const bytes = replace[e.name];
      return bytes ? { ...e, size: bytes.length, read: async () => bytes } : e;
    });
  return { kind: c.kind, entries, find: (name) => entries.find((e) => e.name === name) };
};

const open = (name: string) => openSwContainer(readFixture(name));
const displayLists = async (c: SwContainer) => c.find("Contents/DisplayLists")?.read();

/** Tessellation cuts curved faces short: the Ø50 cylinders lose up to 0.18 mm per side. */
const CURVED_TOLERANCE = 0.5;

describe("assembly fixtures", () => {
  it("Baugr1: five parts, box as SolidWorks reports it", { skip: skipUnless("Baugr1.sldasm") }, async () => {
    const bytes = readFixture("Baugr1.sldasm");
    const r = await parseSwFile(bytes);
    assert.deepEqual(r.warnings, []);
    assert.equal(r.meshes.length, 5);
    assert.equal(r.components?.length, 5);
    assert.ok(r.components!.every((n) => n.kind === "part" && !n.hidden && !n.suppressed));
    assert.deepEqual(r.meshes.map((m) => m.componentId), r.components!.map((n) => n.id));
    assert.ok(r.meshes.every((m) => m.visible === undefined && m.name));
    const box = worldBox(r.meshes);
    const size = box.max.map((v, j) => v - box.min[j]);
    [379.6, 441.81, 348.6].forEach((v, j) => assert.ok(Math.abs(size[j] - v) <= 0.05, `size ${size}`));
    assertBox(box, await storedBox(openSwContainer(bytes)), 0.05);
  });

  it("Baugr2: saved as a copy, both parts placed", { skip: skipUnless("Baugr2.sldasm") }, async () => {
    const r = await parseSwFile(readFixture("Baugr2.sldasm"));
    assert.deepEqual(r.warnings, []);
    assert.deepEqual(r.meshes.map((m) => m.componentId), ["Würfel 100x100x100 L20-1", "Zylinder 50x80-1"]);
    assertBox(worldBox(r.meshes), await storedBox(open("Baugr2.sldasm")), 0.05);
  });

  it("Baugr3: four sub-assemblies, repeated and rotated parts", { skip: skipUnless("Baugr3.sldasm") }, async () => {
    const r = await parseSwFile(readFixture("Baugr3.sldasm"));
    assert.deepEqual(r.warnings, []);
    const nodes = walk(r.components!);
    assert.equal(nodes.length, 19);
    const subs = nodes.filter((n) => n.kind === "assembly");
    assert.deepEqual(subs.map((n) => n.id), ["Baugr2-1", "Baugr2-2", "Baugr2-3", "Baugr2-4"]);
    assert.ok(subs.every((n) => n.children.length === 2));
    assert.ok(nodes.every((n) => !n.hidden && !n.suppressed));
    assert.equal(r.meshes.length, 15);
    assert.ok(r.meshes.some((m) => m.componentId === "Baugr2-4/Zylinder 50x80-1"));
    // Instances of one part share their buffers.
    const cylinders = r.meshes.filter((m) => m.name?.startsWith("Zylinder"));
    assert.equal(cylinders.length, 9);
    assert.ok(cylinders.every((m) => m.positions === cylinders[0].positions));
    assertBox(worldBox(r.meshes), await storedBox(open("Baugr3.sldasm")), CURVED_TOLERANCE);
  });

  it("matches meshes by directory order when the directory rows cannot be read", {
    skip: skipUnless("Baugr1.sldasm", "Baugr2.sldasm", "Baugr3.sldasm"),
  }, async () => {
    for (const [name, count] of [["Baugr1.sldasm", 5], ["Baugr2.sldasm", 2], ["Baugr3.sldasm", 15]] as const) {
      const c = open(name);
      const expected = worldBox((await readAssembly(c, await displayLists(c), MAX_VERTICES)).meshes);
      const directory = (await c.find("FaceTessellations/Directory")!.read()).slice();
      directory[0] = 3; // unknown row layout version
      for (const variant of [{ "FaceTessellations/Directory": directory }, { "FaceTessellations/Directory": null }]) {
        const r = await readAssembly(patched(c, variant), await displayLists(c), MAX_VERTICES);
        assert.equal(r.meshes.length, count, name);
        assert.ok(r.warnings.some((w) => /directory order/.test(w)), name);
        assertBox(worldBox(r.meshes), expected, 1e-6);
      }
    }
  });

  it("reflects hidden and suppressed components", { skip: skipUnless("Baugr3.sldasm") }, async () => {
    const c = open("Baugr3.sldasm");
    const xml = new TextDecoder().decode(await c.find("swXmlContents/COMPINSTANCETREE")!.read());
    const flag = (text: string, id: string, attribute: string) =>
      text.replace(new RegExp(`(<swReference id="${id}"[^>]*?${attribute}=")NO"`), `$1YES"`);
    const edited = flag(flag(xml, "19", "swHidden"), "18", "swSuppressed"); // Baugr2-2, Zylinder 50x80-5
    assert.notEqual(edited, xml);
    const r = await readAssembly(
      patched(c, { "swXmlContents/COMPINSTANCETREE": new TextEncoder().encode(edited) }),
      await displayLists(c),
      MAX_VERTICES
    );
    const nodes = walk(r.components!);
    assert.equal(nodes.find((n) => n.id === "Zylinder 50x80-5")?.suppressed, true);
    assert.deepEqual(nodes.filter((n) => n.hidden).map((n) => n.id), [
      "Baugr2-2", "Baugr2-2/Würfel 100x100x100 L20-1", "Baugr2-2/Zylinder 50x80-1",
    ]);
    assert.equal(r.meshes.length, 14);
    assert.ok(!r.meshes.some((m) => m.componentId === "Zylinder 50x80-5"));
    assert.deepEqual(r.meshes.filter((m) => m.visible === false).map((m) => m.componentId), [
      "Baugr2-2/Würfel 100x100x100 L20-1", "Baugr2-2/Zylinder 50x80-1",
    ]);
  });
});
