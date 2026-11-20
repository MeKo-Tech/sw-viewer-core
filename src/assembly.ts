import {
  instancePathOf,
  parseComponentTree,
  type SwComponentTree,
  type SwTreeLeaf,
} from "./assemblyTree.ts";
import type { SwContainer } from "./container.ts";
import { buildBodyMesh, scanFaceTables, type FaceTess } from "./displayMesh.ts";
import { readMfcUnicodeString } from "./mfc.ts";
import type { SwComponentNode, SwMesh } from "./types.ts";

const componentClassName = new TextEncoder().encode("uoTempAssemblySHDData_c");
const identityRotation = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const cacheGroupHeaderSize = 56;

interface Component {
  name: string;
  key: string;
  matrix: number[];
}

interface ComponentRecord {
  offset: number;
  component?: Component;
}

/** Leaf names can include the complete instance chain for a nested assembly. */
const readInstanceName = (bytes: Uint8Array, offset: number) => {
  const name = readMfcUnicodeString(bytes, offset);
  if (name?.value.split("/").every((segment) => /^.+-\d+@.+$/.test(segment))) return name;
};

const parseComponent = (
  bytes: Uint8Array,
  view: DataView,
  name: string,
  cursor: number
): Component | undefined => {
  const hasRotation = bytes[cursor++];
  if (hasRotation !== 0 && hasRotation !== 1) return;
  const translationOffset = cursor + (hasRotation ? 72 : 0);
  const transformKindOffset = translationOffset + 32;
  if (bytes[transformKindOffset] !== 0) return;
  const rotation = hasRotation
    ? Array.from({ length: 9 }, (_, i) => view.getFloat64(cursor + 8 * i, true))
    : identityRotation;
  const scale = view.getFloat64(translationOffset + 24, true);
  if (scale === 0) return;
  const matrix = [
    rotation[0] * scale, rotation[1] * scale, rotation[2] * scale, 0,
    rotation[3] * scale, rotation[4] * scale, rotation[5] * scale, 0,
    rotation[6] * scale, rotation[7] * scale, rotation[8] * scale, 0,
    view.getFloat64(translationOffset, true) * 1000,
    view.getFloat64(translationOffset + 8, true) * 1000,
    view.getFloat64(translationOffset + 16, true) * 1000,
    1,
  ];
  if (!matrix.every(Number.isFinite)) return;

  // The saved transform is followed by ten bounding-box doubles and two flags.
  const configuration = readMfcUnicodeString(bytes, transformKindOffset + 83);
  if (!configuration) return;
  const model = readMfcUnicodeString(bytes, configuration.nextOffset + 12);
  const path = model && readMfcUnicodeString(bytes, model.nextOffset);
  if (!path || !/\.sldprt$/i.test(path.value)) return;
  return {
    name,
    key: path.value.replaceAll("/", "\\").toLowerCase() + "\0" + configuration.value,
    matrix,
  };
};

const readComponentRecords = (bytes: Uint8Array): ComponentRecord[] => {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const records: ComponentRecord[] = [];
  const unrecognized: { offset: number; reference: number }[] = [];
  let classReference: number | undefined;
  const classRecordSize = 6 + componentClassName.length;
  for (let offset = 0; offset + 4 <= bytes.length; offset++) {
    if (bytes[offset] !== 0xff) continue;
    if (!records.length) {
      if (
        offset + classRecordSize >= bytes.length ||
        v.getUint16(offset, true) !== 0xffff ||
        v.getUint16(offset + 2, true) !== 1 ||
        v.getUint16(offset + 4, true) !== componentClassName.length ||
        !componentClassName.every((byte, i) => bytes[offset + 6 + i] === byte)
      ) {
        continue;
      }
      const instanceOffset = offset + classRecordSize;
      const name = readInstanceName(bytes, instanceOffset);
      const component = name && parseComponent(bytes, v, name.value, name.nextOffset);
      if (!component) return [];
      records.push({ offset: instanceOffset, component });
      offset = instanceOffset;
      continue;
    }

    if (bytes[offset + 1] !== 0xfe || bytes[offset + 2] !== 0xff) continue;
    const reference = v.getUint16(offset - 2, true);
    if (reference <= 0x8000 || reference === 0xffff) continue;
    if (classReference !== undefined && reference !== classReference) continue;
    const name = readInstanceName(bytes, offset);
    const component = name && parseComponent(bytes, v, name.value, name.nextOffset);
    // A later object references the previously declared class by its archive index.
    // An unrecognized object with that same class still marks the end of the preceding one.
    if (classReference === undefined) {
      if (!component) {
        if (name) unrecognized.push({ offset, reference });
        continue;
      }
      classReference = reference;
      for (const earlier of unrecognized) {
        if (earlier.reference === reference) records.push({ offset: earlier.offset });
      }
    }
    records.push({ offset, component });
  }
  if (classReference === undefined && unrecognized.length) {
    records.push({ offset: unrecognized[0].offset });
  }
  return records;
};

