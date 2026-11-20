// Part color from the first "moVisualProperties_c" record: the class name is
// followed by a Windows COLORREF (bytes R, G, B, 0), 8 more bytes, and then an
// MFC Unicode CString. The body-color reader uses this name as a texture heuristic.

import type { FaceTess } from "./displayMesh.ts";
import { readMfcUnicodeString } from "./mfc.ts";
import type { Rgb } from "./types.ts";

const CLASS_NAME = new TextEncoder().encode("moVisualProperties_c");

const find = (d: Uint8Array, sig: Uint8Array) => {
  outer: for (let i = 0; i + sig.length <= d.length; i++) {
    for (let j = 0; j < sig.length; j++) {
      if (d[i + j] !== sig[j]) {
        continue outer;
      }
    }
    return i;
  }
  return -1;
};

export const readBodyColor = (stream: Uint8Array): Rgb | undefined => {
  const at = find(stream, CLASS_NAME);
  const c = at + CLASS_NAME.length;
  if (at < 0 || c + 4 > stream.length || stream[c + 3] !== 0) {
    return undefined;
  }
  const t = c + 12;
  const textured =
    t + 4 <= stream.length && stream[t] === 0xff && stream[t + 1] === 0xfe && stream[t + 2] === 0xff && stream[t + 3] > 0;
  if (textured) {
    return undefined;
  }
  return [stream[c] / 255, stream[c + 1] / 255, stream[c + 2] / 255];
};

const viewOf = (bytes: Uint8Array) =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

const readU32 = (view: DataView, at: number) =>
  at + 4 <= view.byteLength ? view.getUint32(at, true) : undefined;

const afterRealView = (bytes: Uint8Array, offset: number, version: number) => {
  // Numeric fields between the variable-length RealView strings.
  const stringOffsets = version < 0x46ba ? [8, 81, 12, 76, 4, 0, 0] : [8, 81, 12, 76];
  for (const skip of stringOffsets) {
    const field = readMfcUnicodeString(bytes, offset + skip);
    if (!field) return undefined;
    offset = field.nextOffset;
  }
  return offset + (version < 0x46ba ? 92 : 4);
};

const plainFaceColor = (bytes: Uint8Array, namesEnd: number, version: number): Rgb | undefined => {
  const view = viewOf(bytes);
  // The texture flag follows six doubles for the material's lighting properties.
  const textureAt = namesEnd + 6 * 8;
  if (readU32(view, textureAt) !== 0) return undefined;

  const extra = readMfcUnicodeString(bytes, textureAt + 4 + 5 * 4);
  if (!extra) return undefined;
  const realViewAt = extra.nextOffset + 4;
  const realViewFlag = readU32(view, realViewAt);
  if (realViewFlag !== 0 && realViewFlag !== 1) return undefined;
  const realViewEnd = realViewFlag === 1
    ? afterRealView(bytes, realViewAt + 4, version)
    : realViewAt + 4;
  if (realViewEnd === undefined) return undefined;
  const extraName = readMfcUnicodeString(bytes, realViewEnd);
  if (!extraName || readU32(view, extraName.nextOffset) !== 0) return undefined;

  return [bytes[0] / 255, bytes[1] / 255, bytes[2] / 255];
};

const readLocalAppearance = (bytes: Uint8Array, version: number): Rgb | undefined => {
  const view = viewOf(bytes);
  let appearance: { bytes: Uint8Array; namesEnd: number } | undefined;
  for (let at = 0; at + 30 <= bytes.length; at++) {
    if (bytes[at] !== 1 || view.getUint32(at, true) !== 1 || view.getUint32(at + 4, true) !== 0xffffffff) {
      continue;
    }
    const classTag = view.getUint16(at + 8, true);
    const colorAt = at + 10;
    if (classTag <= 0x8000 || classTag === 0xffff || bytes[colorAt + 3] !== 0) continue;
    const payload = bytes.subarray(colorAt);
    const name = readMfcUnicodeString(payload, 12);
    const file = name && readMfcUnicodeString(payload, name.nextOffset);
    if (!file) continue;
    if (appearance) return undefined;
    appearance = { bytes: payload, namesEnd: file.nextOffset };
  }
  return appearance && plainFaceColor(appearance.bytes, appearance.namesEnd, version);
};

const readFaceColor = (bytes: Uint8Array, version: number) => {
  const view = viewOf(bytes);
  const idEnds = new Map<string, number>();
  let hasLocalPair = false;
  let color: Rgb | undefined;
  for (let at = 0; at + 4 <= bytes.length; at++) {
    if (bytes[at] !== 0xff || bytes[at + 1] !== 0xfe || bytes[at + 2] !== 0xff) continue;
    const id = readMfcUnicodeString(bytes, at);
    if (!id) continue;
    if ((id.value.startsWith("mo") || id.value.startsWith("<")) && id.value.endsWith("\n") && id.value.includes("_c,")) {
      const idEnd = idEnds.get(id.value);
      const footer = at - 20;
      // The second copy of the face ID follows the appearance scope and node ID.
      if (idEnd !== undefined && footer >= idEnd &&
          view.getUint32(footer, true) === 1 && view.getUint32(footer + 4, true) === 0xffffffff &&
          view.getUint32(footer + 8, true) === 0 && view.getInt32(footer + 12, true) > 0 &&
          view.getUint32(footer + 16, true) === 0) {
        if (hasLocalPair) return undefined;
        hasLocalPair = true;
        color = readLocalAppearance(bytes.subarray(idEnd, footer), version);
      }
      idEnds.set(id.value, id.nextOffset);
    }
    at = id.nextOffset - 1;
  }
  return color;
};

/** Plain face overrides from the cached tessellation. Missing entries inherit the mesh color. */
export const readFaceColors = (
  stream: Uint8Array,
  faces: readonly FaceTess[],
  version: number | undefined,
) => {
  const colors = new Map<number, Rgb>();
  if (version === undefined || version < 15000 || version > 19000) return colors;
  for (let index = 0; index < faces.length; index++) {
    const face = faces[index];
    const end = faces[index + 1]?.offset ?? stream.length;
    // Three 16-byte headers, then the data for each channel through the normals.
    const start = face.offset + 3 * 16 + 4 * (face.stripLengths.length + face.positions.length + face.normals.length);
    const color = readFaceColor(stream.subarray(start, end), version);
    if (color) colors.set(index, color);
  }
  return colors;
};
