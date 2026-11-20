// Part color from the first "moVisualProperties_c" record: the class name is
// followed by a Windows COLORREF (bytes R, G, B, 0). Per-face colors are not read yet.

import type { Rgb } from "./types.ts";

const CLASS_NAME = new TextEncoder().encode("moVisualProperties_c");

const find = (d: Uint8Array, sig: Uint8Array) => {
  outer: for (let i = 0; i + sig.length <= d.length; i++) {
    for (let j = 0; j < sig.length; j++) {
      if (d[i + j] !== sig[j]) {
        continue outer;
      }
    }
    return i;
  }
  return -1;
};

export const readBodyColor = (stream: Uint8Array): Rgb | undefined => {
  const at = find(stream, CLASS_NAME);
  const c = at + CLASS_NAME.length;
  if (at < 0 || c + 4 > stream.length || stream[c + 3] !== 0) {
    return undefined;
  }
  return [stream[c] / 255, stream[c + 1] / 255, stream[c + 2] / 255];
};