interface CacheRecord {
  instance: string;
  /** Empty for a row that reuses another row's geometry (`reference`). */
  stream: string;
  ordinal: number;
  signature: [number, number];
  /** Signature of the row whose geometry a repeated instance reuses. */
  reference?: [number, number];
}

/** Ordinal of a directory row without its own face group. */
const NO_GROUP = 0xffffffff;
const MAX_DIRECTORY_ITEMS = 4096;

const readCacheDirectory = (bytes: Uint8Array): CacheRecord[] | undefined => {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (v.byteLength < 12 || v.getUint32(0, true) !== 2) return;
  const count = v.getUint32(8, true);
  const records: CacheRecord[] = [];
  let offset = 12;
  for (let i = 0; i < count; i++) {
    const instance = readMfcUnicodeString(bytes, offset + 4);
    if (!instance || instance.nextOffset + 28 > bytes.length) return;
    const referenceOffset = instance.nextOffset + 12;
    const reference: [number, number] = [v.getUint32(referenceOffset, true), v.getUint32(referenceOffset + 4, true)];
    const signatureOffset = instance.nextOffset + 20;
    const signature: [number, number] = [
      v.getUint32(signatureOffset, true),
      v.getUint32(signatureOffset + 4, true),
    ];
    const stream = readMfcUnicodeString(bytes, signatureOffset + 8);
    if (!stream || stream.nextOffset + 8 > bytes.length) return;
    const ordinal = v.getUint32(stream.nextOffset, true);
    // Then a count of 12-byte items; rows of repeated instances and patterns have
    // no stream, no group (ordinal NO_GROUP) and sometimes no items.
    const items = v.getUint32(stream.nextOffset + 4, true);
    if (items > MAX_DIRECTORY_ITEMS) return;
    const next = stream.nextOffset + 8 + 12 * items;
    if (next > bytes.length) return;
    if (stream.value) {
      if (!/^\d+-\d+-\d+$/.test(stream.value) || ordinal === NO_GROUP) return;
      records.push({ instance: instance.value, stream: stream.value, ordinal, signature });
    } else if (ordinal === NO_GROUP && (reference[0] || reference[1])) {
      records.push({ instance: instance.value, stream: "", ordinal, signature, reference });
    } else if (ordinal !== NO_GROUP) return;
    offset = next;
  }
  return records;
};

const cacheKey = (ordinal: number, first: number, second: number) => [ordinal, first, second].join(":");

/** Groups in a cache stream can appear in a different order from the directory rows. */
const indexCacheGroups = (bytes: Uint8Array, records: CacheRecord[]) => {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ordinals = new Set(records.map((record) => record.ordinal));
  const lowBytes = new Set(records.map((record) => record.ordinal & 0xff));
  const keys = new Set(records.map((record) => cacheKey(record.ordinal, ...record.signature)));
  const groups = new Map<string, { start: number; count: number } | null>();
  const nextBoundary = new Map<number, number>();
  let previousStart: number | undefined;
  for (let offset = 0; offset + cacheGroupHeaderSize <= bytes.length; offset++) {
    if (!lowBytes.has(bytes[offset])) continue;
    const ordinal = v.getUint32(offset, true);
    if (!ordinals.has(ordinal)) continue;
    const key = cacheKey(ordinal, v.getUint32(offset + 4, true), v.getUint32(offset + 8, true));
    if (!keys.has(key)) continue;
    if (previousStart !== undefined) nextBoundary.set(previousStart, offset);
    const start = offset + cacheGroupHeaderSize;
    previousStart = start;
    groups.set(key, groups.has(key) ? null : {
      start,
      count: v.getUint32(offset + 12, true),
    });
  }
  return { groups, nextBoundary };
};

