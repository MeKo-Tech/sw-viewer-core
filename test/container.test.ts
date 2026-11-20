// Container reader against small synthetic archives, built here so the tests need
// no sample parts.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { crc32, deflateRawSync } from "node:zlib";
import { MAX_ENTRY_SIZE, openSwContainer, SwContainerError } from "../src/container.ts";

const MARKER = [0x14, 0x00, 0x06, 0x00, 0x08, 0x00];

const swapNibbles = (b: Uint8Array) => b.map((x) => ((x & 0x0f) << 4) | (x >> 4));

/** One-entry container without a central directory: 8-byte file header, then a local
 *  header with the SolidWorks marker, a nibble-swapped name and the raw DEFLATE data.
 *  `size` and `crc` go into the header as given, so a test can lie about them. */
const buildContainer = (
  name: string,
  compressed: Uint8Array,
  opts: { size: number; crc: number }
) => {
  const rawName = swapNibbles(new TextEncoder().encode(name));
  const d = new Uint8Array(8 + 4 + 26 + rawName.length + compressed.length);
  const v = new DataView(d.buffer);
  d.set([0, 0, 0, 0, 0, 0, 0, 4]);
  const m = 8 + 4;
  d.set(MARKER, m);
  v.setUint32(m + 10, opts.crc, true);
  v.setUint32(m + 14, compressed.length, true);
  v.setUint32(m + 18, opts.size, true);
  v.setUint16(m + 22, rawName.length, true);
  v.setUint16(m + 24, 0, true);
  d.set(rawName, m + 26);
  d.set(compressed, m + 26 + rawName.length);
  return d;
};

const entryOf = (d: Uint8Array) => {
  const e = openSwContainer(d).find("DisplayLists");
  assert.ok(e, "entry found");
  return e;
};

describe("container entries", () => {
  it("inflates an entry and checks its CRC", async () => {
    const content = new TextEncoder().encode("display list ".repeat(100));
    const d = buildContainer("Contents/DisplayLists", deflateRawSync(content), {
      size: content.length,
      crc: crc32(content),
    });
    assert.deepEqual(await entryOf(d).read(), content);
  });

  it("rejects output shorter than the declared size", async () => {
    const content = new Uint8Array(1000).fill(7);
    const d = buildContainer("Contents/DisplayLists", deflateRawSync(content), {
      size: content.length + 1,
      crc: crc32(content),
    });
    await assert.rejects(entryOf(d).read(), (err: Error) => {
      assert.ok(err instanceof SwContainerError);
      assert.match(err.message, /length\/CRC mismatch/);
      return true;
    });
  });

  it("stops inflating a DEFLATE bomb at the declared size", async () => {
    // 64 MiB of zeros compresses to ~64 kB but claims to be 1 kB.
    const bomb = deflateRawSync(new Uint8Array(64 * 1024 * 1024));
    const d = buildContainer("Contents/DisplayLists", bomb, { size: 1024, crc: 0 });
    const heapBefore = process.memoryUsage().arrayBuffers;
    await assert.rejects(entryOf(d).read(), (err: Error) => {
      assert.ok(err instanceof SwContainerError);
      assert.match(err.message, /inflates to more than its declared 1024 bytes/);
      return true;
    });
    // Unbounded inflation would have buffered all 64 MiB.
    const grown = process.memoryUsage().arrayBuffers - heapBefore;
    assert.ok(grown < 32 * 1024 * 1024, `buffered ${grown} bytes`);
  });

  it("rejects a declared size above the cap without inflating", async () => {
    const content = new Uint8Array(16);
    const d = buildContainer("Contents/DisplayLists", deflateRawSync(content), {
      size: MAX_ENTRY_SIZE + 1,
      crc: crc32(content),
    });
    await assert.rejects(entryOf(d).read(), (err: Error) => {
      assert.ok(err instanceof SwContainerError);
      assert.match(err.message, /more than the \d+ byte limit/);
      return true;
    });
  });
});
