// Checks the decoded display mesh of every sample part against the volume SolidWorks
// itself reports (tests/wahrheit_testdaten.json in Solidworks-File-Decoder).
//
// The sample parts are not part of this repo. Point SW_DECODER_REPO at a checkout of
// MeKo-Tech/Solidworks-File-Decoder; without it the sample tests are skipped.

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { containerKind } from "../src/container.ts";
import { signedVolume } from "../src/displayMesh.ts";
import { parseSwFile } from "../src/parse.ts";

const repo = process.env.SW_DECODER_REPO;
const testdata = repo ? join(repo, "testdaten") : "";
const truthFile = repo ? join(repo, "tests/wahrheit_testdaten.json") : "";
const haveSamples = !!repo && existsSync(testdata) && existsSync(truthFile);

/** Tessellation always cuts a little off curved faces; 1.5 % covers the coarsest sample. */
const TOLERANCE = 0.015;

/** Parts whose stored display mesh is older than the exact solid (SolidWorks saved
 *  without rebuilding the display). Listed in the decoder repo's docs/TESTERGEBNISSE.md. */
const STALE_DISPLAY_MESH = new Set(["Sr220106_10RevB", "Sr220106_15RevB"]);

describe("container", () => {
  it("rejects non-SolidWorks data", () => {
    assert.equal(containerKind(new Uint8Array(64)), "unknown");
  });
  it("detects the pre-2015 OLE2 container", () => {
    const ole = new Uint8Array(64);
    ole.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    assert.equal(containerKind(ole), "ole2");
  });
});

describe("sample parts", { skip: !haveSamples && "SW_DECODER_REPO not set" }, () => {
  const truth: Record<string, { volumen_mm3: number }> = haveSamples
    ? JSON.parse(readFileSync(truthFile, "utf8"))
    : {};
  const parts = haveSamples
    ? readdirSync(testdata).filter((f) => f.toLowerCase().endsWith(".sldprt"))
    : [];

  for (const file of parts) {
    const name = file.replace(/\.sldprt$/i, "");
    it(name, async () => {
      const r = await parseSwFile(new Uint8Array(readFileSync(join(testdata, file))));
      assert.equal(r.kind, "part");
      assert.ok(r.preview && r.preview[1] === 0x50, "PNG thumbnail present");
      assert.equal(r.meshes.length, 1);
      const mesh = r.meshes[0];
      assert.equal(mesh.indices.length % 3, 0);
      assert.ok(mesh.indices.every((i) => i < mesh.positions.length / 3));
      assert.ok(mesh.color, "body color");

      const expected = truth[name]?.volumen_mm3;
      assert.ok(expected, `truth volume for ${name}`);
      const deviation = signedVolume(mesh) / expected - 1;
      if (STALE_DISPLAY_MESH.has(name)) {
        assert.ok(Math.abs(deviation) > TOLERANCE, "known stale mesh now matches – update the list");
      } else {
        assert.ok(
          Math.abs(deviation) < TOLERANCE,
          `volume deviates ${(deviation * 100).toFixed(2)} %`
        );
      }
    });
  }
});
