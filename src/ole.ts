// Reader for the OLE2 compound file (Microsoft CFB) that SolidWorks used up to 2014.
//
// Exposes the same SwContainer interface as the 2015+ archive in container.ts: storage
// paths are joined with "/", and streams whose name ends in "__ZLB" are zlib-compressed
// copies that read() inflates; their entry name drops the suffix. Every sector chain is
// walked with a cycle and range guard, because the input is untrusted.
// Structure follows [MS-CFB]; first ported from the readOle function in MeKo's
// CAD-Viewer-Projekt (src/sw.js).

import type { SwContainer, SwEntry } from "./container.ts";
import { inflateBounded, MAX_ENTRY_SIZE, SwContainerError } from "./inflate.ts";

const HEADER_SIZE = 512;
const DIR_ENTRY_SIZE = 128;
/** Values >= MAXREGSECT end a chain (FREESECT, ENDOFCHAIN, FATSECT, DIFSECT). */
const MAXREGSECT = 0xfffffffa;
const NOSTREAM = 0xffffffff;
const TYPE_STORAGE = 1;
const TYPE_STREAM = 2;
const TYPE_ROOT = 5;
const ZLB_SUFFIX = "__ZLB";
/** Storages nested deeper than this are skipped (SolidWorks uses two or three levels). */
const MAX_STORAGE_DEPTH = 32;
/** Streams listed at most; the rest of a crafted directory is ignored. */
const MAX_ENTRIES = 100_000;

const fail = (message: string): never => {
  throw new SwContainerError(`OLE2: ${message}`);
};

interface DirEntry {
  name: string;
  type: number;
  left: number;
  right: number;
  child: number;
  start: number;
  size: number;
}

/** Reads a chain from `table` starting at `start`. Throws on an out-of-range index or a
 *  cycle. Stops after `maxLength` sectors, which bounds the work to the file size. */
const chain = (table: Uint32Array, start: number, maxLength: number, what: string) => {
  const out: number[] = [];
  const seen = new Set<number>();
  for (let s = start; s < MAXREGSECT; s = table[s]) {
    if (s >= table.length) fail(`${what} chain points at sector ${s}, outside the table`);
    if (seen.has(s)) fail(`${what} chain has a cycle at sector ${s}`);
    seen.add(s);
    out.push(s);
    if (out.length >= maxLength) break;
  }
  return out;
};

/** Copies the sectors of a chain into one buffer, truncated to `size` bytes. */
const gather = (
  src: Uint8Array,
  sectors: number[],
  sectorSize: number,
  offsetOf: (s: number) => number,
  size: number,
  what: string
) => {
  const out = new Uint8Array(Math.min(size, sectors.length * sectorSize));
  for (let i = 0; i * sectorSize < out.length; i++) {
    const at = offsetOf(sectors[i]);
    const n = Math.min(sectorSize, out.length - i * sectorSize);
    if (at < 0 || at + n > src.length) fail(`${what} sector ${sectors[i]} lies past the end of the data`);
    out.set(src.subarray(at, at + n), i * sectorSize);
  }
  if (out.length < size) fail(`${what} is shorter than its declared ${size} bytes`);
  return out;
};

const parseDirectory = (dir: Uint8Array, version4: boolean): DirEntry[] => {
  const v = new DataView(dir.buffer, dir.byteOffset, dir.byteLength);
  const out: DirEntry[] = [];
  for (let o = 0; o + DIR_ENTRY_SIZE <= dir.length; o += DIR_ENTRY_SIZE) {
    const nameBytes = Math.min(v.getUint16(o + 0x40, true), 64);
    let name = "";
    for (let i = 0; i + 1 < nameBytes - 1; i += 2) {
      const c = v.getUint16(o + i, true);
      if (c === 0) break;
      name += String.fromCharCode(c);
    }
    out.push({
      name,
      type: dir[o + 0x42],
      left: v.getUint32(o + 0x44, true),
      right: v.getUint32(o + 0x48, true),
      child: v.getUint32(o + 0x4c, true),
      start: v.getUint32(o + 0x74, true),
      // Version 4 files keep a size high dword at 0x7C (version 3 must ignore it); any
      // non-zero value there exceeds MAX_ENTRY_SIZE anyway.
      size: version4 && v.getUint32(o + 0x7c, true) ? Number.MAX_SAFE_INTEGER : v.getUint32(o + 0x78, true),
    });
  }
  return out;
};

/** Header of a __ZLB stream: a constant 16-byte tag, u32 uncompressed size, u32
 *  compressed size; the zlib stream follows, then 8 zero bytes. */
