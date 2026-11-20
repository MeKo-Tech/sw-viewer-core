# SolidWorks display mesh: format notes

The viewer reads SolidWorks display geometry and thumbnails. The original part
format notes come from inspecting `MeKo-Tech/Solidworks-File-Decoder/testdaten`
and comparing the mesh volume with the SolidWorks reference. The audit below
lists the additional parts and assemblies inspected. The parser uses first-party
format research and code.

## Container (SolidWorks 2015 and later)

The file is a ZIP-like archive (port of our `sldcontainer.py`):

- It has an 8-byte header. Bytes 4–7 are `00 00 00 04`.
- Local and central headers carry the usual ZIP fields, but the signatures are
  replaced. Both are found by the marker `14 00 06 00 08 00` (version 20, flags 6,
  method 8).
  - **Local header**, where `sig` is the signature offset and `m = sig + 4`:
    - `m+10` crc32
    - `m+14` compressed size
    - `m+18` size
    - `m+22` name length
    - `m+24` extra length
    - `m+26` name
  - **Central entry**, where `s` = marker − 6:
    - `s+28` name length
    - `s+30` extra length
    - `s+32` comment length
    - `s+42` local header offset (relative to file offset 8)
    - `s+46` name
- Names are **nibble-swapped** per byte (`0x34` ↔ `0x43`).
- Payload is raw DEFLATE (no zlib header), checked by CRC-32.

## Container (SolidWorks 2014 and earlier): OLE2

Pre-2015 files are Microsoft compound files ([MS-CFB], magic
`D0 CF 11 E0 A1 B1 1A E1`). `src/ole.ts` reads them behind the same interface as the
ZIP-like container. The reader was first ported from `readOle` in MeKo's
CAD-Viewer-Projekt (`src/sw.js`).

- It reads the FAT from the 109 header DIFAT slots plus the DIFAT chain, and the
  mini FAT and mini stream (streams under the 4096-byte cutoff, 64-byte mini
  sectors).
- It walks the directory red-black trees recursively. Storage names are joined with
  `/`, so entries get the same names as in 2015+ files
  (`Contents/DisplayLists`, `_MO_VERSION_4700/History`).
- Every sector chain is checked for cycles and out-of-range sectors. Directory walks
  skip entries already visited.
- Streams named `…__ZLB` are compressed and listed without the suffix. Layout:
  constant 16-byte tag `23 1D D5 71 DA 81 48 A2 A8 58 98 B2 1B 89 EF 99`, u32
  uncompressed size, u32 compressed size, zlib stream, then 8 zero bytes. The
  declared size bounds the inflater, like the CRC-checked size of the ZIP path. A
  stream without the tag falls back to raw DEFLATE or zlib, at offset 0 or after 4
  bytes, as CAD-Viewer-Projekt does.
- The file version comes from the `_MO_VERSION_<n>` storage (`4700` for SW 2011).
- OLE2 parts carry `PreviewPNG`, `Contents/DisplayLists__ZLB`,
  `ThirdPtyStore/VisualStates__ZLB` and Office property sets
  (`SummaryInformation`). They do not carry the `docProps/*.xml` entries.

## Entries used

| Entry | Use |
| --- | --- |
| `Contents/DisplayLists` | tessellated display mesh (below) |
| `FaceTessellations/Directory` and `FaceTessellations/<name>` | component placements use `DisplayLists`, mesh groups can be stored in separate streams |
| `PreviewPNG` | PNG thumbnail, the fallback when there is no mesh |
| `ThirdPtyStore/VisualStates` | part color (first `moVisualProperties_c`, then a COLORREF `R G B 00`); textured appearances give no color, see open points |
| `_MO_VERSION_<n>/…` | file version from the entry name |
| `docProps/custom.xml`, `docProps/ISolidWorksInformation.xml` | `properties`: each named `<property>`, value of its first typed child (`vt:lpstr`, `vt:i4`, …; `FPVals` skipped). Unnamed, empty and `_PID_*` entries are skipped. |
| `docProps/core.xml` | `properties`: root children by local name (`title`, `creator`, `created`, …). On a name clash, custom wins over ISolidWorksInformation, which wins over core. |

