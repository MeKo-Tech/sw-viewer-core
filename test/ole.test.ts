// OLE2 compound-file reader against small synthetic files built here, plus an optional
// check of real SolidWorks 2011 parts (SW_OLE2_FIXTURES: a folder with *.SLDPRT and the
// build_results_2011.json of blussyya/sldprt-research-dump "test files new").

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { deflateSync } from "node:zlib";
import {
  containerKind,
  containerVersion,
  MAX_ENTRY_SIZE,
  openSwContainer,
  SwContainerError,
} from "../src/container.ts";
import { signedVolume } from "../src/displayMesh.ts";
import { parseSwFile } from "../src/parse.ts";

const SECTOR = 512;
const MINI = 64;
const CUTOFF = 4096;
const END = 0xfffffffe;
const FREE = 0xffffffff;
const FATSECT = 0xfffffffd;

type Node =
  | { name: string; data: Uint8Array }
  | { name: string; children: Node[] };

interface Built {
  bytes: Uint8Array;
  /** First sector (FAT or mini FAT) of each stream, by path. */
  starts: Map<string, number>;
  fat: number[];
  /** File offset of FAT entry `i`. */
  fatOffset: (i: number) => number;
  /** File offset of directory entry `i`. */
  dirOffset: (i: number) => number;
  /** File offset of mini FAT entry `i`. */
  miniFatOffset: (i: number) => number;
}

/** Version 3 compound file (512-byte sectors). Siblings hang off the `right` pointer,
 *  which is a valid (if unbalanced) tree. Streams below 4096 bytes go to the mini stream. */
