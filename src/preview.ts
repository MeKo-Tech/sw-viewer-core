// The thumbnail SolidWorks embeds in every document, without decoding any geometry.
// Cheap enough for list views (a drawing card) and safe on the main thread: it only
// opens the container and reads one small stream.
//
// Sources, in order:
// - `PreviewPNG`: the PNG thumbnail of parts, assemblies and drawings;
// - `Preview`: a Windows DIB, turned into a BMP (the only image in some older files);
// - `Images/Sheet_<n>`: the first sheet image of a drawing.

import { openSwContainer, type SwContainer } from "./container.ts";
import { previewDibToBmp } from "./drawing.ts";

export interface SwPreviewImage {
  bytes: Uint8Array;
  type: "image/png" | "image/bmp";
}

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];
const isPng = (b: Uint8Array) => PNG_MAGIC.every((v, i) => b[i] === v);

const read = async (c: SwContainer, name: string) => {
  const e = c.find(name);
  return e && e.size > 0 ? e.read().catch(() => undefined) : undefined;
};

/** The embedded preview of an open container. `sheets: false` skips the sheet images,
 *  which the full parse returns separately. */
export const readContainerPreview = async (
  c: SwContainer,
  { sheets = true }: { sheets?: boolean } = {}
): Promise<SwPreviewImage | undefined> => {
  const png = await read(c, "PreviewPNG");
  if (png && isPng(png)) return { bytes: png, type: "image/png" };
  const dib = await read(c, "Preview");
  const bmp = dib && previewDibToBmp(dib);
  if (bmp) return { bytes: bmp, type: "image/bmp" };
  if (!sheets) return;
  const sheet = c.entries
    .map((e) => ({ e, m: /^Images\/Sheet_(\d+)$/.exec(e.name) }))
    .filter((x) => x.m && x.e.size > 0)
    .sort((a, b) => Number(a.m![1]) - Number(b.m![1]));
  for (const { e } of sheet) {
    const image = await e.read().catch(() => undefined);
    if (image && isPng(image)) return { bytes: image, type: "image/png" };
  }
  return;
};

/** The thumbnail embedded in a SolidWorks file (.sldprt, .sldasm, .slddrw; modern
 *  and pre-2015 OLE2 containers), or undefined when the file carries none.
 *  Throws SwContainerError when the bytes are not a SolidWorks container. */
export const readSwPreview = async (bytes: Uint8Array): Promise<SwPreviewImage | undefined> =>
  readContainerPreview(openSwContainer(bytes));
