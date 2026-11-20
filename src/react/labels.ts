// UI texts of the React building blocks. Components have no built-in strings: each takes
// a `labels` prop that is merged over these English defaults, so apps translate by
// passing their own objects. Pure data, no React.

import {
  defaultMeasureItemLabels,
  defaultShapeLabels,
  type SwMeasureKind,
  type SwMeasureUnit,
  type SwShape,
} from "../geometry/measure.ts";
import { DEFAULT_UNIT_LABELS, type SwMeasureMode, type SwSnapKind } from "../three/measureModel.ts";
import type { SwAxis } from "../three/section.ts";
import type { SwStandardView, SwViewCubeLabels } from "../three/viewCube.ts";
import { defaultViewCubeLabels } from "../three/viewCube.ts";
import type { SwDocumentKind, SwFaceInfo } from "../types.ts";

export interface SwToolbarLabels {
  /** aria-label of the toolbar. */
  toolbar: string;
  edges: string;
  /** Caption of the measure mode group. */
  measure: string;
  measureModes: Record<SwMeasureMode, string>;
  /** Tooltips of the measure modes. */
  measureModeHints: Record<SwMeasureMode, string>;
  measureOff: string;
  section: string;
  sectionOff: string;
  sectionAxis: Record<SwAxis, string>;
  sectionThroughAxis: string;
  sectionOnFace: string;
  /** Shown while waiting for the click that places the section. */
  sectionPickHint: Record<"face" | "cylinder", string>;
  cancel: string;
  sectionFlip: string;
  sectionOffset: string;
  sectionAngle: string;
  sectionContour: string;
  views: string;
  viewNames: Record<SwStandardView, string>;
  resetView: string;
  colorByPart: string;
  /** Units after the section slider values. */
  units: { length: string; angle: string };
}

export const defaultToolbarLabels: SwToolbarLabels = {
  toolbar: "Viewer tools",
  edges: "Edges",
  measure: "Measure",
  measureModes: { auto: "Auto", point: "Point", edge: "Edge", face: "Face", angle: "Angle" },
  measureModeHints: {
    auto: "Points, edges and faces",
    point: "Only points: corners, edge midpoints, circle centres, free points on faces",
    edge: "Only edges",
    face: "Only faces",
    angle: "Angle: two edges, faces or axes, or three points",
  },
  measureOff: "Off",
  section: "Section",
  sectionOff: "Off",
  sectionAxis: { x: "X", y: "Y", z: "Z" },
  sectionThroughAxis: "Through axis",
  sectionOnFace: "On face",
  sectionPickHint: {
    face: "Click a planar face in the model …",
    cylinder: "Click a hole, shaft or circular edge in the model …",
  },
  cancel: "Cancel",
  sectionFlip: "Flip side",
  sectionOffset: "Position",
  sectionAngle: "Rotation",
  sectionContour: "Contour",
  views: "Views",
  viewNames: { front: "Front", back: "Back", top: "Top", bottom: "Bottom", left: "Left", right: "Right", iso: "Isometric" },
  resetView: "Fit",
  colorByPart: "Colour by part",
  units: { length: "mm", angle: "°" },
};

export interface SwComponentTreeLabels {
  title: string;
  /** Summary under the title. */
  count: (parts: number, assemblies: number) => string;
  suppressed: string;
  /** aria-label of a node's checkbox. */
  toggle: (name: string) => string;
  showAll: string;
  /** aria-label of the button that opens a collapsed sub-assembly. */
  expand: (name: string) => string;
  /** aria-label of the button that collapses an open sub-assembly. */
  collapse: (name: string) => string;
}

export const defaultComponentTreeLabels: SwComponentTreeLabels = {
  title: "Components",
  count: (parts, assemblies) =>
    `${parts} ${parts === 1 ? "part" : "parts"}${assemblies ? `, ${assemblies} ${assemblies === 1 ? "sub-assembly" : "sub-assemblies"}` : ""}`,
  suppressed: "suppressed",
  toggle: (name) => `Show ${name}`,
  showAll: "Show all",
  expand: (name) => `Expand ${name}`,
  collapse: (name) => `Collapse ${name}`,
};

export interface SwInfoPanelLabels {
  title: string;
  file: string;
  kind: string;
  kinds: Record<SwDocumentKind, string>;
  size: string;
  volume: string;
  area: string;
  density: string;
  mass: string;
  faces: string;
  faceTypes: Record<SwFaceInfo["type"], string>;
  version: string;
  properties: string;
  /** Footnote on approximate values. */
  approxNote: string;
  /** Units: size in `length`, surface area in `area`, volume, mass, density. */
  units: { length: string; area: string; volume: string; mass: string; density: string };
}

export const defaultInfoPanelLabels: SwInfoPanelLabels = {
  title: "Model",
  file: "File",
  kind: "Type",
  kinds: { part: "Part", assembly: "Assembly", drawing: "Drawing", unknown: "Unknown" },
  size: "Size",
  volume: "Volume ≈",
  area: "Surface area ≈",
  density: "Density",
  mass: "Mass ≈",
  faces: "Faces",
  faceTypes: { plane: "planes", cylinder: "cylinders", cone: "cones", sphere: "spheres", other: "freeform" },
  version: "File version",
  properties: "Properties",
  approxNote: "Values with ≈ come from the display mesh.",
  units: { length: "mm", area: "cm²", volume: "cm³", mass: "g", density: "g/cm³" },
};

