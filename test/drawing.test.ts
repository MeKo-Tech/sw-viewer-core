// Drawing reader against synthetic streams, plus the Baugr3.slddrw fixture
// (SW_VIEWER_FIXTURES) whose referenced assembly is Baugr3.sldasm.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { previewDibToBmp, readPartBlocks, readReferencedTree, readSheets } from "../src/drawing.ts";
import type { SwContainer } from "../src/container.ts";
import { parseSwFile } from "../src/parse.ts";
import { transferables } from "../src/protocol.ts";
import { parseXml } from "../src/xml.ts";
import { readFixture, skipUnless } from "./fixtures.ts";

const cstring = (value: string) =>
  Buffer.concat([Buffer.from([0xff, 0xfe, 0xff, value.length]), Buffer.from(value, "utf16le")]);

const faceTable = (x: number) => {
  const n = 3;
  const b = Buffer.alloc(16 + 4 + 2 * (16 + 12 * n));
  const header = (at: number, itemSize: number, kind: number, count: number) =>
    [itemSize, kind, 2, count].forEach((v, i) => b.writeUInt32LE(v, at + 4 * i));
  header(0, 4, 8, 1);
  b.writeUInt32LE(n, 16);
  header(20, 12, 100, n);
  [x, 0, 0, x + 0.01, 0, 0, x, 0.01, 0].forEach((v, i) => b.writeFloatLE(v, 36 + 4 * i));
  header(36 + 12 * n, 12, 100, n);
  return b;
};

const container = (streams: Record<string, Uint8Array>): SwContainer => {
  const entries = Object.entries(streams).map(([name, data]) => ({
    name,
    size: data.length,
    compressedSize: data.length,
    read: async () => data,
  }));
  return { kind: "zip", entries, find: (n) => entries.find((e) => e.name === n) };
};

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

describe("drawing streams", () => {
  it("names sheet images from SheetNames in sheet order", async () => {
    const names = Buffer.concat([Buffer.from([2, 0]), cstring("Front"), cstring("Detail"), Buffer.alloc(4)]);
    const sheets = await readSheets(container({
      "SheetPreviews/SheetNames": names,
      "Images/Sheet_1": PNG,
      "Images/Sheet_0": PNG,
      "Images/Sheet_2": Uint8Array.from([1, 2, 3]),
    }));
    assert.deepEqual(sheets.map((s) => s.name), ["Front", "Detail"]);
  });

  it("turns the Preview DIB into a BMP file", () => {
    const dib = Buffer.alloc(40 + 4 * 256 + 4);
    dib.writeUInt32LE(40, 0);
    dib.writeInt32LE(2, 4);
    dib.writeInt32LE(1, 8);
    dib.writeUInt16LE(1, 12);
    dib.writeUInt16LE(8, 14);
    const raw = Buffer.concat([Buffer.alloc(4), dib]);
    raw.writeUInt32LE(dib.length, 0);
    const bmp = previewDibToBmp(raw)!;
    assert.equal(String.fromCharCode(bmp[0], bmp[1]), "BM");
    const v = Buffer.from(bmp);
    assert.equal(v.readUInt32LE(2), bmp.length);
    assert.equal(v.readUInt32LE(10), 14 + 40 + 1024);
    assert.deepEqual(bmp.subarray(14), new Uint8Array(dib));
    assert.equal(previewDibToBmp(new Uint8Array(100)), undefined);
  });

  it("groups VBLists faces by the preceding part path and skips repeated blocks", () => {
    const stream = Buffer.concat([
      cstring("A"), cstring("C:\\x\\A.SLDPRT"), faceTable(0), faceTable(1),
      cstring("C:\\x\\B.sldprt"), faceTable(2),
      cstring("c:\\X\\a.sldprt"), faceTable(3),
    ]);
    const { blocks, ignoredBlocks } = readPartBlocks(stream, 1000);
    assert.deepEqual([...blocks.values()].map((b) => [b.path, b.faces.length]), [
      ["C:\\x\\A.SLDPRT", 2],
      ["C:\\x\\B.sldprt", 1],
    ]);
    assert.equal(ignoredBlocks, 1);
  });

  it("composes placements and flags hidden and suppressed instances", () => {
    const xml = `<swSolidWorks><swHeader>
      <swFile id="1" swDocType="ASSEMBLY" swPath="C:\\top.SLDASM"/>
      <swFile id="2" swDocType="ASSEMBLY" swPath="C:\\sub.SLDASM"/>
      <swFile id="3" swDocType="PART" swPath="C:\\p.SLDPRT"/></swHeader>
      <swModelList>
        <swModel id="10" swFileRef="3"/>
        <swModel id="11" swFileRef="2">
          <swReference swComponentName="p" swReferenceNumber="1" swModelRef="10" swTransform="1 0 0 0 0 1 0 0 0 0 1 0 0.001 0 0 1"/>
        </swModel>
        <swModel id="12" swFileRef="1">
          <swReference swComponentName="sub" swReferenceNumber="1" swModelRef="11" swHidden="YES" swTransform="0 1 0 0 -1 0 0 0 0 0 1 0 0 0.002 0 1"/>
          <swReference swComponentName="p" swReferenceNumber="2" swModelRef="10" swSuppressed="YES" swTransform="1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1"/>
        </swModel>
      </swModelList></swSolidWorks>`;
    const { components, leaves } = readReferencedTree(parseXml(xml)!);
    assert.deepEqual(components.map((c) => [c.id, c.kind, c.hidden, c.suppressed]), [
      ["sub-1", "assembly", true, false],
      ["p-2", "part", false, true],
    ]);
    assert.equal(leaves.length, 1);
    assert.equal(leaves[0].node.id, "sub-1/p-1");
    assert.equal(leaves[0].hidden, true);
    // Child (1 mm along x) rotated 90° about z by the parent, then moved 2 mm along y.
    const m = leaves[0].matrix;
    assert.deepEqual([m[12], m[13], m[14]].map((x) => Math.round(x * 1e9) / 1e9), [0, 3, 0]);
  });

  it("caps a component tree that expands exponentially", () => {
    const levels = 20;
    const models = Array.from({ length: levels }, (_, i) => {
      const refs = i + 1 < levels
        ? [1, 2].map((n) => `<swReference swComponentName="m${i + 1}" swReferenceNumber="${n}" swModelRef="${i + 1}"/>`).join("")
        : "";
      return `<swModel id="${i}" swFileRef="f">${refs}</swModel>`;
    });
    const xml = `<swSolidWorks><swModelList>${models.join("")}</swModelList></swSolidWorks>`;
    const { truncated } = readReferencedTree(parseXml(xml)!);
    assert.equal(truncated, true);
  });
});

