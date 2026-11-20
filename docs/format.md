# SolidWorks display mesh: format notes

This repo reads only what a viewer needs. All facts below come from hex inspection
of the sample parts in `MeKo-Tech/Solidworks-File-Decoder/testdaten` (SW versions
15000–19000). They were checked by comparing the enclosed mesh volume with the
volume SolidWorks reports. No code was taken from third-party decoders.

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

Pre-2015 files are OLE2 compound files (magic `D0 CF 11 E0 A1 B1 1A E1`). They are
detected and rejected for now.

## Entries used

| Entry | Use |
| --- | --- |
| `Contents/DisplayLists` | tessellated display mesh (below) |
| `PreviewPNG` | PNG thumbnail, the fallback when there is no mesh |
| `ThirdPtyStore/VisualStates` | part color (first `moVisualProperties_c`, then a COLORREF `R G B 00`) – unreliable, see open points |
| `_MO_VERSION_<n>/…` | file version from the entry name |

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

## Validation (28 sample parts)

- 26 of 28 parts match the SolidWorks volume within 1.2 %, most within 0.4 %.
  Tessellation cuts a little off curved faces.
- `Sr220106_10RevB` (+99.5 %) and `Sr220106_15RevB` (+7.8 %) carry a **stale** display
  mesh: the mesh is consistent in itself, but older than the exact solid. The decoder
  repo found the same thing independently (`docs/TESTERGEBNISSE.md`).
  - A viewer shows what SolidWorks last displayed. That can differ from the current
    exact solid when the file was saved without a rebuild.

## Open points

- **Colors.** The "first `moVisualProperties_c`" rule gives white for some parts,
  where SolidWorks shows its default bluish grey. Per-face and per-feature colors
  (`VisualStates`) are not read.
- **Parts without a mesh** (imported parts) fall back to the thumbnail. No such sample
  is in `testdaten/`. The 40 project parts mentioned in the decoder repo are needed
  to test this.
- **Assemblies.** It's unknown whether `.SLDASM` files carry their own display mesh.
  There are no samples on this machine.
- **The OLE2 container** (SW ≤ 2014).
