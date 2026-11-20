// Pure helpers behind the React building blocks (no React, testable in Node).

import { flattenComponents } from "../three/components.ts";
import type { SwComponentNode, SwFaceInfo, SwMesh, SwModelStats } from "../types.ts";

/** Model extent along x, y and z in mm. */
export const modelSize = (stats: Pick<SwModelStats, "bboxMin" | "bboxMax">): [number, number, number] => [
  stats.bboxMax[0] - stats.bboxMin[0],
  stats.bboxMax[1] - stats.bboxMin[1],
  stats.bboxMax[2] - stats.bboxMin[2],
];

/** Mass in g from a volume in mm³ and a density in g/cm³. */
export const massGrams = (volumeMm3: number, densityGPerCm3: number) => (volumeMm3 / 1000) * densityGPerCm3;

/** A decimal number for an input field, with the locale's decimal separator and no grouping. */
export const formatDecimal = (x: number, locale?: string, maximumFractionDigits = 6) =>
  x.toLocaleString(locale ?? "en-US", { maximumFractionDigits, useGrouping: false });

/** Parses a density typed with a decimal point or comma; NaN when it is no number. */
export const parseDecimal = (text: string) => {
  const t = text.trim().replace(",", ".");
  return t === "" ? Number.NaN : Number(t);
};

/** Number of faces per surface type over all meshes (assembly instances counted each). */
export const faceTypeCounts = (meshes: readonly Pick<SwMesh, "faces">[]): Partial<Record<SwFaceInfo["type"], number>> => {
  const out: Partial<Record<SwFaceInfo["type"], number>> = {};
  for (const m of meshes) for (const f of m.faces ?? []) out[f.type] = (out[f.type] ?? 0) + 1;
  return out;
};

/** Parts and sub-assemblies in a component tree. */
export const countComponents = (nodes: readonly SwComponentNode[] | undefined) => {
  let parts = 0;
  let assemblies = 0;
  for (const n of flattenComponents(nodes)) {
    if (n.kind === "assembly") assemblies++;
    else parts++;
  }
  return { parts, assemblies };
};

/** Slider step for a range: about 2000 steps. */
export const sliderStep = (lo: number, hi: number) => (hi - lo) / 2000 || 0.01;

/** Properties as sorted [name, value] rows, without empty values. */
export const propertyRows = (props: Record<string, string> | undefined): [string, string][] =>
  Object.entries(props ?? {})
    .filter(([, v]) => v.trim() !== "")
    .sort(([a], [b]) => a.localeCompare(b));

/** Effect key of a section spec: equal specs give equal keys, whatever their identity. */
export const sectionKey = (section: unknown) => JSON.stringify(section ?? null);

/** Effect key of an id list: the same ids in any order and any array give the same key. */
export const idSetKey = (ids: readonly string[] | undefined) => (ids ? JSON.stringify([...new Set(ids)].sort()) : null);

/** Joins class names, skipping falsy ones. */
export const cx = (...names: (string | false | null | undefined)[]) => names.filter(Boolean).join(" ");
