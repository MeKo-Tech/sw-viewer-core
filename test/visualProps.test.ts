import assert from "node:assert/strict";
import { test } from "node:test";
import { scanFaceTables } from "../src/displayMesh.ts";
import { readBodyColor, readFaceColors } from "../src/visualProps.ts";

const record = (rgb: number[], texture: string) => {
  const name = new TextEncoder().encode("moVisualProperties_c");
  const tex = [0xff, 0xfe, 0xff, texture.length, ...[...texture].flatMap((ch) => [ch.charCodeAt(0), 0])];
  return new Uint8Array([1, 2, 3, ...name, ...rgb, 0, 0, 0, 0, 0, 0xc0, 0xc0, 0xc0, 0, ...tex, 0, 0]);
};

test("reads a plain appearance color", () => {
  assert.deepEqual(readBodyColor(record([0xca, 0xd1, 0xee], "")), [0xca / 255, 0xd1 / 255, 0xee / 255]);
});

test("reports a textured appearance as unknown", () => {
  assert.equal(readBodyColor(record([0xff, 0xff, 0xff], "texture")), undefined);
});

test("returns undefined without a record", () => {
  assert.equal(readBodyColor(new Uint8Array(32)), undefined);
});

const u32 = (value: number) => {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(value);
  return bytes;
};

const cString = (value: string) =>
  Buffer.concat([Buffer.from([0xff, 0xfe, 0xff, value.length]), Buffer.from(value, "utf16le")]);

const faceTable = Buffer.concat([
  Buffer.from("0400000008000000020000000100000003000000", "hex"),
  Buffer.from("0c000000640000000200000003000000", "hex"), Buffer.alloc(36),
  Buffer.from("0c000000640000000200000003000000", "hex"), Buffer.alloc(36),
]);

const appearance = ({ texture = 0, secondTexture = 0, withRealView = false, legacy = false } = {}) => Buffer.concat([
  Buffer.from("01000000ffffffff3480", "hex"),
  Buffer.from("d020800000000000c0c0c000", "hex"),
  cString(""), cString(""), Buffer.alloc(6 * 8),
  u32(texture), Buffer.alloc(5 * 4), cString(""), u32(0),
  u32(Number(withRealView)),
  ...(withRealView ? [
    Buffer.alloc(8), cString("defaultplastic"), Buffer.alloc(81), cString(""),
    Buffer.alloc(12), cString(""), Buffer.alloc(76), cString(""), Buffer.alloc(4),
  ] : []),
  ...(withRealView && legacy ? [cString(""), cString(""), cString(""), Buffer.alloc(92)] : []),
  cString(""), u32(secondTexture),
  // Remaining visual properties and the two words before the face footer.
  u32(0), cString(""), Buffer.alloc(4 * 2), cString(""), Buffer.alloc(4 * (legacy ? 5 : 6)), Buffer.alloc(8),
]);

const faceRecord = (
  bytes = appearance(), scope = 0, closingId = "moEndFaceSurfIdRep_c,36,1,0, \n",
) => Buffer.concat([
  faceTable,
  cString("moEndFaceSurfIdRep_c,36,1,0, \n"), bytes,
  u32(1), u32(0xffffffff), u32(scope), u32(54), u32(0),
  cString(closingId),
]);

const faceColors = (stream: Buffer, version = 19000) =>
  readFaceColors(stream, scanFaceTables(stream), version);

test("reads a plain local appearance between matching face IDs", () => {
  const stream = Buffer.concat([faceTable, faceRecord(), faceTable]);
  assert.deepEqual([...faceColors(stream)], [[1, [0xd0 / 255, 0x20 / 255, 0x80 / 255]]]);
});

test("omits a face appearance with either texture flag set", () => {
  assert.equal(faceColors(faceRecord(appearance({ texture: 1 }))).size, 0);
  assert.equal(faceColors(faceRecord(appearance({ secondTexture: 1, withRealView: true }))).size, 0);
});

test("reads a plain appearance with RealView properties", () => {
  assert.equal(faceColors(faceRecord(appearance({ withRealView: true }))).size, 1);
  assert.equal(faceColors(faceRecord(appearance({ withRealView: true, legacy: true })), 15000).size, 1);
});

test("omits colors for inherited body appearances in face records", () => {
  assert.equal(faceColors(faceRecord(appearance(), 2)).size, 0);
});

test("omits an appearance when its face IDs differ", () => {
  assert.equal(faceColors(faceRecord(appearance(), 0, "moEndFaceSurfIdRep_c,36,7,0, \n")).size, 0);
});

test("omits ambiguous or truncated appearance data", () => {
  assert.equal(faceColors(faceRecord(Buffer.concat([appearance(), appearance()]))).size, 0);
  assert.equal(faceColors(faceRecord(appearance().subarray(0, 43))).size, 0);
});
