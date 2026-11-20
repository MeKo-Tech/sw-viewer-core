// Part color from the first "moVisualProperties_c" record: the class name is
// followed by a Windows COLORREF (bytes R, G, B, 0), 8 more bytes, and then the
// appearance's texture name as an MFC Unicode CString (FF FE FF, length, UTF-16).
// A textured appearance (e.g. a plastic or cast finish) stores white or a nominal
// base color that is not what SolidWorks displays, so its color is reported as
// unknown and the viewer uses its default. Per-face colors are not read yet.

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
  const t = c + 12;
  const textured =
    t + 4 <= stream.length && stream[t] === 0xff && stream[t + 1] === 0xfe && stream[t + 2] === 0xff && stream[t + 3] > 0;
  if (textured) {
    return undefined;
  }
  return [stream[c] / 255, stream[c + 1] / 255, stream[c + 2] / 255];
};
