export type Rgb = [number, number, number];
export type Vec3 = [number, number, number];

/** Surface recognised on one SolidWorks face from its display triangles (mesh space, mm). */
export type SwFaceInfo =
  | { type: "plane"; area: number; normal: Vec3; point: Vec3 }
  | {
      type: "cylinder";
      area: number;
      axis: Vec3;
      /** A point on the axis. */
      center: Vec3;
      radius: number;
      /** Extent along the axis, measured from `center`. */
      axisMin: number;
      axisMax: number;
      /** true for a hole (normals point to the axis). */
      inner: boolean;
      /** true when the face covers the full circumference. */
      full: boolean;
    }
  | { type: "cone"; area: number; axis: Vec3; apex: Vec3; halfAngle: number }
  | { type: "sphere"; area: number; center: Vec3; radius: number; inner: boolean }
  | { type: "other"; area: number };

/** Classification of one extracted edge polyline. */
export type SwEdgeInfo =
  | { type: "line"; start: Vec3; end: Vec3; length: number }
  | { type: "circle"; center: Vec3; normal: Vec3; radius: number; full: boolean; length: number }
  | { type: "curve"; length: number };

/** One renderable mesh. Same shape as the STEP viewers' meshes, plus face ranges. */
export interface SwMesh {
  /** xyz triplets in millimetres. */
  positions: Float32Array;
  normals?: Float32Array;
  indices: Uint32Array;
  /** 0..1 RGB. */
  color?: Rgb;
  name?: string;
  /** Column-major 4×4 transform (assembly components). */
  matrix?: number[];
  /** Index range per SolidWorks face, in `indices`, with an optional 0..1 RGB override. */
  faceRanges?: { start: number; count: number; color?: Rgb }[];
  /** Id of the `SwComponentNode` this instance belongs to (assemblies and drawings). */
  componentId?: string;
  /** false for components SolidWorks saved as hidden; the viewer starts them invisible. */
  visible?: boolean;
  /**
   * Model edges as line-segment pairs (xyz xyz, mm, mesh space): boundaries between
   * faces, split at sharp kinks. Absent when the mesh exceeded the analysis budget.
   */
  edges?: Float32Array;
  /** Polyline per edge: start offset (in segments) into `edges`, segment count, type. */
  edgeRanges?: { start: number; count: number; info: SwEdgeInfo }[];
  /** One entry per `faceRanges` entry. */
  faces?: SwFaceInfo[];
}

/** Node of an assembly's component tree (from `swXmlContents/COMPINSTANCETREE`). */
export interface SwComponentNode {
  /** Stable id, unique in the result; referenced by `SwMesh.componentId`. */
  id: string;
  /** Instance name as SolidWorks shows it, e.g. `Würfel-1`. */
  name: string;
  /** Referenced document path as saved (may point to the author's disk). */
  path?: string;
  configuration?: string;
  kind: "part" | "assembly";
  hidden: boolean;
  suppressed: boolean;
  children: SwComponentNode[];
}

/** Bounding box and mass properties of the whole model (world space, mm). */
export interface SwModelStats {
  bboxMin: Vec3;
  bboxMax: Vec3;
  /** mm³; only meaningful for closed meshes. */
  volume: number;
  /** mm². */
  area: number;
}

export interface SwSheet {
  name: string;
  /** PNG bytes. */
  image: Uint8Array;
}

export type SwDocumentKind = "part" | "assembly" | "drawing" | "unknown";

export interface SwParseResult {
  kind: SwDocumentKind;
  /** SolidWorks file version, e.g. 15000…19000 for SW 2015+. */
  version?: number;
  meshes: SwMesh[];
  /** Embedded PNG thumbnail, the fallback when there is no display mesh. */
  preview?: Uint8Array;
  /** MIME type of `preview` when it is not PNG (drawings can carry a BMP). */
  previewType?: string;
  /** Assembly component tree (roots are the top-level components). */
  components?: SwComponentNode[];
  /** Document properties (custom, summary and SolidWorks information). */
  properties?: Record<string, string>;
  /** Drawing sheets (`.slddrw`). */
  sheets?: SwSheet[];
  stats?: SwModelStats;
  warnings: string[];
}
