// Component tree of an assembly from `swXmlContents/COMPINSTANCETREE`.
// The algorithm (model lookup, transform composition, hidden propagation, no expansion
// of suppressed sub-assemblies) is ported from MeKo's CAD-Viewer-Projekt (`src/sw.js`,
// `parseAssembly`). Layout notes: docs/format.md, "Assembly display caches".

import type { SwComponentNode } from "./types.ts";
import { parseXml, type XmlElement } from "./xml.ts";

/** One part instance of the tree, with what the mesh mapping needs. */
export interface SwTreeLeaf {
  node: SwComponentNode;
  /** Column-major 4×4 world transform in millimetres (the `SwMesh.matrix` convention). */
  matrix: number[];
  /** Referenced part document and configuration, `path|configuration`. */
  partKey: string;
  /** true when the instance or one of its parents is suppressed. */
  suppressed: boolean;
}

export interface SwComponentTree {
  roots: SwComponentNode[];
  /** Part instances in tree order, suppressed ones included. */
  leaves: SwTreeLeaf[];
  /**
   * `assembly file stem|instance name` → part key for every part reference of every
   * assembly model in the file; the cache directory names instances `Name-N@Assembly`.
   */
  componentKeys: Map<string, string>;
  warnings: string[];
}

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
/** Nesting limit; deeper trees are cut off (cyclic model references end here too). */
const MAX_TREE_DEPTH = 64;
/** Instance limit, so a crafted tree with shared sub-assemblies cannot explode. */
const MAX_TREE_NODES = 100_000;

const isYes = (value: string | undefined) => /^(yes|true|1)$/i.test(value?.trim() ?? "");

/** File name without folder and extension; SolidWorks names assemblies by it. */
export const fileStem = (path: string | undefined) =>
  (path ?? "").split(/[\\/]/).pop()!.replace(/\.[^.]*$/, "");

/** Column-major product `a · b`. */
export const multiplyMatrices = (a: number[], b: number[]) => {
  const out = new Array<number>(16);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[4 * k + row] * b[4 * col + k];
      out[4 * col + row] = sum;
    }
  }
  return out;
};

/**
 * `swTransform` holds 16 numbers in the row-vector convention: rows 0–2 the rotation,
 * row 3 the translation in metres, the last value the scale. Read in order, the rows
 * of that matrix are the columns of a column-major matrix acting on column vectors, so
 * only units and scale need converting. Returns undefined for malformed values.
 */
export const transformFromXml = (value: string | undefined): number[] | undefined => {
  const t = (value ?? "").trim().split(/\s+/).map(Number);
  if (t.length !== 16 || !t.every(Number.isFinite)) return;
  const scale = t[15] || 1;
  return [
    t[0] * scale, t[1] * scale, t[2] * scale, 0,
    t[4] * scale, t[5] * scale, t[6] * scale, 0,
    t[8] * scale, t[9] * scale, t[10] * scale, 0,
    t[12] * 1000, t[13] * 1000, t[14] * 1000, 1,
  ];
};

