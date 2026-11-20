// Drawings (.SLDDRW): sheet images, the high-resolution preview bitmap and the 3D
// display meshes SolidWorks caches for the referenced models.
//
// - `Images/Sheet_<n>` are PNG images of the sheets; `SheetPreviews/SheetNames` holds
//   their names as MFC Unicode CStrings in the same order.
// - `Preview` is a u32 length followed by a Windows DIB (often RLE8), turned into a BMP.
// - `Contents/VBLists` stores one block of face tables per referenced part, in part
//   coordinates, each preceded by the part's full path as an MFC Unicode CString.
// - `swXmlContents/xmlstream-<n>` is the referenced assembly's component tree (same
//   schema as an assembly's COMPINSTANCETREE) with the placements.
// Layout first worked out in MeKo's CAD-Viewer-Projekt (src/sw.js, parseDrawing); see
// docs/format.md.

import type { SwContainer } from "./container.ts";
import { buildBodyMesh, scanFaceTables, type FaceTess } from "./displayMesh.ts";
import { readMfcUnicodeString } from "./mfc.ts";
import type { SwComponentNode, SwMesh, SwSheet } from "./types.ts";
import { findAll, parseXml, type XmlElement } from "./xml.ts";

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const M_TO_MM = 1000;
/** Cap on component nodes, so a crafted tree that references a sub-assembly many times
 *  per level cannot expand exponentially. */
const MAX_COMPONENTS = 100_000;

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
const stemOf = (p: string) => p.split(/[\\/]/).pop()!.replace(/\.[^.]+$/, "");

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

/** Column-major 4×4 product a·b. */
const multiply = (a: number[], b: number[]) => {
  const out = new Array<number>(16).fill(0);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      out[c * 4 + r] = s;
    }
  }
  return out;
};

/** `swTransform`: 16 numbers that read directly as a column-major 4×4 matrix (rotation
 *  columns with a 0 each, translation in metres, 1), the same layout as the placements
 *  in an assembly's DisplayLists. */
const parseTransform = (attr: string | undefined) => {
  const t = (attr ?? "").trim().split(/\s+/).map(Number);
  if (t.length !== 16 || !t.every(Number.isFinite)) return IDENTITY;
  const m = t.slice();
  m[12] *= M_TO_MM;
  m[13] *= M_TO_MM;
  m[14] *= M_TO_MM;
  m[3] = m[7] = m[11] = 0;
  m[15] = 1;
  return m;
};

interface Instance {
  node: SwComponentNode;
  matrix: number[];
  hidden: boolean;
}

/** Component tree and leaf part placements from the drawing's xmlstream. */
export const readReferencedTree = (root: XmlElement) => {
  const files = new Map<string, { path: string; type: string }>();
  for (const f of findAll(root, "swFile")) {
    files.set(f.attributes.id, { path: f.attributes.swPath ?? "", type: f.attributes.swDocType ?? "" });
  }
  const models = new Map<string, XmlElement>();
  for (const m of findAll(root, "swModel")) models.set(m.attributes.id, m);
  const referenced = new Set<string>();
  for (const m of models.values()) {
    for (const r of m.children) if (r.localName === "swReference") referenced.add(r.attributes.swModelRef);
  }

  const leaves: Instance[] = [];
  const usedIds = new Set<string>();
  let truncated = false;
  const uniqueId = (id: string) => {
    let out = id;
    for (let n = 2; usedIds.has(out); n++) out = `${id}#${n}`;
    usedIds.add(out);
    return out;
  };
  const walk = (
    model: XmlElement,
    parent: number[],
    prefix: string,
    hiddenAbove: boolean,
    depth: number,
    ancestors: Set<string>
  ): SwComponentNode[] => {
    const nodes: SwComponentNode[] = [];
    for (const r of model.children) {
      if (r.localName !== "swReference") continue;
      if (usedIds.size >= MAX_COMPONENTS) {
        truncated = true;
        break;
      }
      const a = r.attributes;
      const sub = models.get(a.swModelRef);
      const file = files.get(sub?.attributes.swFileRef ?? "");
      const name = `${a.swComponentName ?? a.swName ?? "?"}-${a.swReferenceNumber ?? "1"}`;
      const suppressed = a.swSuppressed === "YES";
      const hidden = hiddenAbove || a.swHidden === "YES";
      const matrix = multiply(parent, parseTransform(a.swTransform));
      const isAssembly =
        file?.type === "ASSEMBLY" || !!sub?.children.some((c) => c.localName === "swReference");
      const node: SwComponentNode = {
        id: uniqueId(prefix + name),
        name,
        path: file?.path || undefined,
        configuration: a.swConfigurationName || undefined,
        kind: isAssembly ? "assembly" : "part",
        hidden,
        suppressed,
        children: [],
      };
      nodes.push(node);
      const key = a.swModelRef;
      if (isAssembly) {
        if (sub && !suppressed && depth < 64 && !ancestors.has(key)) {
          node.children = walk(sub, matrix, `${prefix}${name}/`, hidden, depth + 1, new Set([...ancestors, key]));
        }
      } else if (!suppressed) {
        leaves.push({ node, matrix, hidden });
      }
    }
    return nodes;
  };

  // Root assemblies: models with references that no other model references. A drawing
  // of a single part has none; its cached part is then shown at its own origin.
  const components: SwComponentNode[] = [];
  for (const [id, m] of models) {
    if (!referenced.has(id) && m.children.some((c) => c.localName === "swReference")) {
      components.push(...walk(m, IDENTITY, "", false, 0, new Set([id])));
    }
  }
  return { components, leaves, truncated };
};

const findPart = (
  meshes: Map<string, SwMesh>,
  byStem: Map<string, SwMesh | null>,
  path: string | undefined
) => {
  if (!path) return;
  return meshes.get(normalizePath(path)) ?? byStem.get(stemOf(path).toLowerCase()) ?? undefined;
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
    mesh.name = stemOf(block.path);
    partMeshes.set(key, mesh);
    const stem = stemOf(block.path).toLowerCase();
    byStem.set(stem, byStem.has(stem) ? null : mesh);
  }

  let tree: ReturnType<typeof readReferencedTree> | undefined;
  for (const e of c.entries) {
    if (!/^swXmlContents\/xmlstream/i.test(e.name) || !e.size) continue;
    const xml = await e.read().catch(() => undefined);
    const root = xml && parseXml(xml);
    if (root && findAll(root, "swModel").length) {
      tree = readReferencedTree(root);
      break;
    }
  }

  if (tree?.truncated) {
    warnings.push(`the drawing's component tree was cut off at ${MAX_COMPONENTS} components`);
  }
  const meshes: SwMesh[] = [];
  const used = new Set<SwMesh>();
  let missing = 0;
  for (const leaf of tree?.leaves ?? []) {
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
      ...(leaf.hidden ? { visible: false } : {}),
    });
  }
  if (missing) {
    warnings.push(`drawing model geometry is unavailable for ${missing} of ${tree!.leaves.length} part instances`);
  }
  for (const [key, mesh] of partMeshes) {
    if (used.has(mesh)) continue;
    meshes.push({ ...mesh, componentId: stemOf(blocks.get(key)!.path) });
  }
  if (!blocks.size && unassigned.length) {
    const mesh = buildBodyMesh(unassigned);
    if (mesh) meshes.push(mesh);
  }
  const components = tree?.components.length ? tree.components : undefined;
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
