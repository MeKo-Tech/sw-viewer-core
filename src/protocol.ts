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

/** Transfer each buffer once, including geometry shared by assembly instances. */
export const transferables = (r: SwParseResult): ArrayBuffer[] => {
  const out = new Set<ArrayBuffer>();
  for (const m of r.meshes) {
    for (const a of [m.positions, m.normals, m.indices, m.edges]) {
      if (a) {
        out.add(a.buffer as ArrayBuffer);
      }
    }
  }
  if (r.preview) {
    out.add(r.preview.buffer as ArrayBuffer);
  }
  return [...out];
};
