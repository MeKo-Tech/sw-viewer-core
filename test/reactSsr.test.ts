// Server-rendered markup of the React components (react-dom/server, no DOM, no WebGL):
// panel layout and sidebar modes, 3D tools hidden over sheets, overlays, locale and
// unit labels, the path tooltip opt-in, and the useSwViewerState hook.

import "./support/tsx.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { analyzeResult } from "../src/geometry/index.ts";
import type { SwComponentNode, SwParseResult } from "../src/types.ts";
import { cube } from "./meshes.ts";

const { SwViewer } = await import("../src/react/SwViewer.tsx");
const { SwViewerPanel } = await import("../src/react/SwViewerPanel.tsx");
const { SwToolbar } = await import("../src/react/SwToolbar.tsx");
const { SwComponentTree } = await import("../src/react/SwComponentTree.tsx");
const { SwInfoPanel } = await import("../src/react/SwInfoPanel.tsx");
const { useSwViewerState } = await import("../src/react/useSwViewerState.ts");

const part = (): SwParseResult => {
  const r: SwParseResult = { kind: "part", meshes: [cube(10)], warnings: [] };
  analyzeResult(r);
  return r;
};
const drawing: SwParseResult = {
  kind: "drawing",
  meshes: [],
  warnings: [],
  sheets: [
    { name: "", image: new Uint8Array([1]) },
    { name: "Detail", image: new Uint8Array([2]) },
  ],
};
const node = (id: string, path?: string): SwComponentNode => ({ id, name: id, path, kind: "part", hidden: false, suppressed: false, children: [] });

const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);
const count = (s: string, needle: string) => s.split(needle).length - 1;

describe("SwViewer markup", () => {
  it("keeps the app's position and sets none itself", () => {
    assert.match(html(h(SwViewer, { style: { position: "absolute", inset: 0 } })), /^<div style="position:absolute;inset:0">/);
    assert.match(html(h(SwViewer, { className: "absolute inset-0" })), /^<div class="absolute inset-0">/);
  });
});

describe("SwViewerPanel markup", () => {
  it("side bar as a column by default, without a toggle", () => {
    const s = html(h(SwViewerPanel, { result: part() }));
    assert.match(s, /class="sw-panel-body" data-side=""/);
    assert.match(s, /<aside[^>]*class="sw-panel-side"/);
    assert.doesNotMatch(s, /sw-sidebar-toggle/);
    assert.match(s, /aria-label="Measure"/);
  });

  it("drawer mode: closed, with a toggle that controls it", () => {
    const s = html(h(SwViewerPanel, { result: part(), sidebar: "drawer", labels: { sidebarShow: "Details zeigen" } }));
    const id = /<aside id="([^"]+)"/.exec(s)?.[1];
    assert.ok(id);
    assert.match(s, new RegExp(`aria-expanded="false" aria-controls="${id}" aria-label="Details zeigen"`));
    assert.match(s, /data-drawer="" hidden=""/);
    assert.doesNotMatch(s, /data-side=""/);
  });

  it("an open drawer and a closed column follow the props", () => {
    assert.doesNotMatch(html(h(SwViewerPanel, { result: part(), sidebar: "drawer", sidebarOpen: true })), /hidden=""/);
    const closed = html(h(SwViewerPanel, { result: part(), sidebar: "side", defaultSidebarOpen: false, sidebarToggle: true }));
    assert.match(closed, /hidden=""/);
    assert.match(closed, /sw-sidebar-toggle/);
    assert.doesNotMatch(html(h(SwViewerPanel, { result: part(), sidebar: false })), /<aside/);
  });

  it("hides the 3D tools while a sheet is shown, keeps toolbar extras", () => {
    const s = html(h(SwViewerPanel, { result: drawing, toolbarExtra: h("button", { id: "extra" }, "X") }));
    assert.doesNotMatch(s, /aria-label="Measure"/);
    assert.doesNotMatch(s, />Edges</);
    assert.doesNotMatch(s, />Section</);
    assert.match(s, /id="extra"/);
    // The first sheet is selected; its unnamed button uses the fallback name.
    assert.match(s, /aria-pressed="true"[^>]*><span class="sw-sheet-name">Sheet 1</);
    assert.match(s, />Detail</);
  });

  it("offers only the given views", () => {
    const s = html(h(SwViewerPanel, { result: part(), views: [] }));
    assert.match(s, />Fit</);
    assert.doesNotMatch(s, />Front</);
  });

  it("shows the loading overlay until the model is on screen, and children always", () => {
    const loading = h("span", { className: "spin" });
    const kid = h("i", { className: "kid" });
    assert.match(html(h(SwViewerPanel, { result: null, loadingOverlay: loading, children: kid })), /<div class="sw-panel-loading"><span class="spin"><\/span><\/div><i class="kid">/);
    // Waiting for the first frame of a mesh.
    assert.match(html(h(SwViewerPanel, { result: part(), loadingOverlay: loading })), /sw-panel-loading/);
    // Nothing to draw: sheets only.
    assert.doesNotMatch(html(h(SwViewerPanel, { result: drawing, loadingOverlay: loading, children: kid })), /sw-panel-loading/);
  });
});

