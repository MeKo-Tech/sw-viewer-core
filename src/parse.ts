import {
  containerVersion,
  openSwContainer,
  type SwContainer,
} from "./container.ts";
import { readAssemblyMeshes } from "./assembly.ts";
import { buildBodyMesh, scanFaceTables } from "./displayMesh.ts";
import type { SwDocumentKind, SwParseResult } from "./types.ts";
import { readBodyColor, readFaceColors } from "./visualProps.ts";

/** Hard cap on decoded vertices so a crafted file can't exhaust memory. */
const MAX_VERTICES = 8_000_000;

const documentKind = (c: SwContainer): SwDocumentKind => {
  const names = c.entries.map((e) => e.name);
  if (names.some((n) => /COMPINSTANCETREE/i.test(n))) {
    return "assembly";
  }
  if (names.some((n) => /Contents\/Config-\d+-Partition/.test(n))) {
    return "part";
  }
  if (names.some((n) => /^Contents\/Sheet/i.test(n))) {
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
    return { kind, version, meshes, preview, warnings };
  }

  const displayLists = await readOptional(c, "Contents/DisplayLists");
  const faces = displayLists ? scanFaceTables(displayLists) : [];
  const vertexCount = faces.reduce((s, f) => s + f.positions.length / 3, 0);
  if (vertexCount > MAX_VERTICES) {
    throw new Error(`display mesh too large (${vertexCount} vertices)`);
  }
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
    warnings,
  };
};
