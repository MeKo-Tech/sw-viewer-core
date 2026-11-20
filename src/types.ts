export type Rgb = [number, number, number];

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
}

export type SwDocumentKind = "part" | "assembly" | "drawing" | "unknown";

export interface SwParseResult {
  kind: SwDocumentKind;
  /** SolidWorks file version, e.g. 15000…19000 for SW 2015+. */
  version?: number;
  meshes: SwMesh[];
  /** Embedded PNG thumbnail, the fallback when there is no display mesh. */
  preview?: Uint8Array;
  warnings: string[];
}
