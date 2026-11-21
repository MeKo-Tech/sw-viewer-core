import {
  containerVersion,
  openSwContainer,
  type SwContainer,
} from "./container.ts";
import { readAssembly } from "./assembly.ts";
import { readDrawing } from "./drawing.ts";
import { buildBodyMesh, MAX_VERTICES, scanFaceTables } from "./displayMesh.ts";
import { readContainerPreview } from "./preview.ts";
import { readProperties } from "./properties.ts";
import { analyzeResult } from "./geometry/analyze.ts";
import type { SwDocumentKind, SwParseResult } from "./types.ts";
import { readBodyColor, readFaceColors } from "./visualProps.ts";

const documentKind = (c: SwContainer): SwDocumentKind => {
  const names = c.entries.map((e) => e.name);
  if (names.some((n) => /COMPINSTANCETREE/i.test(n))) {
    return "assembly";
  }
  if (names.some((n) => /Contents\/Config-\d+-Partition/.test(n))) {
    return "part";
  }
  if (
    names.some((n) => /^(Contents\/Sheet|Images\/Sheet_|SheetPreviews\/)/i.test(n)) ||
    (names.includes("Contents/VBLists") && !names.includes("Contents/DisplayLists"))
  ) {
    return "drawing";
  }
  return "unknown";
};

const readOptional = async (c: SwContainer, name: string) => {
  const e = c.find(name);
  return e && e.size > 0 ? e.read() : undefined;
};

/** Decodes a SolidWorks file into renderable meshes plus the embedded thumbnail,
 *  with faces, edges and model stats from the geometry analysis. */
export const parseSwFile = async (bytes: Uint8Array): Promise<SwParseResult> => {
  const result = await decodeSwFile(bytes);
  analyzeResult(result);
  return result;
};

const decodeSwFile = async (
  bytes: Uint8Array
): Promise<SwParseResult> => {
  const c = openSwContainer(bytes);
  const kind = documentKind(c);
  const warnings: string[] = [];
  const embedded = await readContainerPreview(c, { sheets: false });
  const preview = embedded?.bytes;
  const previewType = embedded?.type === "image/bmp" ? embedded.type : undefined;
  const version = containerVersion(c);
  const properties = await readProperties(c);

  if (kind === "drawing") {
    const drawing = await readDrawing(c, MAX_VERTICES);
    warnings.push(...drawing.warnings);
    if (!drawing.meshes.length && !drawing.sheets.length) {
      warnings.push("the drawing contains no sheet image or cached model");
    }
    return {
      kind,
      version,
      meshes: drawing.meshes,
      preview,
      ...(previewType ? { previewType } : {}),
      ...(drawing.components ? { components: drawing.components } : {}),
      sheets: drawing.sheets,
      properties,
      warnings,
    };
  }

  if (kind === "assembly") {
    let meshes: SwParseResult["meshes"] = [];
    let components: SwParseResult["components"];
    try {
      const displayLists = await readOptional(c, "Contents/DisplayLists");
      const assembly = await readAssembly(c, displayLists, MAX_VERTICES);
      meshes = assembly.meshes;
      components = assembly.components;
      warnings.push(...assembly.warnings);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      warnings.push(`could not read the assembly display cache: ${message}`);
    }
    if (!meshes.length) {
      warnings.push(preview
        ? "no renderable assembly cache; showing the thumbnail"
        : "no renderable assembly cache or thumbnail");
    }
    return { kind, version, meshes, ...(components ? { components } : {}), preview, ...(previewType ? { previewType } : {}), properties, warnings };
  }

  const displayLists = await readOptional(c, "Contents/DisplayLists");
  // Throws past MAX_VERTICES while scanning, before the faces are copied.
  const faces = displayLists ? scanFaceTables(displayLists) : [];
  const mesh = buildBodyMesh(faces);
  if (!mesh) {
    warnings.push(
      preview
        ? "the file contains no display mesh; showing the thumbnail"
        : "the file contains no display mesh or thumbnail"
    );
  } else {
    const color =
      readBodyColor((await readOptional(c, "ThirdPtyStore/VisualStates")) ?? new Uint8Array()) ??
      (displayLists ? readBodyColor(displayLists) : undefined);
    mesh.color = color;
    if (displayLists && mesh.faceRanges) {
      for (const [index, faceColor] of readFaceColors(displayLists, faces, version)) {
        mesh.faceRanges[index].color = faceColor;
      }
    }
  }

  return {
    kind,
    version,
    meshes: mesh ? [mesh] : [],
    preview,
    ...(previewType ? { previewType } : {}),
    properties,
    warnings,
  };
};
