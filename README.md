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
// r.preview:   PNG bytes (fallback when r.meshes is empty)
// r.warnings
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
  source={file}
  createWorker={() => new SwParseWorker()}
  labels={germanLabels} // see "Labels"
  locale="de-DE"        // numbers in the panels and on dimension labels
  style={{ height: 600 }}
/>
```

More props: `defaultMeasureMode` (`"auto"`, null for off), `defaultEdges`,
`viewCube`, `sidebar`, `defaultDensity`/`onDensityChange` (g/cm³),
`formatDimension`/`formatValue`, `onResult`, `onError`, `onReady`, `onMeasure`.

### Building blocks

For an own layout, combine the parts. `<SwViewer>` takes the viewer state as
props; the other components are plain controlled components:

| Component | Purpose |
| --- | --- |
| `SwViewer` | `edges`, `colorMode` (`"file"`/`"part"`), `section` (`SwSectionSpec`), `measureMode`, `hiddenComponents`, `viewCube`, `viewCubeLabels`, `formatDimension`, `onMeasure`, `onSelect`, `onPinsChange` |
| `SwToolbar` | Each group renders when its handler is set: `onEdgesChange`, `onColorModeChange`, `onMeasureModeChange`, `onSectionChange` (+ `box`, `onPickSection`, `sectionPicking`), `onView`, `onResetView`; `children` for extra buttons |
| `SwComponentTree` | `components`, `hidden`, `onHiddenChange`: checkbox per node (sub-trees toggle together), colour swatch per part file, suppressed nodes disabled; sub-assemblies collapse, and start collapsed above `collapseAbove` nodes (default 200) |
| `SwInfoPanel` | `result`, `fileName`, `density`/`defaultDensity`/`onDensityChange`, `locale` |
| `SwSheets` | `sheets`, `selected` (index, null = 3D model), `onSelect`; `useSheetUrls(sheets)` gives object URLs for a large view |
| `SwMeasurePanel` | `measurement`, `pins`, `onPin`, `onRemovePin`, `onClear`, `mode`, `components` |

`SwViewer`'s `onSelect` reports measure picks (`SwViewerPick[]`); the DOM `select`
event of the wrapper `<div>` is not forwarded (`onSelect` is left out of the
passed-through div attributes).

Helpers: `initialHiddenComponents(result)` (components SolidWorks saved hidden),
`setComponentHidden`, `partColors`, `formatDimension`, `formatMeasureValue`.
A section through a hole or on a face needs a click in the model: call
`viewer.pickSectionTarget("cylinder" | "face")` (from `onReady`) and pass the
returned spec as `section`.

### Labels

The components have no built-in strings. Each takes `labels`, merged over the
exported English defaults (`defaultToolbarLabels`, `defaultComponentTreeLabels`,
`defaultInfoPanelLabels`, `defaultMeasurePanelLabels`, `defaultSheetsLabels`,
`defaultViewCubeLabels`, `defaultViewerPanelLabels`; types `Sw…Labels`). Nested
records merge key by key, so partial objects work:

```ts
const germanLabels: DeepPartial<SwViewerPanelLabels> = {
  toolbar: { edges: "Kanten", measureModes: { face: "Fläche" } },
  measure: { item: (item) => ({ diameter: "Durchmesser" })[item.kind] ?? item.label },
  viewCube: { front: "VORNE", top: "OBEN" },
};
```

Measured values (`SwMeasureItem`) carry a machine `kind` (`diameter`,
`wall-thickness`, `angle`, …) and an English `label` hint; translate by `kind`.

### Styling

Components use stable `sw-*` class names (`sw-toolbar`, `sw-btn` with
`aria-pressed`, `sw-tree`, `sw-info`, `sw-measure`, `sw-sheets`, `sw-panel`, …).
`@meko-tech/sw-viewer-core/sw-viewer.css` is a small neutral light theme driven
by custom properties (`--sw-accent`, `--sw-border`, `--sw-dim`, …); skip it or
override any rule. The viewer injects low-specificity (`:where`) defaults for the
dimension labels in the 3D view (`sw-dim`, `sw-snap`, `sw-measure-point`).

### Without React

`@meko-tech/sw-viewer-core/three` offers `createSwViewer(container, options)`:

```ts
const viewer = createSwViewer(el, { viewCube: true, onMeasure: (m) => show(m) });
viewer.setModel(result);
viewer.setMeasureMode("auto");               // "point" | "edge" | "face" | "angle" | null
viewer.setSection({ kind: "axis", axis: "x" }); // or { kind: "cylinder", center, axis, angle } / { kind: "face", point, normal }
viewer.setComponentVisible("Sub-1", false);  // hides the sub-tree
viewer.setColorMode("part");
viewer.setEdgesVisible(false);
viewer.setView("top");                       // front, back, top, bottom, left, right, iso
viewer.pinMeasurement();
viewer.clearMeasurements();
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