## Drawings (`.SLDDRW`)

A file is a drawing when it has `Images/Sheet_*`, `SheetPreviews/*` or
`Contents/Sheet*`, or `Contents/VBLists` without `Contents/DisplayLists`. The
layout was first worked out in MeKo's CAD-Viewer-Projekt (`src/sw.js`,
`parseDrawing`).

| Entry | Use |
| --- | --- |
| `Images/Sheet_<n>` | `sheets[n].image`, PNG (640×480 in the sample) |
| `SheetPreviews/SheetNames` | sheet names: u16 count, then one MFC Unicode CString per sheet |
| `Preview` | u32 length (= stream length − 4), then a Windows DIB (BITMAPINFOHEADER, often RLE8). A 14-byte `BM` file header turns it into a BMP. It is used as `preview` (`previewType: "image/bmp"`) only without `PreviewPNG`. The sample is 2858×1499. |
| `Contents/VBLists` | cached 3D display data. Each referenced part has one block of face tables (same channels as `DisplayLists`) in **part coordinates**. The block is preceded by the model name and the part's full path, both MFC Unicode CStrings. Later mentions of the same path carry no faces. |
| `swXmlContents/xmlstream-<n>` | component tree of the referenced assembly, with the same schema as `COMPINSTANCETREE`. `swTransform` holds 16 numbers that read directly as a column-major matrix (translation in metres). Child placements compose as parent × child. |

The parser emits one mesh per unsuppressed part instance. Instances of a part share
the geometry of its VBLists block, matched by path or else by file name stem. Each
mesh gets the composed `matrix` and a `componentId` from the drawing's `components`
tree. Cached parts that no instance uses keep their own origin, with the path stem
as `componentId`. For `Baugr3.slddrw`, the 15 instances span the world box
(−268.55, −152.19, −410.00)…(570.62, 335.37, 370.62) mm. SolidWorks'
`swBoundingBox` is (−268.73, −152.19, −410)…(570.81, 335.37, 370.81) mm. The
difference comes from tessellated cylinders.

## `Contents/DisplayLists`: face tables

The stream is an MFC-style archive. A class record is `FF FF`, schema u16, name
length u16, then the ASCII class name. The faces live in records of class
`uoTempFaceTessData_c`. After it come later instances that refer back to the class
instead of repeating the name.

Each face holds a run of **channels**. A channel has a 16-byte header of four u32 LE
values, followed by `itemSize × count` bytes of data:

```
itemSize  kind  flags  count
```

| # | itemSize | kind | flags | content |
| - | -------- | ---- | ----- | ------- |
| 1 | 4 | 8 | 2 | `k` strip lengths (u32) |
| 2 | 12 | 100 | 2 | `n` positions, float32 xyz, **metres**; `n = Σ strip lengths` |
| 3 | 12 | 100 | 2 | `n` normals, float32 xyz |
| 4 | 4 | 8 | 2 | further per-vertex data (not used) |
| 5 | 4 | 8 | 2 | one value (not used) |
| 6 | 1 | 8 | 2 | one byte per vertex (not used) |

After the channels follows a trailer with the face bounding box (6 × float64) and ids.

**Decoding rule:** scan for channel 1 directly followed by channels 2 and 3, where
`count(2) = count(3) = Σ strip lengths`. That signature has had no false positives
on the samples. Each strip of length `L` gives `L − 2` triangles. Triangle `i` of a
strip is `(i, i+1, i+2)` for even `i` and `(i+1, i, i+2)` for odd `i`. The result is
wound outward: the signed volume is positive.

## Compatibility audit

The audit covered 92 parts. All 67 modern parts returned a mesh and a PNG
thumbnail. All 25 OLE2 parts (SolidWorks 2011) also return a mesh and a PNG
thumbnail. Their face counts match `build_results_2011.json`. Their mesh volume is
within 0.53% of the measured volume (torus), and within 0.37% for every other part.
`SW_OLE2_FIXTURES` runs this check in `test/ole.test.ts`.