describe("Baugr3.slddrw", { skip: skipUnless("Baugr3.slddrw") }, () => {
  it("reads the sheet, properties and the placed 3D model", async () => {
    const r = await parseSwFile(readFixture("Baugr3.slddrw"));
    assert.equal(r.kind, "drawing");
    assert.deepEqual(r.sheets?.map((s) => s.name), ["Blatt1"]);
    assert.equal(r.sheets?.[0].image[1], 0x50);
    assert.ok(r.preview && r.preview[1] === 0x50, "PreviewPNG wins over the BMP");
    assert.equal(r.previewType, undefined);
    assert.equal(r.properties?.["SW-Blattname"], "Blatt1");
    assert.equal(r.properties?.title, "a4 hoch");

    assert.equal(r.meshes.length, 15);
    assert.equal(r.components?.length, 11);
    const ids = new Set<string>();
    const walk = (nodes: NonNullable<typeof r.components>) => nodes.forEach((n) => (ids.add(n.id), walk(n.children)));
    walk(r.components!);
    assert.ok(r.meshes.every((m) => m.componentId && ids.has(m.componentId)));

    // World bounding box against SolidWorks' swBoundingBox of Baugr3 (metres in the XML).
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (const m of r.meshes) {
      const t = m.matrix!;
      for (let i = 0; i < m.positions.length; i += 3) {
        const [x, y, z] = [m.positions[i], m.positions[i + 1], m.positions[i + 2]];
        for (let k = 0; k < 3; k++) {
          const w = t[k] * x + t[4 + k] * y + t[8 + k] * z + t[12 + k];
          min[k] = Math.min(min[k], w);
          max[k] = Math.max(max[k], w);
        }
      }
    }
    const expected = [-268.7346818, -152.1948181, -410, 570.8064115, 335.3724613, 370.8064115];
    // Tessellated cylinders stay inside the exact box by a fraction of a millimetre.
    [...min, ...max].forEach((v, i) => assert.ok(Math.abs(v - expected[i]) < 0.5, `bbox[${i}] = ${v}`));

    assert.ok(transferables(r).includes(r.sheets![0].image.buffer as ArrayBuffer));
  });

  it("converts the high-resolution Preview into a 2858×1499 BMP", async () => {
    const { openSwContainer } = await import("../src/container.ts");
    const raw = await openSwContainer(readFixture("Baugr3.slddrw")).find("Preview")!.read();
    const bmp = Buffer.from(previewDibToBmp(raw)!);
    assert.equal(bmp.toString("latin1", 0, 2), "BM");
    assert.equal(bmp.readInt32LE(18), 2858);
    assert.equal(bmp.readInt32LE(22), 1499);
  });
});
