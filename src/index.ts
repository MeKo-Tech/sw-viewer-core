export {
  containerKind,
  containerVersion,
  MAX_ENTRY_SIZE,
  openSwContainer,
  SwContainerError,
  type SwContainer,
  type SwEntry,
} from "./container.ts";
export {
  buildBodyMesh,
  MAX_VERTICES,
  scanFaceTables,
  signedVolume,
} from "./displayMesh.ts";
export { parseSwFile } from "./parse.ts";
export type { SwParseReply, SwParseRequest } from "./protocol.ts";
export type {
  Rgb,
  SwDocumentKind,
  SwEdgeInfo,
  SwFaceInfo,
  SwMesh,
  SwModelStats,
  SwParseResult,
  Vec3,
} from "./types.ts";
export * from "./geometry/index.ts";
export {
  DEFAULT_PARSE_TIMEOUT_MS,
  type ParseInWorkerOptions,
  parseSwInWorker,
  SwParseTimeoutError,
} from "./client.ts";
