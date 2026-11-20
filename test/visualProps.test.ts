import assert from "node:assert/strict";
import { test } from "node:test";
import { readBodyColor } from "../src/visualProps.ts";

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
