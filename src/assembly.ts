import type { SwContainer } from "./container.ts";
import { buildBodyMesh, scanFaceTables } from "./displayMesh.ts";
import { readMfcUnicodeString } from "./mfc.ts";
import type { SwMesh } from "./types.ts";

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
  stream: string;
  ordinal: number;
  signature: [number, number];
}

const readCacheDirectory = (bytes: Uint8Array): CacheRecord[] | undefined => {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (v.byteLength < 12 || v.getUint32(0, true) !== 2) return;
  const count = v.getUint32(8, true);
  const records: CacheRecord[] = [];
  let offset = 12;
  for (let i = 0; i < count; i++) {
    const instance = readMfcUnicodeString(bytes, offset + 4);
    if (!instance || instance.nextOffset + 28 > bytes.length) return;
    const signatureOffset = instance.nextOffset + 20;
    const signature: [number, number] = [
      v.getUint32(signatureOffset, true),
      v.getUint32(signatureOffset + 4, true),
    ];
    const stream = readMfcUnicodeString(bytes, signatureOffset + 8);
    if (!stream || !/^\d+-\d+-\d+$/.test(stream.value) || stream.nextOffset + 20 > bytes.length) return;
    records.push({
      instance: instance.value,
      stream: stream.value,
      ordinal: v.getUint32(stream.nextOffset, true),
      signature,
    });
    offset = stream.nextOffset + 20;
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

/** Reads saved assembly instances from the embedded display caches. */
export const readAssemblyMeshes = async (
  container: SwContainer,
  displayLists: Uint8Array,
  maxVertices: number
): Promise<{ meshes: SwMesh[]; warnings: string[] }> => {
  const records = readComponentRecords(displayLists);
  const warnings: string[] = [];
  if (!records.length) {
    return { meshes: [], warnings: ["the assembly has no supported component display records"] };
  }

  let vertexCount = 0;
  const scan = (bytes: Uint8Array) => {
    const faces = scanFaceTables(bytes);
    for (const face of faces) {
      vertexCount += face.positions.length / 3;
      if (vertexCount > maxVertices) {
        throw new Error("assembly display mesh too large (" + vertexCount + " vertices)");
      }
    }
    return faces;
  };

  const inline = new Map<Component, SwMesh>();
  const inlineFaces = scan(displayLists);
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

  const directories = new Map<string, CacheRecord[]>();
  const directory = container.find("FaceTessellations/Directory");
  if (directory?.size) {
    const bytes = await directory.read().catch(() => undefined);
    const cacheRecords = bytes && readCacheDirectory(bytes);
    if (!cacheRecords) warnings.push("the assembly face tessellation directory could not be read");
    for (const record of cacheRecords ?? []) {
      const stream = directories.get(record.stream);
      if (stream) stream.push(record);
      else directories.set(record.stream, [record]);
    }
  }

  const separate = new Map<string, SwMesh | null>();
  for (const [stream, cacheRecords] of directories) {
    const entry = container.find("FaceTessellations/" + stream);
    const bytes = entry && await entry.read().catch(() => undefined);
    if (!bytes) continue;
    const { groups, nextBoundary } = indexCacheGroups(bytes, cacheRecords);
    const faces = scan(bytes);
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
    }
  }

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
