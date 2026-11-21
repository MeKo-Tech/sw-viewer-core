# sw-viewer-core

Decodes embedded display meshes and thumbnails from SolidWorks parts (`.SLDPRT`)
and assemblies (`.SLDASM`) in the browser. It runs in a Web Worker and uses pure
TypeScript with no WASM or geometry kernel.

SolidWorks caches display triangles in the file. The library returns meshes in
the same shape the STEP viewers in moin-bridge and moin-deck render. For parts,
face ranges can carry a solid-color override. For assemblies, each rendered
instance has its saved placement and shares geometry where the cache permits it.
If an assembly lacks usable geometry, the result includes a warning and the
embedded thumbnail when present. [Format and fixture coverage](docs/format.md)

## Usage

```ts
import { parseSwFile } from "@meko-tech/sw-viewer-core";

const r = await parseSwFile(new Uint8Array(buffer));
// r.meshes[0]: { positions (mm), normals, indices, color?, faceRanges }
// Each face range can have color. Assembly instances have name and matrix.
// r.preview:   thumbnail bytes, PNG or BMP (r.previewType); fallback when r.meshes is empty
// r.warnings
```

For a list or card thumbnail, `readSwPreview` reads only the embedded image
(`PreviewPNG`, else the `Preview` bitmap as BMP, else a drawing's first sheet).
It decodes no geometry, takes a few milliseconds and is fine on the main thread:

```ts
import { readSwPreview } from "@meko-tech/sw-viewer-core";

const img = await readSwPreview(new Uint8Array(buffer)); // { bytes, type } | undefined
if (img) imgEl.src = URL.createObjectURL(new Blob([img.bytes], { type: img.type }));
```

In an app, parse in the worker and let `parseSwInWorker` terminate it after a
timeout. With Vite, the `?worker` import bundles the worker as its own chunk:

```ts
import { parseSwInWorker } from "@meko-tech/sw-viewer-core";
import SwParseWorker from "@meko-tech/sw-viewer-core/worker?worker";

const r = await parseSwInWorker(() => new SwParseWorker(), buffer, { timeoutMs: 30_000, signal });
```

## React component

`<SwViewer>` parses in the worker, renders with three.js and falls back to the
embedded thumbnail. It needs `react` (18+) and `three` (0.160+), which the app
provides. The root entry stays free of both.

```tsx
import { SwViewer } from "@meko-tech/sw-viewer-core/react";
import SwParseWorker from "@meko-tech/sw-viewer-core/worker?worker";

<SwViewer
  source={file} // File | Blob | ArrayBuffer | Uint8Array (copied, never detached)
  createWorker={() => new SwParseWorker()}
  onResult={(r) => setWarnings(r.warnings)}
  onError={setError}
  style={{ height: 400 }}
>
  {/* optional overlay, e.g. a spinner */}
</SwViewer>
```

More props:
- `onFirstFrame`: hide a loading overlay after the first frame.
- `onReady(viewer)`: get the instance, e.g. for `viewer.resetView()`.
- `viewerOptions={{ maxPixelRatio: 2, lighting: "fixed" | "headlight" }}`: read once on mount.
- `preview={false}`: render your own thumbnail card instead of the built-in one.
- Any div attribute, such as `role`, `aria-label` or `data-testid`, goes to the container.

If the viewer cannot get a WebGL context, `onError` receives the error and the
tree keeps rendering. On unmount, the component releases its WebGL context right
away.

Pass `result` instead of `source` when you have already parsed the file. Use
`useSwParse(source, createWorker)` for the parse state without the viewer.

### Viewer panel

Most apps use `<SwViewerPanel>`. It parses the file and wires the viewer to a
toolbar (views, edges, colour by part, measure modes, section menu), an
orientation cube, and a side bar with drawing sheets, the component tree, the
measurement and model info (size, volume, area, density → mass, properties):

```tsx
import { SwViewerPanel } from "@meko-tech/sw-viewer-core/react";
import "@meko-tech/sw-viewer-core/sw-viewer.css"; // optional default styles

<SwViewerPanel
  source={file}            // or result={parsed}
  createWorker={() => new SwParseWorker()}
  labels={germanLabels}    // see "Labels"
  locale="de-DE"           // numbers in the panels, the density field and dimension labels
  loadingOverlay={<Spinner />} // until the model is on screen
  style={{ height: 600 }}
/>
```

More props:
- `defaultMeasureMode` (`"auto"`, null for off), `defaultEdges`, `viewCube`,
  `viewCubeColors`, `views` (standard views in the toolbar; `[]` keeps only "fit").
- `sidebar`: `"side"` (default, also `true`) a column, `"drawer"` slides over the
  model, `false` none. `sidebarOpen`/`defaultSidebarOpen`/`onSidebarOpenChange`, and
  `sidebarToggle` for the toolbar button (default: drawer only).
- `toolbarExtra`: own controls at the end of the toolbar.
- `loadingOverlay`: shown while there is no result and until the first frame of
  a model (not for sheet-only drawings, not after a parse error). `children` render
  inside the model area at all times (it is a positioned box).
- `showComponentPaths`: file paths as tooltips in the tree. Off by default, since
  SolidWorks saves the author's local path (`C:\Users\…`).
- `defaultDensity`/`onDensityChange` (g/cm³), `formatDimension`/`formatValue`,
  `background`, `viewerOptions`, `onResult`, `onError`, `onReady`, `onFirstFrame`,
  `onMeasure`.

While a drawing sheet is shown, the 3D tools (edges, colour by part, measure,
section, views) leave the toolbar.

### Tablets and touch

```tsx
<SwViewerPanel
  result={result}
  defaultMeasureMode={null}          // every tap would start a measurement otherwise
  sidebar={wide ? "side" : "drawer"} // drawer over the model on narrow screens
  sidebarToggle
  views={[]}                         // the cube turns to the standard views
  style={{ "--sw-control-size": "44px", "--sw-checkbox-size": "20px" } as CSSProperties}
  className="touch-none"             // let the viewer have the gestures
/>
```

`--sw-control-size` sets the minimum height of buttons, inputs, tree rows, sheet
buttons and slider rows. The drawer closes with Escape or the toggle.

### Own layout: `useSwViewerState`

`useSwViewerState(result, options)` is the panel's wiring as a hook: edges, colour
and measure mode, section and section pick, hidden components (starting from the
ones SolidWorks saved hidden), measurement, pins, selected sheet and a `ready` flag
(first frame drawn). Per-model state starts over with every new `result`. It
returns props for each building block; a group's toolbar handler is unset while it
does not apply (no model, or a sheet is shown), and section props are null when
the file has nothing for them:

```tsx
const s = useSwViewerState(result, { defaultMeasureMode: null, locale, onFirstFrame });

<SwToolbar {...s.toolbarProps} labels={labels.toolbar} views={[]}>
  <MyPanelToggle />
</SwToolbar>
<div className="relative flex-1">
  <SwViewer {...s.viewerProps} viewCube={s.hasModel} viewCubeLabels={labels.viewCube} onError={onError} className="size-full" />
  {s.sheetViewProps && <SwSheetView {...s.sheetViewProps} labels={labels.sheets} />}
  {!s.ready && <Spinner />}
</div>
<aside>
  {s.sheetsProps && <SwSheets {...s.sheetsProps} labels={labels.sheets} />}
  {s.treeProps && <SwComponentTree {...s.treeProps} labels={labels.tree} />}
  {s.measureProps && <SwMeasurePanel {...s.measureProps} labels={labels.measure} />}
  {result && <SwInfoPanel result={result} locale={locale} labels={labels.info} />}
</aside>
```

The state is also there as plain fields (`edges`, `setEdges`, `section`,
`pickSection`, `hidden`, `setHidden`, `sheet`, `setSheet`, `pins`, `viewerRef`, …).
Mount the layout with a `key` per file when other app state should start over too.

### Building blocks

`<SwViewer>` takes the viewer state as props; the other components are plain
controlled components:

| Component | Purpose |
| --- | --- |
| `SwViewer` | `edges`, `colorMode` (`"file"`/`"part"`), `section` (`SwSectionSpec`), `measureMode`, `hiddenComponents`, `viewCube`, `viewCubeLabels`, `viewCubeColors`, `formatDimension`, `onMeasure`, `onSelect`, `onPinsChange` |
| `SwToolbar` | Each group renders when its handler is set: `onEdgesChange`, `onColorModeChange`, `onMeasureModeChange`, `onSectionChange` (+ `box`, `onPickSection`, `sectionPicking`), `onView` (+ `views`), `onResetView`; `children` for extra buttons |
| `SwComponentTree` | `components`, `hidden`, `onHiddenChange`: checkbox per node (sub-trees toggle together), colour swatch per part file, suppressed nodes disabled; sub-assemblies collapse, and start collapsed above `collapseAbove` nodes (default 200); `showPaths` for path tooltips |
| `SwInfoPanel` | `result`, `fileName`, `density`/`defaultDensity`/`onDensityChange`, `locale` (also for the density field) |
| `SwSheets` | `sheets`, `selected` (index, null = 3D model), `onSelect`; `useSheetUrls(sheets)` gives object URLs for a large view |
| `SwSheetView` | `sheets`, `urls`, `index`: the sheet image filling its positioned parent |
| `SwMeasurePanel` | `measurement`, `pins`, `onPin`, `onRemovePin`, `onClear`, `mode`, `components` |

`SwViewer` positions its container only when it computes to `position: static`
(it makes it `relative`); an app's own `absolute`/`fixed`, inline or from a class,
stays. Its `onSelect` reports measure picks (`SwViewerPick[]`); the DOM `select`
event of the wrapper `<div>` is not forwarded.

Helpers: `initialHiddenComponents(result)` (components SolidWorks saved hidden),
`setComponentHidden`, `partColors`, `formatDimension`, `formatMeasureValue`,
`sheetName`. A section through a hole or on a face needs a click in the model:
call `viewer.pickSectionTarget("cylinder" | "face")` (or `pickSection` of the hook)
and pass the returned spec as `section`.

### Labels

The components have no built-in strings. Each takes `labels`, merged over the
exported English defaults (`defaultToolbarLabels`, `defaultComponentTreeLabels`,
`defaultInfoPanelLabels`, `defaultMeasurePanelLabels`, `defaultSheetsLabels`,
`defaultViewCubeLabels`, `defaultViewerPanelLabels`). Nested records merge key by
key, so partial objects work:

```ts
const germanLabels: DeepPartial<SwViewerPanelLabels> = {
  toolbar: { edges: "Kanten", measureModes: { face: "Fläche" } },
  measure: { items: { diameter: "Durchmesser", "hole-diameter": "Bohrungsdurchmesser" } },
  viewCube: { front: "VORNE", top: "OBEN" },
};
```

To make sure nothing English slips through, build the complete types instead:
`SwViewerPanelLabels` (all blocks), or `SwToolbarLabels`, `SwComponentTreeLabels`,
`SwInfoPanelLabels`, `SwMeasurePanelLabels`, `SwSheetsLabels`, `SwViewCubeLabels`.
Every text a newer version adds is then a compile error:

```ts
const measure: SwMeasurePanelLabels = {
  title: t("measure.title"),
  // …
  items: Object.fromEntries(SW_MEASURE_KINDS.map((k) => [k, t(`measure.items.${k}`)])) as Record<SwMeasureKind, string>,
  shapes: { point: t("…"), plane: t("…"), cylinder: t("…"), hole: t("…"), cone: t("…"), sphere: t("…"), freeform: t("…"), line: t("…"), circle: t("…"), arc: t("…"), curve: t("…") },
  units: { mm: "mm", "mm²": "mm²", deg: "°" },
};
```

(The `Object.fromEntries` shortcut trades the per-kind compile check for brevity;
write the record out to keep it.)

- Measured values (`SwMeasureItem`) carry a `kind` (`SwMeasureKind`, all listed in
  `SW_MEASURE_KINDS`), one per meaning: `diameter` vs `hole-diameter`, `distance`
  (points) vs `plane-distance` (parallel planes), `angle` vs `three-point-angle` vs
  `parallel-angle`, `edge-length`/`curve-length`/`arc-length`, and so on. The
  `label` is the English text of the kind (`defaultMeasureItemLabels`).
- Picked elements (`SwDescription`) carry a `shape` (`SwShape`, `SW_SHAPES`): the
  face or edge type plus `hole` (inner cylinder) and `arc` (open circle), and the
  flags `inner` and `full`. Never parse the English `label`.
- Units come from labels too: `info.units` (size, area, volume, mass, density),
  `toolbar.units` (section slider), `measure.units` (values in the measure panel).
- `sheets.sheetFallback(n)` names sheets saved without a name (1-based).
- `loading` and `error` are only shown while the panel parses `source` itself, so
  they are optional.

### Theming

`sw-viewer.css` is a neutral light theme. Its custom properties have defaults on
`:root` with zero specificity, so setting them on any ancestor (the panel, an app
layout, `:root`) themes every block below it, including the dimension labels and
the orientation cube:

| Variable | Use |
| --- | --- |
| `--sw-fg`, `--sw-muted`, `--sw-bg`, `--sw-bg-subtle`, `--sw-border` | text, secondary text, backgrounds, borders |
| `--sw-accent`, `--sw-accent-bg` | pressed buttons, focus, sliders, selected sheet |
| `--sw-border-hover`, `--sw-hover-bg`, `--sw-hover-fg` | button hover (bg defaults to `--sw-bg-subtle`) |
| `--sw-checkbox-accent`, `--sw-checkbox-size` | tree checkboxes (accent defaults to `--sw-accent`) |
| `--sw-control-size` | minimum height of controls and rows (e.g. `44px` for touch) |
| `--sw-radius`, `--sw-font` | corners, font shorthand (`inherit` takes the app's) |
| `--sw-danger`, `--sw-overlay-bg`, `--sw-paper`, `--sw-sidebar-width` | errors, status/loading backdrop, sheet background, side bar width |
| `--sw-dim`, `--sw-dim-bg`, `--sw-pick`, `--sw-snap` | dimension labels, pick and snap markers in the 3D view |
| `--sw-cube-face`, `-edge`, `-corner`, `-hover`, `-text`, `-outline` | orientation cube, read when the cube is built (any CSS colour, e.g. `oklch(…)`) |

```css
.my-viewer {
  --sw-accent: var(--primary);
  --sw-accent-bg: color-mix(in oklch, var(--primary) 15%, transparent);
  --sw-border: var(--border);
  --sw-font: inherit;
}
```

Components keep stable `sw-*` class names (`sw-toolbar`, `sw-btn` with
`aria-pressed`, `sw-tree`, `sw-info`, `sw-measure`, `sw-sheets`, `sw-panel`,
`sw-panel-side[data-drawer]`, …) for anything the variables do not cover. Without
the stylesheet, the viewer still injects low-specificity (`:where`) defaults for
the 3D overlay (`sw-dim`, `sw-snap`, `sw-measure-point`).

### Without React

`@meko-tech/sw-viewer-core/three` offers `createSwViewer(container, options)`:

```ts
const viewer = createSwViewer(el, { viewCube: true, viewCubeColors: { hover: "#fde68a" }, onMeasure: (m) => show(m) });
viewer.setModel(result);
viewer.setMeasureMode("auto");               // "point" | "edge" | "face" | "angle" | null
viewer.setSection({ kind: "axis", axis: "x" }); // or { kind: "cylinder", center, axis, angle } / { kind: "face", point, normal }
viewer.setComponentVisible("Sub-1", false);  // hides the sub-tree
viewer.setColorMode("part");
viewer.setEdgesVisible(false);
viewer.setView("top");                       // front, back, top, bottom, left, right, iso
viewer.pinMeasurement();
viewer.clearMeasurements();
viewer.setViewCube(true, labels, colors);    // rebuild the cube, e.g. after a theme change
```

The renderer is created with `stencil: true` and local clipping for the closed,
hatched section cap; the section contour comes from `sectionContour` and can be
picked and measured (the `wuerfel_L20` bore measures Ø20.000). The orientation
cube renders into a scissor viewport, so the viewer keeps one WebGL context.
`dispose()` frees the context, the label DOM and all listeners. The dimension
labels are an absolutely positioned overlay inside `container`; a container with
`position: static` is switched to `relative` (and restored on dispose). Edges are
on by default (`edges: false` to start without them). The scene helpers
(`buildSwGroup`, `fitCamera`, `disposeObject`), the section maths (`sectionPlane`,
`sectionRange`) and the measurement model (`computeMeasurement`,
`primaryDimension`) are exported too. Demo: `npm run demo` → `/react.html`.

## Installing

Each release attaches the npm package to its GitHub Release. Apps depend on that
file, so installing needs no registry and no token:

```json
"@meko-tech/sw-viewer-core": "https://github.com/MeKo-Tech/sw-viewer-core/releases/download/v0.3.0/meko-tech-sw-viewer-core-0.3.0.tgz"
```

In a bundler with manual chunks, group the package with `three`, so it stays out
of the eagerly loaded vendor chunk.

To release, bump `version` in `package.json`, commit and push to main, then run
`node tools/release.ts --publish`. That tags `v<version>` and creates the
release. Without `--publish`, it only writes the tarball to `dist/`, which an app
can install with `bun add file:<path>` to try out changes before a release.

## Development

Uses Node 24, which runs the `.ts` files directly.

```bash
npm install --no-bin-links           # --no-bin-links: the NTFS mount refuses chmod
SW_DECODER_REPO=../Solidworks-File-Decoder npm test
npm run typecheck
npm run demo                         # http://localhost:5173 (/react.html: the panel), .SLDPRT, .SLDASM or .SLDDRW
node tools/inspect.ts part.SLDPRT --entries --stl out.stl --png thumb.png
```

The sample parts aren't committed here. The tests read them from a checkout of
`MeKo-Tech/Solidworks-File-Decoder` and compare the mesh volume with the volume
SolidWorks reports (`tests/wahrheit_testdaten.json`).

## License

MIT, see [LICENSE](LICENSE). The decoder is our own work, derived from the file data alone.
`Solidworks-File-Decoder/extern/sldfile` (PolyForm Noncommercial) is **not** used and
must not be copied from.