/** Parses the tree; undefined when the stream is not a usable COMPINSTANCETREE. */
export const parseComponentTree = (input: Uint8Array | string): SwComponentTree | undefined => {
  let doc: XmlElement | undefined;
  try {
    doc = parseXml(input);
  } catch {
    return;
  }
  if (!doc) return;
  const warnings: string[] = [];

  const files = new Map<string, { path: string; type: string }>();
  let rootFileId: string | undefined;
  const models: XmlElement[] = [];
  const configurations: XmlElement[] = [];
  const walkDoc = (el: XmlElement) => {
    for (const c of el.children) {
      if (c.localName === "swFile") {
        const id = c.attributes.id;
        if (id !== undefined && !files.has(id)) {
          files.set(id, { path: c.attributes.swPath ?? "", type: (c.attributes.swDocType ?? "").toUpperCase() });
          rootFileId ??= id;
        }
      } else if (c.localName === "swModel") models.push(c);
      else if (c.localName === "swConfiguration") configurations.push(c);
      // swReference elements live inside swModel; no need to descend into models.
      if (c.localName !== "swModel") walkDoc(c);
    }
  };
  walkDoc(doc);

  const references = (m: XmlElement) => m.children.filter((c) => c.localName === "swReference");
  const modelById = new Map<string, XmlElement>();
  for (const m of models) if (m.attributes.id !== undefined) modelById.set(m.attributes.id, m);
  // One assembly model (the one listing the components) per referenced file.
  const asmModelByFile = new Map<string, XmlElement>();
  for (const m of models) {
    const fileRef = m.attributes.swFileRef;
    if (fileRef !== undefined && references(m).length && !asmModelByFile.has(fileRef)) asmModelByFile.set(fileRef, m);
  }
  const fileOf = (m: XmlElement | undefined) => files.get(m?.attributes.swFileRef ?? "") ?? { path: "", type: "" };
  const asmModelOf = (m: XmlElement | undefined) =>
    m && (references(m).length ? m : asmModelByFile.get(m.attributes.swFileRef ?? ""));

  const active = configurations.find((c) => isYes(c.attributes.swMostRecentConfiguration)) ?? configurations[0];
  const activeModel = asmModelOf(modelById.get(active?.attributes.swModelRef ?? ""));
  const root =
    (activeModel && activeModel.attributes.swFileRef === rootFileId ? activeModel : undefined) ??
    asmModelByFile.get(rootFileId ?? "") ??
    [...asmModelByFile.values()].pop();
  if (!root) return;

  const partKeyOf = (r: XmlElement) =>
    fileOf(modelById.get(r.attributes.swModelRef ?? "")).path + "|" + (r.attributes.swConfigurationName ?? "");
  const instanceName = (r: XmlElement) => {
    const name = r.attributes.swComponentName || r.attributes.swName || "Component";
    const number = r.attributes.swReferenceNumber;
    return number ? name + "-" + number : name;
  };

  const componentKeys = new Map<string, string>();
  for (const [fileId, m] of asmModelByFile) {
    const stem = fileStem(files.get(fileId)?.path);
    for (const r of references(m)) {
      const sub = modelById.get(r.attributes.swModelRef ?? "");
      if (fileOf(sub).type === "ASSEMBLY" || (sub && references(sub).length)) continue;
      componentKeys.set(stem + "|" + instanceName(r), partKeyOf(r));
    }
  }

  const leaves: SwTreeLeaf[] = [];
  const ids = new Set<string>();
  let nodeCount = 0;
  let malformed = 0;
  let truncated = false;
  const walk = (
    model: XmlElement,
    parentMatrix: number[],
    prefix: string,
    depth: number,
    hiddenUp: boolean,
    stack: Set<XmlElement>
  ): SwComponentNode[] => {
    const out: SwComponentNode[] = [];
    for (const r of references(model)) {
      if (++nodeCount > MAX_TREE_NODES) {
        truncated = true;
        break;
      }
      const sub = modelById.get(r.attributes.swModelRef ?? "");
      const file = fileOf(sub);
      const name = instanceName(r);
      let id = prefix + name;
      for (let n = 2; ids.has(id); n++) id = prefix + name + "#" + n;
      ids.add(id);
      const local = transformFromXml(r.attributes.swTransform);
      if (!local) malformed++;
      const matrix = multiplyMatrices(parentMatrix, local ?? IDENTITY);
      const suppressed = isYes(r.attributes.swSuppressed);
      const hidden = hiddenUp || isYes(r.attributes.swHidden);
      const configuration = r.attributes.swConfigurationName || undefined;
      const subAssembly = file.type === "ASSEMBLY" ? asmModelOf(sub) : sub && references(sub).length ? sub : undefined;
      const node: SwComponentNode = {
        id,
        name,
        ...(file.path ? { path: file.path } : {}),
        ...(configuration ? { configuration } : {}),
        kind: file.type === "ASSEMBLY" || subAssembly ? "assembly" : "part",
        hidden,
        suppressed,
        children: [],
      };
      out.push(node);
      if (node.kind === "assembly") {
        // Suppressed sub-assemblies are not expanded: their saved tree may be stale.
        if (subAssembly && !suppressed) {
          if (depth + 1 >= MAX_TREE_DEPTH || stack.has(subAssembly)) truncated = true;
          else {
            stack.add(subAssembly);
            node.children = walk(subAssembly, matrix, id + "/", depth + 1, hidden, stack);
            stack.delete(subAssembly);
          }
        }
      } else {
        leaves.push({ node, matrix, partKey: partKeyOf(r), suppressed });
      }
    }
    return out;
  };
  const roots = walk(root, IDENTITY, "", 0, false, new Set([root]));
  if (malformed) warnings.push(malformed + " component transforms in the assembly tree are malformed; using identity");
  if (truncated) warnings.push("the assembly tree is too deep, too large or cyclic; it was cut off");
  return { roots, leaves, componentKeys, warnings };
};

/** Cache names chain `Name-N@Assembly` segments; the tree id chains `Name-N`. */
export const instancePathOf = (cacheName: string) =>
  cacheName
    .split("/")
    .map((segment) => {
      const at = segment.lastIndexOf("@");
      return at > 0 ? segment.slice(0, at) : segment;
    })
    .join("/");
