// Drawings (.SLDDRW): sheet images, the high-resolution preview bitmap and the 3D
// display meshes SolidWorks caches for the referenced models.
//
// - `Images/Sheet_<n>` are PNG images of the sheets; `SheetPreviews/SheetNames` holds
//   their names as MFC Unicode CStrings in the same order.
// - `Preview` is a u32 length followed by a Windows DIB (often RLE8), turned into a BMP.
// - `Contents/VBLists` stores one block of face tables per referenced part, in part
//   coordinates, each preceded by the part's full path as an MFC Unicode CString.
// - `swXmlContents/xmlstream-<n>` is the referenced assembly's component tree (same
//   schema as an assembly's COMPINSTANCETREE) with the placements; assemblyTree.ts reads
//   it, so component ids match those of the assembly file.
// Layout first worked out in MeKo's CAD-Viewer-Projekt (src/sw.js, parseDrawing); see
// docs/format.md.

import { fileStem, parseComponentTree, type SwComponentTree } from "./assemblyTree.ts";
import type { SwContainer } from "./container.ts";
import { buildBodyMesh, scanFaceTables, type FaceTess } from "./displayMesh.ts";
import { readMfcUnicodeString } from "./mfc.ts";
import type { SwComponentNode, SwMesh, SwSheet } from "./types.ts";

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];

export interface SwDrawingContent {
  meshes: SwMesh[];
  sheets: SwSheet[];
  components?: SwComponentNode[];
  /** BMP converted from the `Preview` DIB. */
  previewBmp?: Uint8Array;
  warnings: string[];
}

const readEntry = async (c: SwContainer, name: string) => {
  const e = c.entries.find((x) => x.name === name);
  return e?.size ? e.read() : undefined;
};

/** Every MFC Unicode CString in `bytes`, in order. */
const mfcStrings = (bytes: Uint8Array) => {
  const out: { offset: number; value: string }[] = [];
  for (let o = 0; o + 4 <= bytes.length; o++) {
    if (bytes[o] !== 0xff || bytes[o + 1] !== 0xfe || bytes[o + 2] !== 0xff) continue;
    const s = readMfcUnicodeString(bytes, o);
    if (!s) continue;
    out.push({ offset: o, value: s.value });
    o = s.nextOffset - 1;
  }
  return out;
};

/** Sheet images in sheet order, named from `SheetPreviews/SheetNames`. */
export const readSheets = async (c: SwContainer): Promise<SwSheet[]> => {
  const namesRaw = await readEntry(c, "SheetPreviews/SheetNames").catch(() => undefined);
  const names = namesRaw ? mfcStrings(namesRaw).map((s) => s.value) : [];
  const found: { index: number; image: Uint8Array }[] = [];
  for (const e of c.entries) {
    const m = /^Images\/Sheet_(\d+)$/.exec(e.name);
    if (!m || !e.size) continue;
    const image = await e.read().catch(() => undefined);
    if (image && PNG_MAGIC.every((b, i) => image[i] === b)) found.push({ index: Number(m[1]), image });
  }
  found.sort((a, b) => a.index - b.index);
  return found.map(({ index, image }) => ({ name: names[index] || `Sheet ${index + 1}`, image }));
};

/** `Preview` (u32 length + DIB) → BMP file bytes, or undefined if it is not a DIB. */
export const previewDibToBmp = (raw: Uint8Array): Uint8Array | undefined => {
  if (raw.length < 44) return;
  const v = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const off = v.getUint32(0, true) === raw.length - 4 ? 4 : 0;
  const headerSize = v.getUint32(off, true);
  if (headerSize !== 40 && headerSize !== 108 && headerSize !== 124) return;
  if (off + headerSize > raw.length) return;
  const width = v.getInt32(off + 4, true);
  const height = v.getInt32(off + 8, true);
  const bpp = v.getUint16(off + 14, true);
  const compression = v.getUint32(off + 16, true);
  if (width <= 0 || height === 0 || ![1, 4, 8, 16, 24, 32].includes(bpp)) return;
  const colors = v.getUint32(off + 32, true) || (bpp <= 8 ? 1 << bpp : 0);
  if (colors > 256) return;
  // BI_BITFIELDS with a plain BITMAPINFOHEADER: three masks follow the header.
  const masks = headerSize === 40 && compression === 3 ? 12 : 0;
  const dib = raw.subarray(off);
  const pixelOffset = 14 + headerSize + masks + 4 * colors;
  if (pixelOffset - 14 > dib.length) return;
  const bmp = new Uint8Array(14 + dib.length);
  const bv = new DataView(bmp.buffer);
  bmp[0] = 0x42; // "BM"
  bmp[1] = 0x4d;
  bv.setUint32(2, bmp.length, true);
  bv.setUint32(10, pixelOffset, true);
  bmp.set(dib, 14);
  return bmp;
};

const normalizePath = (p: string) => p.replaceAll("/", "\\").toLowerCase();

