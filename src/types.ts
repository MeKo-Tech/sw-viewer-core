export type Rgb = [number, number, number];
export type Vec3 = [number, number, number];

/**
 * Surface recognised on one SolidWorks face from its display triangles (mesh space, mm).
 * Radii come from least-squares fits, so they are exact even where the facets cut the
 * surface (a Ø20 hole reads 10.000, not the facets' 9.8). Angles are in degrees.
 */
export type SwFaceInfo =
  | { type: "plane"; area: number; normal: Vec3; point: Vec3 }
  | {
      type: "cylinder";
      area: number;
      /** Unit axis direction (sign arbitrary). */
      axis: Vec3;
      /** Point on the axis, halfway along the face's axial extent. */
      center: Vec3;
      radius: number;
      /** Axial extent of the face. */
      height: number;
      /** true for a hole (normals point to the axis). */
      inner: boolean;
      /** true when the face covers the full circumference. */
      full: boolean;
      /** Covered circumference in degrees (360 when `full`). */
      arcDeg: number;
    }
  | {
      type: "cone";
      area: number;
      /** Unit axis direction (sign arbitrary). */
      axis: Vec3;
      /** Point on the axis, halfway along the face's axial extent. */
      center: Vec3;
      /** Absent when the apex fit was ill-conditioned. */
      apex?: Vec3;
      halfAngle: number;
    }
  | { type: "sphere"; area: number; center: Vec3; radius: number; inner: boolean }
  | { type: "other"; area: number };

/** Classification of one extracted edge polyline (mesh space, mm; angles in degrees). */
export type SwEdgeInfo =
  | { type: "line"; start: Vec3; end: Vec3; length: number }
  | {
      type: "circle";
      center: Vec3;
      normal: Vec3;
      radius: number;
      /** true for a closed circle, false for an arc. */
      full: boolean;
      /** Swept angle in degrees (360 when `full`). */
      angle: number;
      length: number;
    }
  | { type: "curve"; length: number; closed: boolean };

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
  /**
   * Polyline per edge: start offset (in segments) into `edges`, segment count, type,
   * and the indices (into `faces`) of the two faces it borders (-1 for an open border).
   */
  edgeRanges?: { start: number; count: number; info: SwEdgeInfo; faces: [number, number] }[];
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

/**
 * Bounding box and mass properties of the whole model (world space, mm), summed over
 * every mesh in `meshes`, hidden instances included. The box includes the analytic
 * extent of full outer cylinders, so a Ø50 shaft measures 50 even though its facets
 * stay inside the circle.
 */
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