const recordMesh = <Key>(meshes: Map<Key, SwMesh | null>, key: Key, mesh: SwMesh) => {
  if (!meshes.has(key)) meshes.set(key, mesh);
  else if (meshes.get(key) !== mesh) meshes.set(key, null);
};

const TESSELLATION_PREFIX = "FaceTessellations/";
const DIRECTORY = TESSELLATION_PREFIX + "Directory";

/** Scans face tables against one vertex budget for the whole assembly; streams are scanned once. */
class FaceScanner {
  private vertexCount = 0;
  private readonly streams = new Map<string, FaceTess[]>();
  private readonly maxVertices: number;
  constructor(maxVertices: number) {
    this.maxVertices = maxVertices;
  }

  scan(bytes: Uint8Array, name?: string) {
    const known = name === undefined ? undefined : this.streams.get(name);
    if (known) return known;
    const faces = scanFaceTables(bytes);
    for (const face of faces) {
      this.vertexCount += face.positions.length / 3;
      if (this.vertexCount > this.maxVertices) {
        throw new Error("assembly display mesh too large (" + this.vertexCount + " vertices)");
      }
    }
    if (name !== undefined) this.streams.set(name, faces);
    return faces;
  }
}

interface DisplayCaches {
  records: ComponentRecord[];
  /** Meshes stored inline after a placement record in `Contents/DisplayLists`. */
  inline: Map<Component, SwMesh>;
  /** Meshes from separate cache streams by directory instance name; null when ambiguous. */
  separate: Map<string, SwMesh | null>;
  warnings: string[];
}

/** Reads the meshes of the embedded display caches (DisplayLists and FaceTessellations). */
const readDisplayCaches = async (
  container: SwContainer,
  displayLists: Uint8Array | undefined,
  scanner: FaceScanner
): Promise<DisplayCaches> => {
  const warnings: string[] = [];
  const records = displayLists ? readComponentRecords(displayLists) : [];

  const inline = new Map<Component, SwMesh>();
  if (displayLists && records.length) {
    const inlineFaces = scanner.scan(displayLists);
    let faceIndex = 0;
    for (const [i, record] of records.entries()) {
      while (faceIndex < inlineFaces.length && inlineFaces[faceIndex].offset < record.offset) faceIndex++;
      const firstFace = faceIndex;
      const limit = records[i + 1]?.offset ?? displayLists.length;
      while (faceIndex < inlineFaces.length && inlineFaces[faceIndex].offset < limit) faceIndex++;
      if (!record.component || firstFace === faceIndex) continue;
      const mesh = buildBodyMesh(inlineFaces.slice(firstFace, faceIndex));
      if (mesh?.indices.length) inline.set(record.component, mesh);
    }
  }

  const directories = new Map<string, CacheRecord[]>();
  const references: CacheRecord[] = [];
  const directory = container.find(DIRECTORY);
  if (directory?.size) {
    const bytes = await directory.read().catch(() => undefined);
    const cacheRecords = bytes && readCacheDirectory(bytes);
    if (!cacheRecords) warnings.push("the assembly face tessellation directory could not be read");
    for (const record of cacheRecords ?? []) {
      if (!record.stream) {
        references.push(record);
        continue;
      }
      const stream = directories.get(record.stream);
      if (stream) stream.push(record);
      else directories.set(record.stream, [record]);
    }
  }

  const separate = new Map<string, SwMesh | null>();
  const bySignature = new Map<string, SwMesh | null>();
  for (const [stream, cacheRecords] of directories) {
    const name = TESSELLATION_PREFIX + stream;
    const entry = container.find(name);
    const bytes = entry && await entry.read().catch(() => undefined);
    if (!bytes) continue;
    const { groups, nextBoundary } = indexCacheGroups(bytes, cacheRecords);
    const faces = scanner.scan(bytes, name);
    const firstFaceByOffset = new Map(faces.map((face, i) => [face.offset, i]));
    const decoded = new Map<string, SwMesh>();
    for (const record of cacheRecords) {
      const key = cacheKey(record.ordinal, ...record.signature);
      const group = groups.get(key);
      if (!group || !group.count) continue;
      const firstFace = firstFaceByOffset.get(group.start);
      if (firstFace === undefined) continue;
      const endFace = firstFace + group.count;
      const limit = nextBoundary.get(group.start) ?? bytes.length;
      if (endFace > faces.length || faces[endFace - 1].offset >= limit) continue;
      const mesh = decoded.get(key) ?? buildBodyMesh(faces.slice(firstFace, endFace));
      if (!mesh?.indices.length) continue;
      decoded.set(key, mesh);
      recordMesh(separate, record.instance, mesh);
      recordMesh(bySignature, record.signature.join(":"), mesh);
    }
  }
  // Repeated instances point at the row that stores their geometry.
  for (const record of references) {
    const mesh = bySignature.get(record.reference!.join(":"));
    if (mesh) recordMesh(separate, record.instance, mesh);
  }
  return { records, inline, separate, warnings };
};

