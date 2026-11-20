import {
  containerVersion,
  openSwContainer,
  type SwContainer,
} from "./container.ts";
import { buildBodyMesh, scanFaceTables } from "./displayMesh.ts";
import type { SwDocumentKind, SwParseResult } from "./types.ts";
import { readBodyColor } from "./visualProps.ts";

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

  const displayLists = await readOptional(c, "Contents/DisplayLists");
  const faces = displayLists ? scanFaceTables(displayLists) : [];
  const vertexCount = faces.reduce((s, f) => s + f.positions.length / 3, 0);
  if (vertexCount > MAX_VERTICES) {
    throw new Error(`display mesh too large (${vertexCount} vertices)`);
  }
  const mesh = buildBodyMesh(faces);
  if (!mesh) {
    warnings.push(
      kind === "assembly"
        ? "assemblies are not rendered yet; showing the thumbnail"
        : "the file contains no display mesh (e.g. an imported part); showing the thumbnail"
    );
  } else {
    const color =
      readBodyColor((await readOptional(c, "ThirdPtyStore/VisualStates")) ?? new Uint8Array()) ??
      (displayLists ? readBodyColor(displayLists) : undefined);
    mesh.color = color;
  }

  return {
    kind,
    version: containerVersion(c),
    meshes: mesh ? [mesh] : [],
    preview,
    warnings,
  };
};
