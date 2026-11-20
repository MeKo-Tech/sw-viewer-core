// Usage: node --expose-gc tools/bench.ts [instances=2000] [vertices=20000]
// Synthetic large-assembly benchmark: one analysed part with ~`vertices` vertices placed
// `instances` times (instances share their typed arrays, like parse results do), plus
// a synthetic component tree and cache directory of the same size. Prints wall times
// and the heap growth of buildSwGroup. No WebGL needed: only the scene graph is built.

import { facesByDirectoryOrder } from "../src/assembly.ts";
import { parseComponentTree } from "../src/assemblyTree.ts";
import { analyzeMesh, computeStats } from "../src/geometry/analyze.ts";
import { sectionContour } from "../src/geometry/measure.ts";
import { buildSwGroup, disposeObject } from "../src/three/scene.ts";
import type { SwMesh } from "../src/types.ts";

const instances = Number(process.argv[2] ?? 2000);
const targetVertices = Number(process.argv[3] ?? 20000);
const gc = (globalThis as { gc?: () => void }).gc ?? (() => {});

/** A capped tube (outer wall split into coloured bands), own vertices per face. */
const part = (): SwMesh => {
  const seg = 100;
  const rings = Math.max(2, Math.round(targetVertices / seg));
  const bands = 8;
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  const faceRanges: NonNullable<SwMesh["faceRanges"]> = [];
  const r = 20;
  const h = 80;
  const perBand = Math.ceil((rings - 1) / bands);
  for (let b = 0; b < bands; b++) {
    const r0 = b * perBand;
    const r1 = Math.min(rings - 1, r0 + perBand);
    if (r1 <= r0) break;
    const base = positions.length / 3;
    for (let i = r0; i <= r1; i++) {
      for (let k = 0; k < seg; k++) {
        const a = (2 * Math.PI * k) / seg;
        positions.push(r * Math.cos(a), (h * i) / (rings - 1), r * Math.sin(a));
        normals.push(Math.cos(a), 0, Math.sin(a));
      }
    }
    const start = indices.length;
    for (let i = 0; i < r1 - r0; i++) {
      for (let k = 0; k < seg; k++) {
        const a = base + i * seg + k;
        const b2 = base + i * seg + ((k + 1) % seg);
        indices.push(a, a + seg, b2, b2, a + seg, b2 + seg);
      }
    }
    faceRanges.push({ start, count: indices.length - start, ...(b % 2 ? { color: [0.8, 0.2, 0.2] as [number, number, number] } : {}) });
  }
  for (const y of [0, h]) {
    const base = positions.length / 3;
    positions.push(0, y, 0);
    normals.push(0, y ? 1 : -1, 0);
    for (let k = 0; k < seg; k++) {
      const a = (2 * Math.PI * k) / seg;
      positions.push(r * Math.cos(a), y, r * Math.sin(a));
      normals.push(0, y ? 1 : -1, 0);
    }
    const start = indices.length;
    for (let k = 0; k < seg; k++) {
      const p = base + 1 + k;
      const q = base + 1 + ((k + 1) % seg);
      if (y) indices.push(base, q, p);
      else indices.push(base, p, q);
    }
    faceRanges.push({ start, count: indices.length - start });
  }
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    indices: Uint32Array.from(indices),
    faceRanges,
    color: [0.7, 0.7, 0.75],
  };
};

const time = <T>(label: string, fn: () => T, runs = 3): T => {
  let out!: T;
  const ms: number[] = [];
  for (let i = 0; i < runs; i++) {
    gc();
    const t0 = performance.now();
    out = fn();
    ms.push(performance.now() - t0);
  }
  console.log(`${label.padEnd(34)} ${ms.map((x) => x.toFixed(1).padStart(8)).join(" ")} ms`);
  return out;
};

const t0 = performance.now();
const src = part();
analyzeMesh(src);
console.log(`part: ${src.positions.length / 3} vertices, ${src.indices.length / 3} triangles, ${src.faces?.length} faces, ` +
  `${src.edgeRanges?.length} edges (analysed in ${(performance.now() - t0).toFixed(0)} ms)`);