const ZLB_TAG = [0x23, 0x1d, 0xd5, 0x71, 0xda, 0x81, 0x48, 0xa2, 0xa8, 0x58, 0x98, 0xb2, 0x1b, 0x89, 0xef, 0x99];
const ZLB_HEADER = 24;

/** Inflates a __ZLB payload. Without the known header, falls back to the variants
 *  CAD-Viewer-Projekt tries: raw DEFLATE or zlib, from offset 0 or after 4 bytes. */
const inflateZlb = async (raw: Uint8Array, name: string) => {
  const v = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  if (raw.length >= ZLB_HEADER && ZLB_TAG.every((b, i) => raw[i] === b)) {
    const size = v.getUint32(16, true);
    const compressed = v.getUint32(20, true);
    if (size > MAX_ENTRY_SIZE) {
      fail(`entry "${name}" declares ${size} bytes, more than the ${MAX_ENTRY_SIZE} byte limit`);
    }
    if (ZLB_HEADER + compressed > raw.length) fail(`entry "${name}" is truncated`);
    if (size === 0) return new Uint8Array(0);
    const out = await inflateBounded(raw.subarray(ZLB_HEADER, ZLB_HEADER + compressed), size, name, "deflate")
      .catch((error: unknown) => {
        if (error instanceof SwContainerError) throw error;
        return fail(`could not inflate "${name}": ${error instanceof Error ? error.message : String(error)}`);
      });
    if (out.length !== size) fail(`entry "${name}" inflates to ${out.length} of its declared ${size} bytes`);
    return out;
  }
  const attempts: [Uint8Array, "deflate" | "deflate-raw"][] = [
    [raw, "deflate-raw"],
    [raw, "deflate"],
    [raw.subarray(4), "deflate"],
    [raw.subarray(4), "deflate-raw"],
  ];
  for (const [data, format] of attempts) {
    try {
      const out = await inflateBounded(data, MAX_ENTRY_SIZE, name, format);
      if (out.length) return out;
    } catch (error) {
      // A size-limit violation is final, not a format mismatch.
      if (error instanceof SwContainerError) throw error;
    }
  }
  return fail(`could not inflate "${name}"`);
};

