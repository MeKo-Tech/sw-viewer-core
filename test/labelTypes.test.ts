// Type-level checks of the label types (enforced by `npm run typecheck`): a complete
// label set must name every measure kind and shape, and unknown kinds are rejected.

import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultMeasureItemLabels, defaultShapeLabels, SW_MEASURE_KINDS, type SwMeasureKind, type SwShape } from "../src/geometry/index.ts";
import type { DeepPartial, SwMeasurePanelLabels, SwViewerPanelLabels } from "../src/react/labels.ts";

// A complete record compiles.
const items: SwMeasurePanelLabels["items"] = { ...defaultMeasureItemLabels };
const shapes: Record<SwShape, string> = { ...defaultShapeLabels };

// @ts-expect-error a complete set must name every kind
const missing: SwMeasurePanelLabels["items"] = { diameter: "Durchmesser" };

// @ts-expect-error "length" is no kind (edge-length, curve-length, arc-length are)
const unknown: SwMeasureKind = "length";

// @ts-expect-error SwViewerPanelLabels nests complete sets: a partial tree is rejected
const partialPanel: Pick<SwViewerPanelLabels, "tree"> = { tree: { title: "Komponenten" } };

// The labels prop takes partial sets, also per kind.
const partialProp: DeepPartial<SwViewerPanelLabels> = { measure: { items: { "hole-diameter": "Bohrung" } }, sheets: { sheetFallback: (n) => `Blatt ${n}` } };

test("label type fixtures exist at runtime", () => {
  assert.equal(Object.keys(items).length, SW_MEASURE_KINDS.length);
  assert.equal(shapes.hole, "Cylinder (hole)");
  assert.ok(missing && unknown && partialPanel && partialProp);
});