const buildOle = (tree: Node[]): Built => {
  interface Dir { name: string; type: number; left: number; right: number; child: number; start: number; size: number }
  const dirs: Dir[] = [{ name: "Root Entry", type: 5, left: FREE, right: FREE, child: FREE, start: END, size: 0 }];
  const streams: { dir: Dir; data: Uint8Array; path: string }[] = [];
  const add = (nodes: Node[], parent: Dir, prefix: string) => {
    let prev: Dir | undefined;
    for (const n of nodes) {
      const d: Dir = { name: n.name, type: "data" in n ? 2 : 1, left: FREE, right: FREE, child: FREE, start: END, size: 0 };
      const id = dirs.push(d) - 1;
      if (prev) prev.right = id;
      else parent.child = id;
      prev = d;
      const path = prefix + n.name;
      if ("data" in n) streams.push({ dir: d, data: n.data, path });
      else add(n.children, d, path + "/");
    }
  };
  add(tree, dirs[0], "");

  const sectors: Uint8Array[] = [];
  const fat: number[] = [];
  const allocate = (data: Uint8Array) => {
    if (!data.length) return END;
    const first = sectors.length;
    for (let o = 0; o < data.length; o += SECTOR) {
      const s = new Uint8Array(SECTOR);
      s.set(data.subarray(o, o + SECTOR));
      sectors.push(s);
      fat.push(sectors.length);
    }
    fat[fat.length - 1] = END;
    return first;
  };

  const starts = new Map<string, number>();
  const miniParts: Uint8Array[] = [];
  const miniFat: number[] = [];
  for (const s of streams) {
    s.dir.size = s.data.length;
    if (s.data.length >= CUTOFF) continue;
    if (!s.data.length) continue;
    const first = miniFat.length;
    for (let o = 0; o < s.data.length; o += MINI) {
      const m = new Uint8Array(MINI);
      m.set(s.data.subarray(o, o + MINI));
      miniParts.push(m);
      miniFat.push(miniFat.length + 1);
    }
    miniFat[miniFat.length - 1] = END;
    s.dir.start = first;
    starts.set(s.path, first);
  }
  for (const s of streams) {
    if (s.data.length >= CUTOFF) {
      s.dir.start = allocate(s.data);
      starts.set(s.path, s.dir.start);
    }
  }
  const miniStream = new Uint8Array(miniParts.length * MINI);
  miniParts.forEach((m, i) => miniStream.set(m, i * MINI));
  dirs[0].start = allocate(miniStream);
  dirs[0].size = miniStream.length;
  const miniFatBytes = new Uint8Array(Math.max(1, Math.ceil((miniFat.length * 4) / SECTOR)) * SECTOR).fill(0xff);
  miniFat.forEach((x, i) => new DataView(miniFatBytes.buffer).setUint32(4 * i, x, true));
  const miniFatStart = miniFat.length ? allocate(miniFatBytes) : END;

  const dirBytes = new Uint8Array(Math.ceil(dirs.length / 4) * 4 * 128);
  const dv = new DataView(dirBytes.buffer);
  dirs.forEach((d, i) => {
    const o = i * 128;
    for (let k = 0; k < d.name.length; k++) dv.setUint16(o + 2 * k, d.name.charCodeAt(k), true);
    dv.setUint16(o + 0x40, 2 * d.name.length + 2, true);
    dirBytes[o + 0x42] = d.type;
    dv.setUint32(o + 0x44, d.left, true);
    dv.setUint32(o + 0x48, d.right, true);
    dv.setUint32(o + 0x4c, d.child, true);
    dv.setUint32(o + 0x74, d.start, true);
    dv.setUint32(o + 0x78, d.size, true);
  });
  for (let i = dirs.length; i < dirBytes.length / 128; i++) {
    dv.setUint32(i * 128 + 0x44, FREE, true);
    dv.setUint32(i * 128 + 0x48, FREE, true);
    dv.setUint32(i * 128 + 0x4c, FREE, true);
  }
  const dirStart = allocate(dirBytes);

  let fatCount = 1;
  while (fatCount * (SECTOR / 4) < sectors.length + fatCount) fatCount++;
  const fatStart = sectors.length;
  for (let i = 0; i < fatCount; i++) {
    sectors.push(new Uint8Array(SECTOR));
    fat.push(FATSECT);
  }

  const header = new Uint8Array(SECTOR);
  const hv = new DataView(header.buffer);
  header.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  hv.setUint16(0x18, 0x3e, true);
  hv.setUint16(0x1a, 3, true);
  hv.setUint16(0x1c, 0xfffe, true);
  hv.setUint16(0x1e, 9, true);
  hv.setUint16(0x20, 6, true);
  hv.setUint32(0x2c, fatCount, true);
  hv.setUint32(0x30, dirStart, true);
  hv.setUint32(0x38, CUTOFF, true);
  hv.setUint32(0x3c, miniFatStart, true);
  hv.setUint32(0x40, miniFat.length ? Math.ceil((miniFat.length * 4) / SECTOR) : 0, true);
  hv.setUint32(0x44, END, true);
  for (let i = 0; i < 109; i++) hv.setUint32(0x4c + 4 * i, i < fatCount ? fatStart + i : FREE, true);

  const bytes = new Uint8Array(SECTOR * (1 + sectors.length));
  bytes.set(header);
  sectors.forEach((s, i) => bytes.set(s, SECTOR * (1 + i)));
  const fatOffset = (i: number) => SECTOR * (1 + fatStart) + 4 * i;
  const bv = new DataView(bytes.buffer);
  for (let i = 0; i < fatCount * (SECTOR / 4); i++) bv.setUint32(fatOffset(i), i < fat.length ? fat[i] : FREE, true);
  const dirOffset = (i: number) => SECTOR * (1 + dirStart) + 128 * i;
  const miniFatOffset = (i: number) => SECTOR * (1 + miniFatStart) + 4 * i;
  return { bytes, starts, fat, fatOffset, dirOffset, miniFatOffset };
};

const text = (s: string) => new TextEncoder().encode(s);
const pattern = (n: number) => Uint8Array.from({ length: n }, (_, i) => (i * 7 + 3) & 0xff);
const setU32 = (b: Uint8Array, at: number, value: number) =>
  new DataView(b.buffer, b.byteOffset).setUint32(at, value, true);