export const openOleContainer = (d: Uint8Array): SwContainer => {
  if (d.length < HEADER_SIZE) fail("file shorter than the 512-byte header");
  const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const sectorShift = v.getUint16(0x1e, true);
  const miniShift = v.getUint16(0x20, true);
  if (sectorShift !== 9 && sectorShift !== 12) fail(`unsupported sector shift ${sectorShift}`);
  if (miniShift < 2 || miniShift >= sectorShift) fail(`unsupported mini sector shift ${miniShift}`);
  const sectorSize = 1 << sectorShift;
  const miniSize = 1 << miniShift;
  const perSector = sectorSize / 4;
  const fatCount = v.getUint32(0x2c, true);
  const dirStart = v.getUint32(0x30, true);
  const miniCutoff = v.getUint32(0x38, true);
  const miniFatStart = v.getUint32(0x3c, true);
  const difatStart = v.getUint32(0x44, true);
  /** Sectors that exist in the file; a partial last sector still counts. */
  const sectorCount = Math.ceil((d.length - sectorSize) / sectorSize);
  if (fatCount > sectorCount) fail(`header claims ${fatCount} FAT sectors in a ${sectorCount}-sector file`);
  const offsetOf = (s: number) => (s + 1) * sectorSize;

  // FAT sector list: 109 entries in the header, then the DIFAT chain.
  const fatSectors: number[] = [];
  const addFatSector = (s: number) => {
    if (s >= MAXREGSECT || fatSectors.length >= fatCount) return;
    if (s >= sectorCount) fail(`FAT sector ${s} lies past the end of the file`);
    fatSectors.push(s);
  };
  for (let i = 0; i < 109; i++) addFatSector(v.getUint32(0x4c + 4 * i, true));
  const difatSeen = new Set<number>();
  for (let s = difatStart; s < MAXREGSECT && fatSectors.length < fatCount; ) {
    if (s >= sectorCount) fail(`DIFAT sector ${s} lies past the end of the file`);
    if (difatSeen.has(s)) fail(`DIFAT chain has a cycle at sector ${s}`);
    difatSeen.add(s);
    const at = offsetOf(s);
    if (at + sectorSize > d.length) fail(`DIFAT sector ${s} is truncated`);
    for (let i = 0; i < perSector - 1; i++) addFatSector(v.getUint32(at + 4 * i, true));
    s = v.getUint32(at + sectorSize - 4, true);
  }
  if (fatSectors.length < fatCount) fail(`found ${fatSectors.length} of ${fatCount} FAT sectors`);
  const fat = new Uint32Array(fatSectors.length * perSector);
  for (const [i, s] of fatSectors.entries()) {
    const at = offsetOf(s);
    for (let k = 0; k < perSector; k++) {
      fat[i * perSector + k] = at + 4 * k + 4 <= d.length ? v.getUint32(at + 4 * k, true) : NOSTREAM;
    }
  }

  const readFat = (start: number, size: number, what: string) =>
    gather(d, chain(fat, start, Math.ceil(size / sectorSize), what), sectorSize, offsetOf, size, what);

  const dirSectors = chain(fat, dirStart, sectorCount, "directory");
  const dirs = parseDirectory(
    gather(d, dirSectors, sectorSize, offsetOf, dirSectors.length * sectorSize, "directory"),
    sectorShift === 12
  );
  const root = dirs[0];
  if (!root || root.type !== TYPE_ROOT) fail("first directory entry is not the root storage");

  // Mini stream (inside the root entry's chain) and mini FAT, read on first use.
  let mini: { stream: Uint8Array; fat: Uint32Array } | undefined;
  const miniData = () => {
    if (!mini) {
      if (root.size > MAX_ENTRY_SIZE) fail("mini stream too large");
      const stream = root.size ? readFat(root.start, root.size, "mini stream") : new Uint8Array(0);
      const fatSectorsMini =
        miniFatStart < MAXREGSECT ? chain(fat, miniFatStart, sectorCount, "mini FAT") : [];
      const bytes = gather(d, fatSectorsMini, sectorSize, offsetOf, fatSectorsMini.length * sectorSize, "mini FAT");
      const mv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const table = new Uint32Array(bytes.length / 4);
      for (let i = 0; i < table.length; i++) table[i] = mv.getUint32(4 * i, true);
      mini = { stream, fat: table };
    }
    return mini;
  };

  const readStream = (e: DirEntry, name: string) => {
    if (e.size > MAX_ENTRY_SIZE) {
      fail(`entry "${name}" declares ${e.size} bytes, more than the ${MAX_ENTRY_SIZE} byte limit`);
    }
    if (e.size === 0) return new Uint8Array(0);
    if (e.size < miniCutoff) {
      const m = miniData();
      const sectors = chain(m.fat, e.start, Math.ceil(e.size / miniSize), `mini stream of "${name}"`);
      return gather(m.stream, sectors, miniSize, (s) => s * miniSize, e.size, `"${name}"`);
    }
    return readFat(e.start, e.size, `"${name}"`);
  };

  // Walk the red-black trees of every storage; the visited set breaks cycles. The depth
  // and entry caps bound the path strings, which would otherwise grow quadratically
  // with a crafted chain of nested storages.
  const entries: SwEntry[] = [];
  const visited = new Set<number>();
  const stack: { id: number; path: string; depth: number }[] = [{ id: root.child, path: "", depth: 0 }];
  while (stack.length && entries.length < MAX_ENTRIES) {
    const { id, path, depth } = stack.pop()!;
    if (id >= dirs.length || visited.has(id)) continue;
    visited.add(id);
    const e = dirs[id];
    stack.push({ id: e.right, path, depth }, { id: e.left, path, depth });
    if (e.type === TYPE_STORAGE) {
      if (depth < MAX_STORAGE_DEPTH) stack.push({ id: e.child, path: path ? `${path}/${e.name}` : e.name, depth: depth + 1 });
    } else if (e.type === TYPE_STREAM) {
      const full = path ? `${path}/${e.name}` : e.name;
      const zlb = full.toUpperCase().endsWith(ZLB_SUFFIX);
      const name = zlb ? full.slice(0, -ZLB_SUFFIX.length) : full;
      entries.push({
        name,
        compressedSize: e.size,
        // The uncompressed size of a __ZLB stream is only known after inflating; report
        // the stored size so callers that skip empty entries still read it.
        size: e.size,
        read: async () => {
          const raw = readStream(e, full);
          return zlb && raw.length ? inflateZlb(raw, name) : raw;
        },
      });
    }
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return {
    kind: "ole2",
    entries,
    find: (name) =>
      entries.find((e) => e.name === name) ??
      entries.find((e) => e.name.split("/").pop() === name),
  };
};
