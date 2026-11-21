// readSwPreview: the embedded thumbnail without a full parse. Synthetic containers for
// the fallback order, plus the CAD-Viewer fixtures (SW_VIEWER_FIXTURES), the decoder
// repo's parts (SW_DECODER_REPO) and the pre-2015 OLE2 parts (SW_OLE2_FIXTURES).

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { SwContainer } from "../src/container.ts";
import { readSwPreview } from "../src/index.ts";
import { readContainerPreview } from "../src/preview.ts";
import { readFixture, skipUnless } from "./fixtures.ts";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

// A 1×1 24-bit DIB with a u32 length prefix, as SolidWorks stores `Preview`.
const dib = () => {
  const body = Buffer.alloc(40 + 4);
  body.writeUInt32LE(40, 0);
  body.writeInt32LE(1, 4);
  body.writeInt32LE(1, 8);
  body.writeUInt16LE(1, 12);
  body.writeUInt16LE(24, 14);
  const out = Buffer.alloc(4 + body.length);
  out.writeUInt32LE(body.length, 0);
  body.copy(out, 4);
  return new Uint8Array(out);
};

const container = (streams: Record<string, Uint8Array>): SwContainer => {
  const entries = Object.entries(streams).map(([name, data]) => ({
    name,
    size: data.length,
    read: async () => data,
  }));
  return { entries, find: (n: string) => entries.find((e) => e.name === n) } as unknown as SwContainer;
};

const assertImage = (img: { bytes: Uint8Array; type: string } | undefined, label: string) => {
  assert.ok(img, `${label}: no preview`);
  if (img.type === "image/png") assert.deepEqual([...img.bytes.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], label);
  else assert.equal(String.fromCharCode(img.bytes[0], img.bytes[1]), "BM", label);
};

describe("readContainerPreview", () => {
  it("prefers PreviewPNG", async () => {
    const img = await readContainerPreview(container({ PreviewPNG: PNG, Preview: dib() }));
    assert.equal(img?.type, "image/png");
    assert.equal(img?.bytes, PNG);
  });

  it("falls back to the Preview DIB as BMP", async () => {
    const img = await readContainerPreview(container({ Preview: dib() }));
    assertImage(img, "dib");
    assert.equal(img?.type, "image/bmp");
  });

  it("falls back to the first sheet image, unless sheets are off", async () => {
    const other = new Uint8Array([...PNG, 9]);
    const c = container({ "Images/Sheet_1": other, "Images/Sheet_0": PNG });
    assert.equal((await readContainerPreview(c))?.bytes, PNG);
    assert.equal(await readContainerPreview(c, { sheets: false }), undefined);
  });

  it("ignores a PreviewPNG that is not a PNG", async () => {
    assert.equal(await readContainerPreview(container({ PreviewPNG: new Uint8Array(16) })), undefined);
  });

  it("throws on bytes that are not a SolidWorks container", async () => {
    await assert.rejects(readSwPreview(new Uint8Array(64).fill(7)));
  });
});

const CAD_FIXTURES = [
  "wuerfel.sldprt",
  "zylinder.sldprt",
  "Teil.sldprt",
  "Baugr1.sldasm",
  "Baugr2.sldasm",
  "Baugr3.sldasm",
  "Baugr3.slddrw",
];

describe("readSwPreview on fixtures", () => {
  for (const name of CAD_FIXTURES) {
    it(name, { skip: skipUnless(name) }, async () => {
      assertImage(await readSwPreview(readFixture(name)), name);
    });
  }

  const sldFiles = (dir: string | undefined) =>
    dir && existsSync(dir)
      ? readdirSync(dir, { recursive: true, encoding: "utf8" })
          .filter((f) => /\.sld(prt|asm|drw)$/i.test(f))
          .map((f) => join(dir, f))
      : [];

  const decoderDir = process.env.SW_DECODER_REPO && join(process.env.SW_DECODER_REPO, "testdaten");
  const decoderParts = sldFiles(decoderDir);
  it("decoder repo parts", { skip: decoderParts.length ? false : "SW_DECODER_REPO not set" }, async () => {
    for (const f of decoderParts) {
      const img = await readSwPreview(new Uint8Array(readFileSync(f))).catch((e) => assert.fail(`${f}: ${e}`));
      if (img) assertImage(img, f);
    }
  });

  const ole2 = sldFiles(process.env.SW_OLE2_FIXTURES);
  it("pre-2015 OLE2 parts", { skip: ole2.length ? false : "SW_OLE2_FIXTURES not set" }, async () => {
    for (const f of ole2) assertImage(await readSwPreview(new Uint8Array(readFileSync(f))), f);
  });
});