/** __ZLB payload as SolidWorks writes it: tag, sizes, zlib stream, 8 zero bytes. */
const ZLB_TAG = [0x23, 0x1d, 0xd5, 0x71, 0xda, 0x81, 0x48, 0xa2, 0xa8, 0x58, 0x98, 0xb2, 0x1b, 0x89, 0xef, 0x99];
const zlb = (content: Uint8Array, declared = content.length) => {
  const z = deflateSync(content);
  const out = new Uint8Array(24 + z.length + 8);
  out.set(ZLB_TAG);
  setU32(out, 16, declared);
  setU32(out, 20, z.length);
  out.set(z, 24);
  return out;
};

const big = pattern(5000);
const small = text("mini stream content ".repeat(10));

describe("OLE2 container", () => {
  it("reads regular and mini streams with storage paths", async () => {
    const { bytes } = buildOle([
      { name: "Contents", children: [{ name: "Big", data: big }, { name: "Small", data: small }] },
      { name: "_MO_VERSION_4700", children: [{ name: "History", data: text("h") }] },
      { name: "Empty", data: new Uint8Array(0) },
    ]);
    assert.equal(containerKind(bytes), "ole2");
    const c = openSwContainer(bytes);
    assert.equal(c.kind, "ole2");
    assert.deepEqual(c.entries.map((e) => e.name), [
      "Contents/Big",
      "Contents/Small",
      "Empty",
      "_MO_VERSION_4700/History",
    ]);
    assert.deepEqual(await c.find("Contents/Big")!.read(), big);
    assert.deepEqual(await c.find("Small")!.read(), small);
    assert.equal((await c.find("Empty")!.read()).length, 0);
    assert.equal(containerVersion(c), 4700);
  });

  it("inflates __ZLB streams under the name without suffix", async () => {
    const content = text("display lists ".repeat(500));
    const plain = text("plain zlib ".repeat(50));
    const { bytes } = buildOle([
      { name: "Contents", children: [{ name: "DisplayLists__ZLB", data: zlb(content) }] },
      { name: "Legacy__ZLB", data: deflateSync(plain) },
    ]);
    const c = openSwContainer(bytes);
    assert.deepEqual(await c.find("Contents/DisplayLists")!.read(), content);
    // Without the SolidWorks header the reader falls back to plain zlib.
    assert.deepEqual(await c.find("Legacy")!.read(), plain);
  });

  it("rejects a __ZLB stream that inflates past its declared size", async () => {
    const { bytes } = buildOle([{ name: "Bomb__ZLB", data: zlb(new Uint8Array(100_000), 10) }]);
    await assert.rejects(openSwContainer(bytes).find("Bomb")!.read(), SwContainerError);
  });

  it("rejects a __ZLB stream declaring more than MAX_ENTRY_SIZE", async () => {
    const { bytes } = buildOle([{ name: "Huge__ZLB", data: zlb(text("x"), MAX_ENTRY_SIZE + 1) }]);
    await assert.rejects(openSwContainer(bytes).find("Huge")!.read(), /byte limit/);
  });

  it("detects a cycle in a FAT chain", async () => {
    const built = buildOle([{ name: "Big", data: big }]);
    const first = built.starts.get("Big")!;
    setU32(built.bytes, built.fatOffset(first + 1), first);
    await assert.rejects(openSwContainer(built.bytes).find("Big")!.read(), /cycle/);
  });

  it("detects a cycle in a mini FAT chain", async () => {
    const built = buildOle([{ name: "Small", data: small }]);
    setU32(built.bytes, built.miniFatOffset(1), 0);
    await assert.rejects(openSwContainer(built.bytes).find("Small")!.read(), /cycle/);
  });

  it("rejects a sector index outside the FAT", async () => {
    const built = buildOle([{ name: "Big", data: big }]);
    const first = built.starts.get("Big")!;
    setU32(built.bytes, built.fatOffset(first), 0x00ffffff);
    await assert.rejects(openSwContainer(built.bytes).find("Big")!.read(), /outside the table/);
  });

  it("survives a cycle in the directory tree", () => {
    const built = buildOle([{ name: "A", data: text("a") }, { name: "B", data: text("b") }]);
    // Entry 2 (B) points back to entry 1 (A) as its right sibling.
    setU32(built.bytes, built.dirOffset(2) + 0x48, 1);
    const c = openSwContainer(built.bytes);
    assert.deepEqual(c.entries.map((e) => e.name), ["A", "B"]);
  });

  it("rejects a header with an unsupported sector size", () => {
    const { bytes } = buildOle([{ name: "A", data: text("a") }]);
    bytes[0x1e] = 20;
    assert.throws(() => openSwContainer(bytes), SwContainerError);
  });

  it("parses a synthetic legacy part end to end", async () => {
    const n = 3;
    const face = new Uint8Array(16 + 4 + 2 * (16 + 12 * n));
    const v = new DataView(face.buffer);
    const header = (at: number, itemSize: number, kind: number, count: number) => {
      [itemSize, kind, 2, count].forEach((x, i) => v.setUint32(at + 4 * i, x, true));
    };
    header(0, 4, 8, 1);
    v.setUint32(16, n, true);
    header(20, 12, 100, n);
    [0, 0, 0, 0.01, 0, 0, 0, 0.01, 0].forEach((x, i) => v.setFloat32(36 + 4 * i, x, true));
    header(36 + 12 * n, 12, 100, n);
    const { bytes } = buildOle([
      {
        name: "Contents",
        children: [
          { name: "Config-0-Partition", data: text("p") },
          { name: "DisplayLists__ZLB", data: zlb(face) },
        ],
      },
    ]);
    const r = await parseSwFile(bytes);
    assert.equal(r.kind, "part");
    assert.equal(r.meshes.length, 1);
    assert.equal(r.meshes[0].indices.length, 3);
    assert.equal(r.meshes[0].positions[3], 10);
  });
});