/** Reads saved assembly instances from the embedded display caches (no component tree). */
export const readAssemblyMeshes = async (
  container: SwContainer,
  displayLists: Uint8Array,
  maxVertices: number
): Promise<{ meshes: SwMesh[]; warnings: string[] }> => {
  if (!readComponentRecords(displayLists).length) {
    return { meshes: [], warnings: ["the assembly has no supported component display records"] };
  }
  const { records, inline, separate, warnings } = await readDisplayCaches(
    container,
    displayLists,
    new FaceScanner(maxVertices)
  );

  const reusable = new Map<string, SwMesh | null>();
  const placed = new Map<Component, SwMesh>();
  for (const { component } of records) {
    if (!component) continue;
    const cached = inline.get(component) ?? separate.get(component.name);
    if (!cached) continue;
    placed.set(component, cached);
    recordMesh(reusable, component.key, cached);
  }

  const meshes: SwMesh[] = [];
  for (const { component } of records) {
    if (!component) continue;
    const cached = placed.get(component) ?? reusable.get(component.key);
    if (cached) meshes.push({ ...cached, name: component.name, matrix: component.matrix });
  }
  const missing = records.length - meshes.length;
  if (missing) {
    warnings.push("assembly display geometry is unavailable for " + missing + " of " + records.length + " components");
  }
  return { meshes, warnings };
};

const textOf = (bytes: Uint8Array, alignment: number) =>
  new TextDecoder("utf-16le").decode(bytes.subarray(alignment, alignment + ((bytes.length - alignment) & ~1)));

/**
 * Part keys in the order the cache streams store their bodies, from the instance names
 * in `FaceTessellations/Directory` (ported from CAD-Viewer-Projekt). An instance only
 * counts when a stream name follows it, so rows reusing other geometry are skipped.
 * Files saved as a copy keep the old assembly name, so a second pass matches the
 * instance name alone.
 */
export const directoryOrder = (directory: Uint8Array, componentKeys: Map<string, string>) => {
  const entries = [...componentKeys].map(([key, partKey]) => {
    const bar = key.indexOf("|");
    return { assembly: key.slice(0, bar), instance: key.slice(bar + 1), partKey };
  });
  // Every needle is `instance@…`: one sweep over the "@" signs, looking up the text
  // before each one by instance length, finds all occurrences of all entries.
  const byInstance = new Map<string, number[]>();
  entries.forEach(({ instance }, k) => {
    const list = byInstance.get(instance);
    if (list) list.push(k);
    else byInstance.set(instance, [k]);
  });
  const lengths = [...new Set(entries.map((e) => e.instance.length))];
  for (const alignment of [0, 1]) {
    const text = textOf(directory, alignment);
    const hits: { start: number; end: number; partKey: string }[] = [];
    /** Occurrences of `instance@` per entry, for the instance-only pass. */
    const loose: { entry: number; start: number; at: number }[] = [];
    for (let at = text.indexOf("@"); at >= 0; at = text.indexOf("@", at + 1)) {
      for (const len of lengths) {
        if (len > at) continue;
        const list = byInstance.get(text.slice(at - len, at));
        if (!list) continue;
        for (const k of list) {
          const { assembly, partKey } = entries[k];
          loose.push({ entry: k, start: at - len, at });
          const end = at + 1 + assembly.length;
          if (text.startsWith(assembly, at + 1) && text[end] !== "/") hits.push({ start: at - len, end, partKey });
        }
      }
    }
    // Second pass in the former order (entry by entry, left to right): an occurrence
    // inside an earlier hit does not count.
    loose.sort((a, b) => a.entry - b.entry || a.start - b.start);
    const covered = new Uint8Array(text.length + 1);
    const cover = (start: number, end: number) => covered.fill(1, start, end);
    for (const h of hits) cover(h.start, h.end);
    const nameEnd = new Map<number, number>();
    for (const { entry, start, at } of loose) {
      if (covered[start]) continue;
      let end = nameEnd.get(at);
      if (end === undefined) {
        end = at + 1;
        while (end < text.length && /[\p{L}\p{N} _.-]/u.test(text[end])) end++;
        nameEnd.set(at, end);
      }
      if (text[end] !== "/") {
        hits.push({ start, end, partKey: entries[entry].partKey });
        cover(start, end);
      }
    }
    hits.sort((a, b) => a.start - b.start || b.end - a.end);
    const unique = hits.filter((h, j) => j === 0 || h.start !== hits[j - 1].start);
    const order: string[] = [];
    unique.forEach((h, j) => {
      const next = unique[j + 1]?.start ?? text.length;
      if (/\d{3}-\d{3}-\d{3}/.test(text.slice(h.end, next))) order.push(h.partKey);
    });
    if (order.length) return order;
  }
  return [];
};