/** Face tables of `Contents/VBLists`, grouped by the part path preceding each block.
 *  A path that reappears later only references the block already stored. */
export const readPartBlocks = (bytes: Uint8Array, maxVertices: number) => {
  const faces = scanFaceTables(bytes, maxVertices);
  const paths = mfcStrings(bytes).filter((s) => /\.sldprt$/i.test(s.value));
  const blocks = new Map<string, { path: string; faces: FaceTess[] }>();
  const unassigned: FaceTess[] = [];
  let p = 0;
  let current: { path: string; faces: FaceTess[] } | undefined;
  let skipping = false;
  let ignored = 0;
  for (const face of faces) {
    while (p < paths.length && paths[p].offset < face.offset) {
      const path = paths[p++].value;
      const key = normalizePath(path);
      const known = blocks.get(key);
      skipping = !!known?.faces.length;
      current = skipping ? undefined : (known ?? { path, faces: [] });
      if (current && !known) blocks.set(key, current);
    }
    if (current) {
      current.faces.push(face);
    } else if (skipping) {
      ignored++;
      skipping = false;
    } else if (p === 0) {
      unassigned.push(face);
    }
  }
  return { blocks, unassigned, ignoredBlocks: ignored };
};

const findPart = (
  meshes: Map<string, SwMesh>,
  byStem: Map<string, SwMesh | null>,
  path: string | undefined
) => {
  if (!path) return;
  return meshes.get(normalizePath(path)) ?? byStem.get(fileStem(path).toLowerCase()) ?? undefined;
};

/** 3D meshes of a drawing: one mesh per placed part instance (shared geometry), plus
 *  every cached part that no instance uses, at its own origin. */
export const readDrawingModel = async (c: SwContainer, maxVertices: number) => {
  const warnings: string[] = [];
  const vbLists = await readEntry(c, "Contents/VBLists");
  if (!vbLists) return { meshes: [] as SwMesh[], warnings };
  const { blocks, unassigned, ignoredBlocks } = readPartBlocks(vbLists, maxVertices);
  if (ignoredBlocks) {
    warnings.push(`${ignoredBlocks} repeated part blocks in the drawing's model cache were ignored`);
  }

  const partMeshes = new Map<string, SwMesh>();
  const byStem = new Map<string, SwMesh | null>();
  for (const [key, block] of blocks) {
    const mesh = buildBodyMesh(block.faces);
    if (!mesh) continue;
    mesh.name = fileStem(block.path);
    partMeshes.set(key, mesh);
    const stem = fileStem(block.path).toLowerCase();
    byStem.set(stem, byStem.has(stem) ? null : mesh);
  }

  // A drawing of a single part has no assembly tree; its cached part is then shown at
  // its own origin.
  let tree: SwComponentTree | undefined;
  for (const e of c.entries) {
    if (!/^swXmlContents\/xmlstream/i.test(e.name) || !e.size) continue;
    const xml = await e.read().catch(() => undefined);
    tree = xml && parseComponentTree(xml);
    if (tree) break;
  }

  if (tree) warnings.push(...tree.warnings);
  const placed = tree?.leaves.filter((leaf) => !leaf.suppressed) ?? [];
  const meshes: SwMesh[] = [];
  const used = new Set<SwMesh>();
  let missing = 0;
  for (const leaf of placed) {
    const base = findPart(partMeshes, byStem, leaf.node.path);
    if (!base) {
      missing++;
      continue;
    }
    used.add(base);
    meshes.push({
      ...base,
      name: leaf.node.name,
      matrix: leaf.matrix,
      componentId: leaf.node.id,
      ...(leaf.node.hidden ? { visible: false } : {}),
    });
  }
  if (missing) {
    warnings.push(`drawing model geometry is unavailable for ${missing} of ${placed.length} part instances`);
  }
  for (const [key, mesh] of partMeshes) {
    if (used.has(mesh)) continue;
    meshes.push({ ...mesh, componentId: fileStem(blocks.get(key)!.path) });
  }
  if (!blocks.size && unassigned.length) {
    const mesh = buildBodyMesh(unassigned);
    if (mesh) meshes.push(mesh);
  }
  const components = tree?.roots.length ? tree.roots : undefined;
  return { meshes, components, warnings };
};

/** Everything a drawing contributes to the parse result. */
export const readDrawing = async (c: SwContainer, maxVertices: number): Promise<SwDrawingContent> => {
  const warnings: string[] = [];
  const sheets = await readSheets(c);
  const previewRaw = await readEntry(c, "Preview").catch(() => undefined);
  const previewBmp = previewRaw && previewDibToBmp(previewRaw);
  let model: Awaited<ReturnType<typeof readDrawingModel>> = { meshes: [], warnings: [] };
  try {
    model = await readDrawingModel(c, maxVertices);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warnings.push(`could not read the drawing's model cache: ${message}`);
  }
  warnings.push(...model.warnings);
  return { meshes: model.meshes, sheets, components: model.components, previewBmp, warnings };
};
