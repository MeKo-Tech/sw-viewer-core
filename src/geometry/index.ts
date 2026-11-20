// Geometry analysis and measuring. Worker-safe: no DOM, no three.js.
export {
  analyzeEdge,
  analyzeFace,
  analyzeMesh,
  analyzeResult,
  computeStats,
  GEOMETRY_VERTEX_BUDGET,
  massProperties,
  type MassProperties,
  snapPoints,
  type SwSnapPoint,
} from "./analyze.ts";
export {
  angle3,
  angleBetween,
  closestOnFace,
  closestOnTriangle,
  closestPoint,
  describe,
  measurePair,
  sectionContour,
  type SwAngle,
  type SwDescription,
  type SwMeasureItem,
  type SwMeasureUnit,
  type SwPick,
  type SwPlane,
  type SwSectionContour,
} from "./measure.ts";
export { eig3, fitCircle, fitSphere, invertAffine, transformDir, transformPoint } from "./linalg.ts";
