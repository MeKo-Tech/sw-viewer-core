// Container reader for SolidWorks files (.SLDPRT, .SLDASM) from SolidWorks 2015 on.
//
// The file is a ZIP-like archive behind an 8-byte header: the ZIP signatures are
// replaced, entry names are nibble-swapped per byte and the payload is raw DEFLATE.
// Ported from Solidworks-File-Decoder/freecad/SldImport/sldcontainer.py (our own code).
// The pre-2015 OLE2 container is detected but not read yet.

/** Version 20, flags 6, method 8 (DEFLATE): marks local and central headers. */
const MARKER = [0x14, 0x00, 0x06, 0x00, 0x08, 0x00];
const OLE_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

export class SwContainerError extends Error {
  override name = "SwContainerError";
}

export type SwContainerKind = "zip" | "ole2" | "unknown";

export interface SwEntry {
  /** Original archive name with "/" separators, e.g. "Contents/DisplayLists". */
  name: string;
  compressedSize: number;
  size: number;
  /** Inflates the entry and checks its CRC. */
  read(): Promise<Uint8Array>;
}

export interface SwContainer {
  kind: SwContainerKind;
  entries: SwEntry[];
  /** Entry by exact name or by its last path segment ("DisplayLists"). */
  find(name: string): SwEntry | undefined;
}

const startsWith = (d: Uint8Array, at: number, sig: number[]) =>
  sig.every((b, i) => d[at + i] === b);

const indexOf = (d: Uint8Array, sig: number[], from: number) => {
  const last = d.length - sig.length;
  for (let i = from; i <= last; i++) {
    if (d[i] === sig[0] && startsWith(d, i, sig)) {
      return i;
    }
  }
  return -1;
};

const swapNibbles = (b: Uint8Array) =>
  b.map((x) => ((x & 0x0f) << 4) | (x >> 4));

const decodeName = (raw: Uint8Array) => {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch {
    return new TextDecoder("windows-1252").decode(raw);
  }
};

export const containerKind = (d: Uint8Array): SwContainerKind => {
  if (startsWith(d, 0, OLE_MAGIC)) {
    return "ole2";
  }
  if (
    d.length >= 16 &&
    d[4] === 0 &&
    d[5] === 0 &&
    d[6] === 0 &&
    d[7] === 4 &&
    indexOf(d.subarray(0, 8 + 4096), MARKER, 8) >= 0
  ) {
    return "zip";
  }
  return "unknown";
};

let crcTable: Uint32Array | undefined;
const crc32 = (d: Uint8Array) => {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < d.length; i++) {
    c = crcTable[(c ^ d[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
};

const inflateRaw = async (data: Uint8Array) => {
  const stream = new Blob([data as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
};

interface LocalHeader {
  rawName: Uint8Array;
  dataStart: number;
  compressedSize: number;
  size: number;
  crc: number;
}

/** Local header whose signature starts at `sig`, or null if the marker is missing. */
const localHeader = (
  d: Uint8Array,
  v: DataView,
  sig: number
): LocalHeader | null => {
  const m = sig + 4;
  if (m + 26 > d.length || !startsWith(d, m, MARKER)) {
    return null;
  }
  const crc = v.getUint32(m + 10, true);
  const compressedSize = v.getUint32(m + 14, true);
  const size = v.getUint32(m + 18, true);
  const nameLen = v.getUint16(m + 22, true);
  const extraLen = v.getUint16(m + 24, true);
  return {
    rawName: swapNibbles(d.subarray(m + 26, m + 26 + nameLen)),
    dataStart: m + 26 + nameLen + extraLen,
    compressedSize,
    size,
    crc,
  };
};

const sameBytes = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/** Central directory entries → local header offsets. A central entry has the marker
 *  6 bytes after its signature and points (offset +42, relative to file offset 8) at
 *  a local header with the same name. Padding cells repeat the last descriptor. */
const centralDirectory = (d: Uint8Array, v: DataView) => {
  const out: number[] = [];
  const seen = new Set<number>();
  let i = indexOf(d, MARKER, 8);
  while (i >= 0) {
    const s = i - 6;
    if (s >= 8 && i + 40 <= d.length) {
      const nameLen = v.getUint16(s + 28, true);
      const extraLen = v.getUint16(s + 30, true);
      const commentLen = v.getUint16(s + 32, true);
      const local = v.getUint32(s + 42, true) + 8;
      if (nameLen > 0 && nameLen < 1024 && local + 10 <= d.length) {
        const name = swapNibbles(d.subarray(s + 46, s + 46 + nameLen));
        const lh = localHeader(d, v, local);
        if (lh && sameBytes(lh.rawName, name)) {
          if (!seen.has(local)) {
            seen.add(local);
            out.push(local);
          }
          i = indexOf(d, MARKER, s + 46 + nameLen + extraLen + commentLen);
          continue;
        }
      }
    }
    i = indexOf(d, MARKER, i + 1);
  }
  return out;
};

const toEntry = (d: Uint8Array, lh: LocalHeader): SwEntry => ({
  name: decodeName(lh.rawName),
  compressedSize: lh.compressedSize,
  size: lh.size,
  read: async () => {
    if (lh.size === 0) {
      return new Uint8Array(0);
    }
    const raw = await inflateRaw(
      d.subarray(lh.dataStart, lh.dataStart + lh.compressedSize)
    );
    if (raw.length !== lh.size || crc32(raw) !== lh.crc) {
      throw new SwContainerError(
        `length/CRC mismatch for entry "${decodeName(lh.rawName)}"`
      );
    }
    return raw;
  },
});

/** Fallback without a central directory: every printable-named local header. */
const scanLocalHeaders = (d: Uint8Array, v: DataView) => {
  const out: LocalHeader[] = [];
  const seen = new Set<string>();
  let i = indexOf(d, MARKER, 8);
  while (i >= 0) {
    const lh = localHeader(d, v, i - 4);
    const key = lh ? decodeName(lh.rawName) : "";
    if (
      lh &&
      lh.rawName.length > 0 &&
      lh.rawName.every((b) => b >= 0x20) &&
      !seen.has(key) &&
      lh.dataStart + lh.compressedSize <= d.length
    ) {
      seen.add(key);
      out.push(lh);
      i = indexOf(d, MARKER, lh.dataStart + lh.compressedSize);
      continue;
    }
    i = indexOf(d, MARKER, i + 1);
  }
  return out;
};

export const openSwContainer = (d: Uint8Array): SwContainer => {
  const kind = containerKind(d);
  if (kind === "ole2") {
    throw new SwContainerError(
      "SolidWorks files before 2015 (OLE2 container) are not supported yet"
    );
  }
  if (kind === "unknown") {
    throw new SwContainerError("not a SolidWorks file");
  }
  const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const central = centralDirectory(d, v);
  const headers = central.length
    ? central.map((off) => localHeader(d, v, off) as LocalHeader)
    : scanLocalHeaders(d, v);
  if (!headers.length) {
    throw new SwContainerError("no readable entry in the container");
  }
  const entries = headers.map((lh) => toEntry(d, lh));
  return {
    kind,
    entries,
    find: (name) =>
      entries.find((e) => e.name === name) ??
      entries.find((e) => e.name.split("/").pop() === name),
  };
};

/** File version from the "_MO_VERSION_<n>/..." entry name, e.g. 15000 = SW 2015+. */
export const containerVersion = (c: SwContainer): number | undefined => {
  for (const e of c.entries) {
    const m = /_MO_VERSION_(\d+)/.exec(e.name);
    if (m) {
      return Number(m[1]);
    }
  }
  return undefined;
};
