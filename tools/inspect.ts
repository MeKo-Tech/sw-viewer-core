// Usage: node tools/inspect.ts <file.SLDPRT> [--stl out.stl] [--png out.png] [--entries]
// Prints container entries and mesh statistics; optionally writes a binary STL of the
// display mesh or the embedded thumbnail, for a quick check in any viewer.

import { readFileSync, writeFileSync } from "node:fs";
import { openSwContainer } from "../src/container.ts";
import { signedVolume } from "../src/displayMesh.ts";
import { parseSwFile } from "../src/parse.ts";
import type { SwMesh } from "../src/types.ts";

const args = process.argv.slice(2);
const file = args[0];
if (!file) {
  console.error("usage: node tools/inspect.ts <file> [--stl out.stl] [--png out.png] [--entries]");
  process.exit(2);
}
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const bytes = new Uint8Array(readFileSync(file));

if (args.includes("--entries")) {
  for (const e of openSwContainer(bytes).entries) {
    console.log(String(e.size).padStart(9), e.name);
  }
}

const t0 = performance.now();
const r = await parseSwFile(bytes);
const ms = performance.now() - t0;

const stl = (m: SwMesh) => {
  const n = m.indices.length / 3;
  const out = Buffer.alloc(84 + 50 * n);
  out.writeUInt32LE(n, 80);
  for (let t = 0; t < n; t++) {
    const o = 84 + 50 * t;
    for (let k = 0; k < 3; k++) {
      const v = 3 * m.indices[3 * t + k];
      for (let c = 0; c < 3; c++) {
        out.writeFloatLE(m.positions[v + c], o + 12 + 12 * k + 4 * c);
      }
    }
  }
  return out;
};

console.log(`kind=${r.kind} version=${r.version} parse=${ms.toFixed(1)}ms preview=${r.preview?.length ?? 0}B`);
for (const m of r.meshes) {
  console.log(
    `mesh faces=${m.faceRanges?.length} vertices=${m.positions.length / 3} triangles=${m.indices.length / 3}` +
      ` volume=${signedVolume(m).toFixed(2)}mm3 color=${m.color?.map((c) => Math.round(c * 255)).join(",")}`
  );
}
const tally = (types: string[]) => {
  const out: Record<string, number> = {};
  for (const t of types) out[t] = (out[t] ?? 0) + 1;
  return Object.entries(out).map(([t, n]) => `${t}=${n}`).join(" ");
};
for (const m of new Set(r.meshes.map((m) => m.faces)).values()) {
  if (!m) continue;
  console.log(`  face types: ${tally(m.map((f) => f.type))}`);
}
for (const e of new Set(r.meshes.map((m) => m.edgeRanges)).values()) {
  if (!e) continue;
  console.log(`  edge types: ${tally(e.map((x) => x.info.type))}`);
}
if (r.stats) {
  const s = r.stats;
  const size = s.bboxMax.map((v, i) => (v - s.bboxMin[i]).toFixed(3)).join(" × ");
  console.log(`stats bbox=${size}mm volume=${(s.volume / 1000).toFixed(2)}cm3 area=${(s.area / 100).toFixed(2)}cm2`);
}
for (const w of r.warnings) {
  console.log("warning:", w);
}
const stlOut = opt("--stl");
if (stlOut && r.meshes[0]) {
  writeFileSync(stlOut, stl(r.meshes[0]));
}
const pngOut = opt("--png");
if (pngOut && r.preview) {
  writeFileSync(pngOut, r.preview);
}
