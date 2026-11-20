import {
  containerVersion,
  openSwContainer,
  type SwContainer,
} from "./container.ts";
import { readAssemblyMeshes } from "./assembly.ts";
import { readDrawing } from "./drawing.ts";
import { buildBodyMesh, MAX_VERTICES, scanFaceTables } from "./displayMesh.ts";
import { readProperties } from "./properties.ts";
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

/** Decodes a SolidWorks file into renderable meshes plus the embedded thumbnail. */
export const parseSwFile = async (
  bytes: Uint8Array
): Promise<SwParseResult> => {
  const c = openSwContainer(bytes);
  const kind = documentKind(c);
  const warnings: string[] = [];
  const preview = await readOptional(c, "PreviewPNG");
  const version = containerVersion(c);
  const properties = await readProperties(c);

  if (kind === "drawing") {
    const drawing = await readDrawing(c, MAX_VERTICES);
    warnings.push(...drawing.warnings);
    const previewType = !preview && drawing.previewBmp ? "image/bmp" : undefined;
    if (!drawing.meshes.length && !drawing.sheets.length) {
      warnings.push("the drawing contains no sheet image or cached model");
    }
    return {
      kind,
      version,
      meshes: drawing.meshes,
      preview: preview ?? drawing.previewBmp,
      ...(previewType ? { previewType } : {}),
      ...(drawing.components ? { components: drawing.components } : {}),
      sheets: drawing.sheets,
      properties,
      warnings,
    };
  }

  if (kind === "assembly") {
    let meshes: SwParseResult["meshes"] = [];
    try {
      const displayLists = await readOptional(c, "Contents/DisplayLists");
      if (displayLists) {
        const assembly = await readAssemblyMeshes(c, displayLists, MAX_VERTICES);
        meshes = assembly.meshes;
        warnings.push(...assembly.warnings);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      warnings.push(`could not read the assembly display cache: ${message}`);
    }
    if (!meshes.length) {
      warnings.push(preview
        ? "no renderable assembly cache; showing the thumbnail"
        : "no renderable assembly cache or thumbnail");
    }
    return { kind, version, meshes, preview, properties, warnings };
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
    properties,
    warnings,
  };
};