export interface SwMeasurePanelLabels {
  title: string;
  /** Hint without a selection, per mode, and `off` while measuring is off. */
  hints: Record<SwMeasureMode | "off", string>;
  pin: string;
  pinned: string;
  noPins: string;
  remove: (id: number) => string;
  clear: string;
  component: string;
  snap: string;
  snapKinds: Record<SwSnapKind, string>;
  element: (index: number) => string;
  /** Row label per measured value kind (`SwMeasureItem.kind`). */
  items: Record<SwMeasureKind, string>;
  /** Title per picked element shape (`SwDescription.shape`). */
  shapes: Record<SwShape, string>;
  /** Unit texts after the values (`°` follows the number without a space). */
  units: Record<SwMeasureUnit, string>;
}

export const defaultMeasurePanelLabels: SwMeasurePanelLabels = {
  title: "Measurement",
  hints: {
    auto: "Click a point, edge or face; a second element gives distance or angle. Corners, edge midpoints and circle centres snap.",
    point: "Click points: they snap to corners, edge midpoints and circle centres, else to the face.",
    edge: "Click edges.",
    face: "Click faces.",
    angle: "Angle: click two edges, faces or axes, or three points (angle at the middle point).",
    off: "Choose a measure mode to measure.",
  },
  pin: "Keep dimension",
  pinned: "Kept dimensions",
  noPins: "No dimensions kept yet.",
  remove: (id) => `Remove dimension ${id}`,
  clear: "Clear all",
  component: "Component",
  snap: "Snap",
  snapKinds: { corner: "Corner", midpoint: "Edge midpoint", center: "Circle centre", surface: "Point on face" },
  element: (i) => `Element ${i}`,
  items: { ...defaultMeasureItemLabels },
  shapes: { ...defaultShapeLabels },
  units: { ...DEFAULT_UNIT_LABELS },
};

export interface SwSheetsLabels {
  title: string;
  model: string;
  /** Name of a sheet saved without one, by its 1-based number. */
  sheetFallback: (n: number) => string;
}

export const defaultSheetsLabels: SwSheetsLabels = {
  title: "Sheets",
  model: "3D model",
  sheetFallback: (n) => `Sheet ${n}`,
};

/** Display name of the sheet at `index`: its saved name, or `sheetFallback(index + 1)`. */
export const sheetName = (labels: Pick<SwSheetsLabels, "sheetFallback">, name: string | undefined, index: number) =>
  name?.trim() ? name : labels.sheetFallback(index + 1);

/**
 * Every text of `SwViewerPanel`. The prop takes a `DeepPartial` of it; an app that
 * builds a complete `SwViewerPanelLabels` gets a type error for every text a newer
 * version adds, instead of English on screen.
 */
export interface SwViewerPanelLabels {
  toolbar: SwToolbarLabels;
  tree: SwComponentTreeLabels;
  info: SwInfoPanelLabels;
  measure: SwMeasurePanelLabels;
  sheets: SwSheetsLabels;
  viewCube: SwViewCubeLabels;
  /** Status while parsing `source`; never shown when the app passes `result`. */
  loading?: string;
  /** Status when parsing `source` failed; never shown when the app passes `result`. */
  error?: (error: Error) => string;
  /** Shown when the file has neither mesh nor thumbnail. */
  empty: string;
  /** Tooltip and accessible name of the side bar toggle. */
  sidebarShow: string;
  sidebarHide: string;
}

export const defaultViewerPanelLabels: SwViewerPanelLabels = {
  toolbar: defaultToolbarLabels,
  tree: defaultComponentTreeLabels,
  info: defaultInfoPanelLabels,
  measure: defaultMeasurePanelLabels,
  sheets: defaultSheetsLabels,
  viewCube: defaultViewCubeLabels,
  loading: "Reading file …",
  error: (e) => `Could not read the file: ${e.message}`,
  empty: "The file contains no displayable geometry.",
  sidebarShow: "Show details",
  sidebarHide: "Hide details",
};

const isPlainObject = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x) && Object.getPrototypeOf(x) === Object.prototype;

/**
 * Merges partial labels over defaults. Nested records (e.g. `measureModes`) are merged
 * key by key, so `{ measureModes: { auto: "Automatisch" } }` keeps the other modes.
 */
export const mergeLabels = <T extends object>(defaults: T, partial?: DeepPartial<T> | null): T => {
  if (!partial) return defaults;
  const out: Record<string, unknown> = { ...(defaults as Record<string, unknown>) };
  for (const [k, v] of Object.entries(partial)) {
    if (v === undefined) continue;
    const d = (defaults as Record<string, unknown>)[k];
    out[k] = isPlainObject(d) && isPlainObject(v) ? mergeLabels(d, v as DeepPartial<typeof d>) : v;
  }
  return out as T;
};

/** Partial labels, also inside nested records. Functions stay whole. */
export type DeepPartial<T> = {
  [K in keyof T]?: NonNullable<T[K]> extends (...args: never[]) => unknown
    ? T[K]
    : NonNullable<T[K]> extends object
      ? DeepPartial<NonNullable<T[K]>>
      : T[K];
};
