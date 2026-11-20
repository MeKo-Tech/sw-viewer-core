// Component tree helpers shared by the viewer and the React tree: visibility of
// instances and their sub-trees, and one colour per part file. Pure data, no three.js.

import type { Rgb, SwComponentNode, SwMesh, SwParseResult } from "../types.ts";

/** Pastel palette for the per-part colour mode (from MeKo's CAD-Viewer-Projekt). */
export const PART_PALETTE: readonly Rgb[] = [0xc3ccd8, 0xd8cdb8, 0xb9d3c4, 0xd6bfc9, 0xc0c8e4, 0xe0d2a8, 0xb8d6d9, 0xcfc3e0].map(
  (hex) => [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255] as Rgb,
);

/** Every node of the tree, depth first, parents before children. */
export const flattenComponents = (nodes: readonly SwComponentNode[] = []): SwComponentNode[] => {
  const out: SwComponentNode[] = [];
  const walk = (list: readonly SwComponentNode[]) => {
    for (const n of list) {
      out.push(n);
      walk(n.children);
    }
  };
  walk(nodes);
  return out;
};

/** Map from node id to its parent id (roots are absent). */
export const componentParents = (nodes: readonly SwComponentNode[] = []): Map<string, string> => {
  const parents = new Map<string, string>();
  for (const n of flattenComponents(nodes)) for (const c of n.children) parents.set(c.id, n.id);
  return parents;
};

/** `id` and the ids of all its descendants. Unknown ids return just `[id]`. */
export const componentSubtree = (nodes: readonly SwComponentNode[] = [], id: string): string[] => {
  const node = flattenComponents(nodes).find((n) => n.id === id);
  return node ? flattenComponents([node]).map((n) => n.id) : [id];
};

/**
 * Hidden component ids right after loading: nodes SolidWorks saved as hidden (their
 * children inherit it) and meshes saved with `visible: false`.
 */
export const initialHiddenComponents = (result: Pick<SwParseResult, "components" | "meshes"> | null | undefined): string[] => {
  if (!result) return [];
  const hidden = new Set<string>();
  for (const n of flattenComponents(result.components)) {
    if (n.hidden) for (const id of componentSubtree([n], n.id)) hidden.add(id);
  }
  for (const m of result.meshes) if (m.visible === false && m.componentId) hidden.add(m.componentId);
  return [...hidden];
};

/** Returns the new hidden list after showing or hiding `id` together with its sub-tree. */
export const setComponentHidden = (
  nodes: readonly SwComponentNode[] | undefined,
  hidden: readonly string[],
  id: string,
  visible: boolean,
): string[] => {
  const next = new Set(hidden);
  for (const x of componentSubtree(nodes, id)) {
    if (visible) next.delete(x);
    else next.add(x);
  }
  return [...next];
};

/** true when `id` or one of its ancestors is hidden. */
export const isComponentHidden = (id: string | undefined, hidden: ReadonlySet<string>, parents: ReadonlyMap<string, string>) => {
  for (let cur = id; cur !== undefined; cur = parents.get(cur)) if (hidden.has(cur)) return true;
  return false;
};

const fileKey = (node: SwComponentNode | undefined, fallback: string) => {
  const path = node?.path?.replace(/\\/g, "/");
  if (path) return path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  // `Würfel-1` and `Würfel-2` are instances of the same file.
  return (node?.name ?? fallback).replace(/-\d+(#\d+)?$/, "").toLowerCase();
};

/**
 * One palette colour per part file, keyed by component id: instances of the same file
 * share a colour. Covers every part node of the tree and every mesh `componentId`
 * (drawings give cached parts without an instance their path stem as id).
 */
export const partColors = (
  components: readonly SwComponentNode[] | undefined,
  meshes: readonly Pick<SwMesh, "componentId">[] = [],
): Map<string, Rgb> => {
  const byFile = new Map<string, number>();
  const out = new Map<string, Rgb>();
  const assign = (id: string, node: SwComponentNode | undefined) => {
    if (out.has(id)) return;
    const key = fileKey(node, id);
    if (!byFile.has(key)) byFile.set(key, byFile.size);
    out.set(id, PART_PALETTE[byFile.get(key)! % PART_PALETTE.length]);
  };
  const nodes = flattenComponents(components);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const n of nodes) if (n.kind === "part") assign(n.id, n);
  for (const m of meshes) if (m.componentId) assign(m.componentId, byId.get(m.componentId));
  return out;
};

/** CSS colour string for an 0..1 RGB triple. */
export const rgbCss = (c: Rgb) => `rgb(${c.map((x) => Math.round(x * 255)).join(" ")})`;
