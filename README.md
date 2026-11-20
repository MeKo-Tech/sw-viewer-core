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
timeout:

```ts
import { parseSwInWorker } from "./vendor/sw-viewer-core/index.js";

const r = await parseSwInWorker(
  () => new Worker(new URL("./vendor/sw-viewer-core/worker.js", import.meta.url), { type: "module" }),
  buffer,
  { timeoutMs: 30_000, signal },
);
```

## React component

`<SwViewer>` parses in the worker, renders with three.js and falls back to the
embedded thumbnail. It needs `react` (18+) and `three` (0.160+), which the app
provides. The root entry stays free of both.

```tsx
import { SwViewer } from "./vendor/sw-viewer-core/react/index.js";

<SwViewer
  source={file} // File | Blob | ArrayBuffer | Uint8Array (copied, never detached)
  createWorker={() => new Worker(new URL("./vendor/sw-viewer-core/worker.js", import.meta.url), { type: "module" })}
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
`useSwParse(source, createWorker)` for the parse state without the viewer. The
component has no built-in texts, so the app owns all UI strings. Without React,
`three/index.js` offers `createSwViewer(container)` and the scene helpers
`buildSwGroup`, `fitCamera` and `disposeObject`. Demo: `npm run demo` →
`/react.html`.

## How the apps get it

moin-bridge and moin-deck do not install this package. They carry a **vendored,
generated copy** of the built JS and `.d.ts` files, so no registry token is needed
in CI, Docker builds or on developer machines:

```bash
node tools/sync.ts ../moin-bridge/src/vendor/sw-viewer-core
node tools/sync.ts ../moin-deck/src/vendor/sw-viewer-core
```

Every file carries a header with the source version and commit. Never edit the
copies; change the decoder here, release, and sync again.

## Development

Uses Node 24, which runs the `.ts` files directly.

```bash
npm install --no-bin-links           # --no-bin-links: the NTFS mount refuses chmod
SW_DECODER_REPO=../Solidworks-File-Decoder npm test
npm run typecheck
npm run demo                         # http://localhost:5173, drop a .SLDPRT or .SLDASM
node tools/inspect.ts part.SLDPRT --entries --stl out.stl --png thumb.png
```

The sample parts aren't committed here. The tests read them from a checkout of
`MeKo-Tech/Solidworks-File-Decoder` and compare the mesh volume with the volume
SolidWorks reports (`tests/wahrheit_testdaten.json`).

## License note

The decoder is our own work, derived from the file data alone.
`Solidworks-File-Decoder/extern/sldfile` (PolyForm Noncommercial) is **not** used and
must not be copied from.
