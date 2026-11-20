// Messages between the viewer and the parse worker. No DOM imports, so both sides
// can share it.

import type { SwParseResult } from "./types.ts";

export interface SwParseRequest {
  buffer: ArrayBuffer;
}

export type SwParseReply =
  | { type: "parsing" }
  | { type: "done"; result: SwParseResult }
  | { type: "error"; error: string };

/** Buffers of a result, to pass as the transfer list instead of copying them. */
export const transferables = (r: SwParseResult): ArrayBuffer[] => {
  const out: ArrayBuffer[] = [];
  for (const m of r.meshes) {
    for (const a of [m.positions, m.normals, m.indices]) {
      if (a) {
        out.push(a.buffer as ArrayBuffer);
      }
    }
  }
  if (r.preview) {
    out.push(r.preview.buffer as ArrayBuffer);
  }
  return out;
};