| Parts | 15000 | 17000 | 19000 | 4700 (OLE2) |
| --- | ---: | ---: | ---: | ---: |
| `Solidworks-File-Decoder/testdaten` | 13 | 0 | 15 | 0 |
| [Mechanical Gear Drive](https://github.com/zyadkhalafamen/mechanical-gear-drive-solidworks/tree/main/solidworks-files) | 9 | 0 | 0 | 0 |
| [Mechanical Clamp](https://github.com/hrishiraj12/solidworks-mechanical-clamp) | 0 | 6 | 0 | 0 |
| [Controlled SolidWorks 2011 and 2022 parts](https://github.com/blussyya/sldprt-research-dump/tree/a03a5b3515463d23496536b8a5dc82dce536c1e9/test%20files%20new) | 24 | 0 | 0 | 25 |

The 1,184 archive streams in the 28 reference parts matched the sibling repo's
Python container reader in order, name, uncompressed size, and SHA-256. Signed
mesh volume was within the 1.5% test tolerance in 26 of those parts. The largest
deviation within tolerance was 1.14%. The two known stale meshes,
`Sr220106_10RevB` and `Sr220106_15RevB`, were 99.52% and 7.75% over the reference
volumes. The sibling repo's shape comparison also found differences in four
parts whose volumes pass (`docs/TESTERGEBNISSE.md` in that repo).

All 24 controlled 2022 files matched their measured face counts, and mesh volume
differed by at most 0.531%. The Gear Drive and Clamp parts have no reference
volumes in this audit. The imported part `Schiene` had a mesh. The sibling repo's
105-part project corpus was unavailable, so the audit still lacks a part saved
without a display mesh. [Controlled part measurements](https://github.com/blussyya/sldprt-research-dump/blob/a03a5b3515463d23496536b8a5dc82dce536c1e9/test%20files%20new/build_results.json)

## Assembly display caches

- Both Gear Drive assemblies have triangles in `Contents/DisplayLists`. The
  triangles use part-local coordinates. `uoTempAssemblySHDData_c` records carry
  the instance name and saved transform, including composed transforms for nested
  components. Repeated instances can reference a previously stored mesh.
- Mechanical Clamp has placements in `Contents/DisplayLists` and triangles in
  `FaceTessellations/000-000-005`. The directory stream associates seven named
  instances with the cache and identifies each component's face run. The cache
  includes the geometry for a part file missing from the public checkout.
- Across the three assemblies, the 55 inspected placement records match the
  transforms in `swXmlContents/COMPINSTANCETREE` after composing parent placements.
  The viewer renders 23, 24, and 7 leaf instances from the three files. The
  embedded cache is the source of placements and geometry. Hidden and suppressed
  instances were outside this validation set.

## Face colors

Part meshes include a `color` on a face range when an inline record between
matching face IDs describes a local solid-color appearance. The scope field
distinguishes local overrides from inherited body records. An appearance can use
a texture even when the first name is empty, so the reader checks both texture
flags. Texture, ambiguity, and unsupported record layouts leave the range without
a color override. The demo renders those ranges using the mesh color or default
grey. Synthetic tests cover solid-color overrides. The verified overrides in the
real sample parts were textured.

## Open points

- **Colors.**
  - After the COLORREF come 8 bytes and then the texture name as an MFC Unicode CString
    (`FF FE FF`, length, UTF-16).
  - A textured appearance (non-empty name, e.g. `texture`) stores white or a nominal base
    color that SolidWorks does not display, so it is reported as no color and the viewer
    uses its default grey. That affects 6 of 28 samples.
  - Feature colors and textures remain open.
- **Parts without a mesh** fall back to the thumbnail when present. This path
  still needs verification with a real part fixture.
- **OLE2 properties.** Legacy files store properties as OLE property sets
  (`SummaryInformation`, `DocumentSummaryInformation`), which are not read yet.
- **OLE2 drawings and assemblies** are untested. No sample file was available.
- **Drawing configurations.** VBLists blocks are keyed by part path only. A drawing
  that shows two configurations of one part uses the first block for both.