/** Body headers in a cache stream: index of the body whose faces follow. */
const bodyHeaders = (bytes: Uint8Array, faceCount: number) => {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const heads: { offset: number; index: number }[] = [];
  for (let o = 20; o + 20 <= bytes.length; o++) {
    if (bytes[o] !== 1) continue;
    if (v.getUint32(o, true) !== 1 || v.getUint32(o + 4, true) !== 1 || v.getUint32(o + 8, true) !== 0 || v.getUint32(o + 12, true) !== 0) continue;
    if (bytes[o + 16] !== 0x96 || bytes[o + 18] !== 0x20 || bytes[o + 19] !== 0) continue;
    const index = v.getUint32(o - 20, true);
    const count = v.getUint32(o - 8, true);
    if (index >= 1 && count >= 1 && count <= faceCount) heads.push({ offset: o, index });
  }
  return heads;
};

/**
 * Fallback when the directory rows cannot be paired with cache groups: faces of every
 * `FaceTessellations/*` stream are assigned to bodies by the body headers, and bodies to
 * parts by the directory order (or, without a directory, by the order in which parts
 * first appear in the tree). Ported from CAD-Viewer-Projekt (`parseAssembly`).
 */
export const facesByDirectoryOrder = (
  streams: { name: string; bytes: Uint8Array; faces: FaceTess[] }[],
  directory: Uint8Array | undefined,
  tree: Pick<SwComponentTree, "componentKeys" | "leaves">
) => {
  let order = directory ? directoryOrder(directory, tree.componentKeys) : [];
  if (!order.length) {
    order = [...new Set(tree.leaves.filter((leaf) => !leaf.suppressed).map((leaf) => leaf.partKey))];
  }
  const faces = new Map<string, FaceTess[]>();
  let body = 0;
  for (const stream of [...streams].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const heads = bodyHeaders(stream.bytes, stream.faces.length);
    // Without body headers, all faces would land on one part; only safe when one is left.
    if (!heads.length && order.length - body > 1) {
      body++;
      continue;
    }
    let current = 0;
    let h = 0;
    for (const face of stream.faces) {
      while (h < heads.length && heads[h].offset < face.offset) current = heads[h++].index;
      const key = order[body + current];
      if (key === undefined) continue;
      const list = faces.get(key);
      if (list) list.push(face);
      else faces.set(key, [face]);
    }
    body += heads.reduce((max, head) => Math.max(max, head.index), 0) + 1;
  }
  return faces;
};

const filePathOf = (partKey: string) => partKey.slice(0, partKey.lastIndexOf("|")).toLowerCase();

