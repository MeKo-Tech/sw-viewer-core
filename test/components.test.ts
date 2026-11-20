// Component tree helpers, React label merging and panel helpers (pure, no DOM).

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  componentParents,
  componentSubtree,
  initialHiddenComponents,
  isComponentHidden,
  PART_PALETTE,
  partColors,
  rgbCss,
  setComponentHidden,
} from "../src/three/components.ts";
import { countComponents, faceTypeCounts, formatDecimal, idSetKey, massGrams, modelSize, parseDecimal, propertyRows, sectionKey, sliderStep } from "../src/react/helpers.ts";
import { defaultMeasurePanelLabels, defaultSheetsLabels, defaultToolbarLabels, mergeLabels, sheetName } from "../src/react/labels.ts";
import type { SwComponentNode } from "../src/types.ts";

const node = (id: string, name: string, extra: Partial<SwComponentNode> = {}): SwComponentNode => ({
  id,
  name,
  kind: "part",
  hidden: false,
  suppressed: false,
  children: [],
  ...extra,
});

const tree: SwComponentNode[] = [
  node("Sub-1", "Sub-1", {
    kind: "assembly",
    children: [node("Sub-1/Cube-1", "Cube-1", { path: "C:\\cad\\Cube.SLDPRT" }), node("Sub-1/Pin-1", "Pin-1")],
  }),
  node("Cube-2", "Cube-2", { path: "D:/other/cube.sldprt" }),
  node("Pin-2", "Pin-2", { hidden: true }),
];

describe("component helpers", () => {
  it("finds parents and sub-trees", () => {
    const parents = componentParents(tree);
    assert.equal(parents.get("Sub-1/Cube-1"), "Sub-1");
    assert.equal(parents.has("Sub-1"), false);
    assert.deepEqual(componentSubtree(tree, "Sub-1"), ["Sub-1", "Sub-1/Cube-1", "Sub-1/Pin-1"]);
    assert.deepEqual(componentSubtree(tree, "unknown"), ["unknown"]);
  });

  it("starts with the components saved hidden and meshes saved invisible", () => {
    const hidden = initialHiddenComponents({ components: tree, meshes: [{ positions: new Float32Array(), indices: new Uint32Array(), componentId: "x", visible: false }] });
    assert.deepEqual(hidden.sort(), ["Pin-2", "x"]);
    assert.deepEqual(initialHiddenComponents(null), []);
  });

  it("hides and shows whole sub-trees; ancestors hide their children", () => {
    const hidden = setComponentHidden(tree, [], "Sub-1", false);
    assert.deepEqual(hidden.sort(), ["Sub-1", "Sub-1/Cube-1", "Sub-1/Pin-1"]);
    const parents = componentParents(tree);
    assert.equal(isComponentHidden("Sub-1/Pin-1", new Set(["Sub-1"]), parents), true);
    assert.equal(isComponentHidden("Cube-2", new Set(["Sub-1"]), parents), false);
    assert.deepEqual(setComponentHidden(tree, hidden, "Sub-1", true), []);
  });

  it("gives instances of the same part file the same colour", () => {
    const colors = partColors(tree, [{ componentId: "Cube" }]);
    // Cube-1 and Cube-2 reference Cube.SLDPRT; Pin-1 and Pin-2 have no path but the same stem.
    assert.deepEqual(colors.get("Sub-1/Cube-1"), colors.get("Cube-2"));
    assert.deepEqual(colors.get("Sub-1/Pin-1"), colors.get("Pin-2"));
    assert.notDeepEqual(colors.get("Sub-1/Cube-1"), colors.get("Sub-1/Pin-1"));
    assert.equal(colors.has("Sub-1"), false);
    assert.ok(colors.has("Cube"));
    assert.equal(rgbCss(PART_PALETTE[0]), "rgb(195 204 216)");
  });
});

describe("React labels and helpers", () => {
  it("merges partial labels, nested records key by key", () => {
    const L = mergeLabels(defaultToolbarLabels, { edges: "Kanten", measureModes: { auto: "Automatisch" } });
    assert.equal(L.edges, "Kanten");
    assert.equal(L.measureModes.auto, "Automatisch");
    assert.equal(L.measureModes.edge, "Edge");
    assert.equal(L.section, "Section");
    assert.equal(mergeLabels(defaultToolbarLabels, undefined), defaultToolbarLabels);
    // Per-kind records merge key by key too; functions are replaced, not merged.
    const M = mergeLabels(defaultMeasurePanelLabels, { items: { radius: "Halbmesser" }, element: (i) => `#${i}` });
    assert.equal(M.items.radius, "Halbmesser");
    assert.equal(M.items.diameter, "Diameter");
    assert.equal(M.element(2), "#2");
    assert.equal(defaultMeasurePanelLabels.items.radius, "Radius");
  });

  it("computes size, mass, face counts and properties", () => {
    assert.deepEqual(modelSize({ bboxMin: [-1, -2, -3], bboxMax: [1, 2, 3] }), [2, 4, 6]);
    assert.equal(massGrams(1_000_000, 7.85), 7850);
    assert.equal(parseDecimal("7,85"), 7.85);
    assert.ok(Number.isNaN(parseDecimal("")));
    assert.deepEqual(faceTypeCounts([{ faces: [{ type: "plane", area: 1, normal: [0, 0, 1], point: [0, 0, 0] }, { type: "other", area: 1 }] }, {}]), { plane: 1, other: 1 });
    assert.deepEqual(countComponents(tree), { parts: 4, assemblies: 1 });
    assert.deepEqual(propertyRows({ b: "2", a: "1", empty: " " }), [["a", "1"], ["b", "2"]]);
    assert.equal(sliderStep(0, 2000), 1);
    assert.equal(sliderStep(1, 1), 0.01);
  });

  it("shows decimals with the locale's separator and parses either", () => {
    assert.equal(formatDecimal(7.85, "de-DE"), "7,85");
    assert.equal(formatDecimal(7.85), "7.85");
    assert.equal(formatDecimal(12345.5, "de-DE"), "12345,5");
    assert.equal(parseDecimal(formatDecimal(2.7, "de-DE")), 2.7);
    assert.equal(parseDecimal(" 2.7 "), 2.7);
  });

  it("names sheets by their saved name or the numbered fallback", () => {
    assert.equal(sheetName(defaultSheetsLabels, "Blatt1", 0), "Blatt1");
    assert.equal(sheetName(defaultSheetsLabels, "", 1), "Sheet 2");
    assert.equal(sheetName(defaultSheetsLabels, "  ", 0), "Sheet 1");
    assert.equal(sheetName({ sheetFallback: (n) => `Blatt ${n}` }, undefined, 2), "Blatt 3");
  });
});

describe("effect keys", () => {
  it("are equal for equal content, whatever the identity", () => {
    assert.equal(idSetKey(["b", "a"]), idSetKey(["a", "b", "a"]));
    assert.notEqual(idSetKey(["a"]), idSetKey(["a", "b"]));
    assert.notEqual(idSetKey([]), idSetKey(undefined));
    assert.equal(idSetKey(undefined), null);
    assert.equal(sectionKey({ axis: "x", offset: 1 }), sectionKey({ axis: "x", offset: 1 }));
    assert.notEqual(sectionKey({ axis: "x", offset: 1 }), sectionKey({ axis: "x", offset: 2 }));
    assert.equal(sectionKey(null), sectionKey(undefined));
  });
});