const meshes: SwMesh[] = [];
for (let i = 0; i < instances; i++) {
  const x = (i % 50) * 50;
  const z = Math.floor(i / 50) * 50;
  const a = (i * 0.37) % (2 * Math.PI);
  const c = Math.cos(a), s = Math.sin(a);
  meshes.push({ ...src, name: `Tube-${i + 1}`, componentId: `Tube-${i + 1}`, matrix: [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, x, 0, z, 1] });
}
console.log(`${instances} instances`);

gc();
const heap0 = process.memoryUsage().heapUsed;
const kept = buildSwGroup(meshes);
gc();
const heap1 = process.memoryUsage().heapUsed;
const ab = process.memoryUsage().arrayBuffers;
console.log(`buildSwGroup heap growth: ${((heap1 - heap0) / 1e6).toFixed(1)} MB (arrayBuffers total ${(ab / 1e6).toFixed(1)} MB)`);
disposeObject(kept);
time("buildSwGroup", () => {
  const g = buildSwGroup(meshes);
  disposeObject(g);
  return g;
});
const stats = time("computeStats", () => computeStats(meshes));
console.log(`  bbox ${stats!.bboxMin.map((v) => v.toFixed(3))} .. ${stats!.bboxMax.map((v) => v.toFixed(3))}`);
time("sectionContour (plane y=1000)", () => {
  let n = 0;
  for (const m of meshes) n += sectionContour(m, { normal: [0, 1, 0], constant: 1000 }).length;
  return n;
});
time("sectionContour (plane y=40)", () => {
  let n = 0;
  for (const m of meshes) n += sectionContour(m, { normal: [0, 1, 0], constant: 40 }).length;
  return n;
}, 1);

// Component tree: a top assembly with `instances` part references in 20 sub-assemblies.
const subs = 20;
const ref = (id: number, name: string, n: number, model: number) =>
  `<swReference id="${id}" swComponentName="${name}" swReferenceNumber="${n}" swConfigurationName="Default" ` +
  `swSuppressed="NO" swHidden="NO" swModelRef="${model}" swTransform="1 0 0 0 0 1 0 0 0 0 1 0 0.01 0.02 0.03 1"/>`;
let xml = `<?xml version="1.0" encoding="UTF-8"?><swSolidWorks><swHeader><swFile id="1" swDocType="ASSEMBLY" swPath="C:\\cad\\Top.SLDASM"/>` +
  `<swFile id="2" swDocType="ASSEMBLY" swPath="C:\\cad\\Sub.SLDASM"/><swFile id="3" swDocType="PART" swPath="C:\\parts\\tube.SLDPRT"/></swHeader><swModelList>` +
  `<swModel id="13" swFileRef="3"/><swModel id="12" swFileRef="2">`;
for (let i = 0; i < instances / subs; i++) xml += ref(100 + i, "Tube", i + 1, 13);
xml += `</swModel><swModel id="11" swFileRef="1">`;
for (let i = 0; i < subs; i++) xml += ref(10000 + i, "Sub", i + 1, 12);
xml += `</swModel></swModelList><swConfigurationList><swConfiguration swMostRecentConfiguration="YES" swModelRef="11"/></swConfigurationList></swSolidWorks>`;
const treeBytes = new TextEncoder().encode(xml);
const tree = time(`parseComponentTree (${(treeBytes.length / 1e6).toFixed(2)} MB)`, () => parseComponentTree(treeBytes));
console.log(`  ${tree?.leaves.length} leaves`);
// Same-named siblings (no reference numbers): exercises the duplicate-id suffixes.
const dupXml = xml.replace(/ swReferenceNumber="\d+"/g, "");
time("parseComponentTree (same names)", () => parseComponentTree(dupXml), 1);

// Cache directory text with one row per part instance of a flat assembly.
const keys = new Map<string, string>();
let dirText = "";
for (let i = 0; i < instances; i++) {
  keys.set(`Top|Part${i}-1`, `C:\\parts\\part${i}.SLDPRT|Default`);
  dirText += `\u0000\u0007Part${i}-1@Top\u0000\u0003${String(i).padStart(3, "0")}-000-001\u0000`;
}
const directory = new Uint8Array(new Uint16Array([...dirText].map((ch) => ch.charCodeAt(0))).buffer);
time(`facesByDirectoryOrder (${(directory.length / 1e6).toFixed(2)} MB)`, () =>
  facesByDirectoryOrder([], directory, { componentKeys: keys, leaves: [] }), 1);