/** Coarsest tessellation in the SolidWorks 2011 set (torus) is about 0.5 %. */
const OLE2_TOLERANCE = 0.015;
const ole2Dir = process.env.SW_OLE2_FIXTURES;
const ole2Truth = ole2Dir && ["build_results_2011.json", "build_results.json"].map((f) => join(ole2Dir, f)).find(existsSync);

describe("SolidWorks 2011 parts (OLE2)", { skip: !ole2Truth && "SW_OLE2_FIXTURES not set" }, () => {
  const truth: Record<string, { volume_mm3: number; face_count: number }> = ole2Truth
    ? JSON.parse(readFileSync(ole2Truth, "utf8")).results
    : {};
  const files = ole2Dir ? readdirSync(ole2Dir).filter((f) => /\.sldprt$/i.test(f)) : [];
  for (const file of files) {
    const name = file.replace(/\.sldprt$/i, "");
    it(name, async () => {
      const bytes = new Uint8Array(readFileSync(join(ole2Dir!, file)));
      assert.equal(containerKind(bytes), "ole2");
      const r = await parseSwFile(bytes);
      assert.equal(r.kind, "part");
      assert.equal(r.version, 4700);
      assert.ok(r.preview && r.preview[1] === 0x50, "PNG thumbnail present");
      assert.equal(r.meshes.length, 1);
      const expected = truth[name];
      if (!expected) return;
      assert.equal(r.meshes[0].faceRanges?.length, expected.face_count);
      const deviation = signedVolume(r.meshes[0]) / expected.volume_mm3 - 1;
      assert.ok(Math.abs(deviation) < OLE2_TOLERANCE, `volume deviates ${(deviation * 100).toFixed(2)} %`);
    });
  }
});