/** Places the tree's part instances with meshes from the display caches. */
const placeTreeInstances = async (
  container: SwContainer,
  displayLists: Uint8Array | undefined,
  tree: SwComponentTree,
  scanner: FaceScanner
) => {
  const caches = await readDisplayCaches(container, displayLists, scanner);
  const byPath = new Map<string, SwMesh | null>();
  for (const [component, mesh] of caches.inline) recordMesh(byPath, instancePathOf(component.name), mesh);
  for (const [instance, mesh] of caches.separate) if (mesh) recordMesh(byPath, instancePathOf(instance), mesh);

  const rendered = tree.leaves.filter((leaf) => !leaf.suppressed);
  const meshOf = new Map<SwTreeLeaf, SwMesh>();
  const byPart = new Map<string, SwMesh>();
  for (const leaf of rendered) {
    const mesh = byPath.get(leaf.node.id);
    if (!mesh) continue;
    meshOf.set(leaf, mesh);
    if (!byPart.has(leaf.partKey)) byPart.set(leaf.partKey, mesh);
  }
  for (const leaf of rendered) {
    const mesh = !meshOf.has(leaf) && byPart.get(leaf.partKey);
    if (mesh) meshOf.set(leaf, mesh);
  }

  let fallbackUsed = false;
  if (rendered.some((leaf) => !meshOf.has(leaf))) {
    const streams = [];
    for (const entry of container.entries) {
      if (!entry.name.startsWith(TESSELLATION_PREFIX) || entry.name === DIRECTORY || !entry.size) continue;
      const bytes = await entry.read().catch(() => undefined);
      if (bytes) streams.push({ name: entry.name, bytes, faces: scanner.scan(bytes, entry.name) });
    }
    if (streams.length) {
      const directory = container.find(DIRECTORY);
      const directoryBytes = directory?.size ? await directory.read().catch(() => undefined) : undefined;
      const faces = facesByDirectoryOrder(streams, directoryBytes, tree);
      const built = new Map<string, SwMesh | null>();
      const build = (key: string, list: FaceTess[]) => {
        if (!built.has(key)) {
          const mesh = buildBodyMesh(list);
          built.set(key, mesh?.indices.length ? mesh : null);
        }
        return built.get(key);
      };
      const byFile = new Map<string, string>();
      for (const key of faces.keys()) if (!byFile.has(filePathOf(key))) byFile.set(filePathOf(key), key);
      for (const leaf of rendered) {
        if (meshOf.has(leaf)) continue;
        const key = faces.has(leaf.partKey) ? leaf.partKey : byFile.get(filePathOf(leaf.partKey));
        const mesh = key && build(key, faces.get(key)!);
        if (mesh) {
          meshOf.set(leaf, mesh);
          fallbackUsed = true;
        }
      }
    }
  }

  const meshes: SwMesh[] = [];
  for (const leaf of rendered) {
    const mesh = meshOf.get(leaf);
    if (!mesh) continue;
    meshes.push({
      ...mesh,
      name: leaf.node.name,
      matrix: leaf.matrix,
      componentId: leaf.node.id,
      ...(leaf.node.hidden ? { visible: false } : {}),
    });
  }
  const warnings = [...tree.warnings];
  const missing = rendered.length - meshes.length;
  if (missing) {
    warnings.push(...caches.warnings);
    warnings.push("assembly display geometry is unavailable for " + missing + " of " + rendered.length + " components");
  } else if (fallbackUsed) {
    warnings.push("assembly meshes were matched to components by the cache directory order");
  }
  return { meshes, warnings };
};

/**
 * Reads an assembly: instances from the component tree (`swXmlContents/COMPINSTANCETREE`)
 * when present, meshes from the embedded display caches. Without a usable tree, the
 * placements stored with the caches are used.
 */
export const readAssembly = async (
  container: SwContainer,
  displayLists: Uint8Array | undefined,
  maxVertices: number
): Promise<{ meshes: SwMesh[]; components?: SwComponentNode[]; warnings: string[] }> => {
  const treeEntry = container.find("swXmlContents/COMPINSTANCETREE");
  const treeBytes = treeEntry?.size ? await treeEntry.read().catch(() => undefined) : undefined;
  const tree = treeBytes && parseComponentTree(treeBytes);
  if (!tree || !tree.roots.length) {
    const warnings = treeBytes ? ["the assembly component tree could not be read"] : [];
    if (!displayLists) return { meshes: [], warnings };
    const legacy = await readAssemblyMeshes(container, displayLists, maxVertices);
    return { meshes: legacy.meshes, warnings: [...warnings, ...legacy.warnings] };
  }
  const placed = await placeTreeInstances(container, displayLists, tree, new FaceScanner(maxVertices));
  if (!placed.meshes.length && displayLists && tree.leaves.some((leaf) => !leaf.suppressed)) {
    // The tree did not match the caches at all; fall back to the cache placements.
    const legacy = await readAssemblyMeshes(container, displayLists, maxVertices);
    if (legacy.meshes.length) {
      return {
        meshes: legacy.meshes,
        components: tree.roots,
        warnings: [...placed.warnings, "assembly meshes are placed without the component tree", ...legacy.warnings],
      };
    }
  }
  return { meshes: placed.meshes, components: tree.roots, warnings: placed.warnings };
};
