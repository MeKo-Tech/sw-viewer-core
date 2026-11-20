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