describe("labels and locale in markup", () => {
  it("toolbar slider values use the locale and the unit labels", () => {
    const s = html(
      h(SwToolbar, {
        section: { kind: "axis", axis: "x", offset: 1.5 },
        box: { min: [0, 0, 0], max: [10, 10, 10] },
        onSectionChange: () => {},
        locale: "de-DE",
        labels: { units: { length: "Millimeter" } },
      }),
    );
    assert.match(s, /<output>1,5 Millimeter<\/output>/);
  });

  it("the info panel shows the density with the locale separator and labelled units", () => {
    const s = html(h(SwInfoPanel, { result: part(), locale: "de-DE", labels: { units: { mass: "Gramm", density: "g/ccm" } } }));
    assert.match(s, /value="7,85"/);
    assert.match(s, /g\/ccm/);
    assert.match(s, /7,9 Gramm/);
    assert.match(s, /10,00 × 10,00 × 10,00 mm/);
  });

  it("the tree shows file paths only on request", () => {
    const components = [node("A-1", "C:\\Users\\someone\\OneDrive\\a.sldprt")];
    const props = { components, hidden: [], onHiddenChange: () => {} };
    assert.doesNotMatch(html(h(SwComponentTree, props)), /title=/);
    assert.match(html(h(SwComponentTree, { ...props, showPaths: true })), /title="C:\\Users/);
  });
});

describe("useSwViewerState", () => {
  const probe = (result: SwParseResult | null, opts?: Parameters<typeof useSwViewerState>[1]) => {
    let state: ReturnType<typeof useSwViewerState> | undefined;
    const Probe = () => {
      state = useSwViewerState(result, opts);
      return null;
    };
    html(h(Probe));
    return state!;
  };

  it("a part: 3D tools on, waiting for the first frame", () => {
    const s = probe(part());
    assert.equal(s.modelTools, true);
    assert.equal(s.ready, false);
    assert.equal(s.measureMode, "auto");
    assert.equal(s.sheet, null);
    assert.ok(s.toolbarProps.onMeasureModeChange && s.toolbarProps.onSectionChange && s.toolbarProps.onPickSection);
    assert.ok(s.measureProps);
    assert.equal(s.sheetsProps, null);
    assert.equal(s.treeProps, null);
    assert.deepEqual(s.box, { min: [-5, -5, -5], max: [5, 5, 5] });
  });

  it("a drawing without a model opens on its first sheet and is ready at once", () => {
    const s = probe(drawing, { defaultMeasureMode: null });
    assert.equal(s.sheet, 0);
    assert.equal(s.modelTools, false);
    assert.equal(s.ready, true);
    assert.equal(s.measureMode, null);
    assert.equal(s.toolbarProps.onEdgesChange, undefined);
    assert.equal(s.sheetsProps?.selected, 0);
    assert.equal(s.sheetViewProps?.index, 0);
    assert.equal(s.measureProps, null);
  });

  it("an assembly gets tree props with the saved hidden components", () => {
    const r = part();
    r.kind = "assembly";
    r.components = [node("A-1"), { ...node("B-1"), hidden: true }];
    const s = probe(r);
    assert.deepEqual(s.hidden, ["B-1"]);
    assert.deepEqual(s.treeProps?.hidden, ["B-1"]);
    assert.ok(s.toolbarProps.onColorModeChange);
    assert.equal(count(JSON.stringify(s.viewerProps.hiddenComponents), "B-1"), 1);
  });

  it("nothing loaded: not ready, no panels", () => {
    const s = probe(null);
    assert.equal(s.ready, false);
    assert.equal(s.hasModel, false);
    assert.equal(s.viewerProps.result, null);
  });
});
