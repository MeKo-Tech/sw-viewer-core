import assert from "node:assert/strict";
import { test } from "node:test";
import { toArrayBuffer } from "../src/react/useSwParse.ts";

const bytes = (buf: ArrayBuffer) => [...new Uint8Array(buf)];

test("ArrayBuffer input is copied into a new buffer", async () => {
  const src = new Uint8Array([1, 2, 3, 4]).buffer;
  const out = await toArrayBuffer(src);
  assert.ok(out instanceof ArrayBuffer);
  assert.notEqual(out, src);
  assert.deepEqual(bytes(out), [1, 2, 3, 4]);
});

test("Uint8Array subarray view returns exactly the view's bytes", async () => {
  const backing = new Uint8Array([9, 9, 1, 2, 3, 9]);
  const view = backing.subarray(2, 5);
  assert.ok(view.byteOffset > 0);
  const out = await toArrayBuffer(view);
  assert.notEqual(out, backing.buffer);
  assert.equal(out.byteLength, 3);
  assert.deepEqual(bytes(out), [1, 2, 3]);
});

test("Blob input is read", async () => {
  const out = await toArrayBuffer(new Blob([new Uint8Array([5, 6, 7])]));
  assert.ok(out instanceof ArrayBuffer);
  assert.deepEqual(bytes(out), [5, 6, 7]);
});

test("transferring the result leaves the input intact", async () => {
  const src = new Uint8Array([1, 2, 3, 4]).buffer;
  const out = await toArrayBuffer(src);
  structuredClone(out, { transfer: [out] });
  assert.equal(out.byteLength, 0, "result was detached");
  assert.equal(src.byteLength, 4);
  assert.deepEqual(bytes(src), [1, 2, 3, 4]);

  const view = new Uint8Array([7, 8, 9, 10]).subarray(1);
  const out2 = await toArrayBuffer(view);
  structuredClone(out2, { transfer: [out2] });
  assert.equal(view.buffer.byteLength, 4);
  assert.deepEqual([...view], [8, 9, 10]);
});
