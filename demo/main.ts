// Demo: drop a SolidWorks file, parse it in the worker, render it with three.js. The scene
// rendering comes from src/three, which mirrors moin-bridge's StepViewer/stepScene.

import { signedVolume } from "../src/displayMesh.ts";
import type { SwParseReply } from "../src/protocol.ts";
import type { SwParseResult } from "../src/types.ts";
import { createSwViewer } from "../src/three/viewer.ts";

const PARSE_TIMEOUT_MS = 30_000;

const stage = document.getElementById("stage") as HTMLDivElement;
const info = document.getElementById("info") as HTMLSpanElement;
const warn = document.getElementById("warn") as HTMLSpanElement;
const drop = document.getElementById("drop") as HTMLDivElement;
const previewImg = document.getElementById("preview") as HTMLImageElement;
const fileInput = document.getElementById("file") as HTMLInputElement;

const viewer = createSwViewer(stage);

const parseInWorker = (buffer: ArrayBuffer) =>
  new Promise<SwParseResult>((resolve, reject) => {
    const worker = new Worker(new URL("../src/worker.ts", import.meta.url), { type: "module" });
    const timer = setTimeout(() => {
      worker.terminate();
      reject(new Error("timeout while parsing"));
    }, PARSE_TIMEOUT_MS);
    worker.onmessage = (ev: MessageEvent<SwParseReply>) => {
      if (ev.data.type === "parsing") return;
      clearTimeout(timer);
      worker.terminate();
      if (ev.data.type === "done") resolve(ev.data.result);
      else reject(new Error(ev.data.error));
    };
    worker.postMessage({ buffer }, [buffer]);
  });

const show = async (file: File) => {
  viewer.setModel(null);
  previewImg.style.display = "none";
  warn.textContent = "";
  info.textContent = `${file.name}: lese …`;
  try {
    const t0 = performance.now();
    const r = await parseInWorker(await file.arrayBuffer());
    const ms = performance.now() - t0;
    drop.style.display = "none";
    warn.textContent = r.warnings.join("; ");
    if (r.meshes.length) {
      viewer.setModel(r);
      const summary = `${file.name} · ${r.kind} · v${r.version}`;
      if (r.kind === "assembly") {
        const triangles = r.meshes.reduce((sum, m) => sum + m.indices.length / 3, 0);
        info.textContent = `${summary} · ${r.meshes.length} Komponenten · ` +
          `${triangles.toLocaleString("de")} Dreiecke · ${ms.toFixed(0)} ms`;
      } else {
        const m = r.meshes[0];
        info.textContent = `${summary} · ${m.faceRanges?.length} Flächen · ` +
          `${(m.indices.length / 3).toLocaleString("de")} Dreiecke · ` +
          `V ≈ ${signedVolume(m).toLocaleString("de", { maximumFractionDigits: 1 })} mm³ · ${ms.toFixed(0)} ms`;
      }
    } else if (r.preview) {
      previewImg.src = URL.createObjectURL(new Blob([r.preview as BlobPart], { type: "image/png" }));
      previewImg.style.display = "block";
      info.textContent = `${file.name} · ${r.kind} · v${r.version} · nur Vorschaubild`;
    } else {
      info.textContent = `${file.name}: keine Vorschau verfügbar`;
    }
  } catch (err) {
    info.textContent = `${file.name}: Fehler`;
    warn.textContent = err instanceof Error ? err.message : String(err);
  }
};

fileInput.addEventListener("change", () => fileInput.files?.[0] && show(fileInput.files[0]));
stage.addEventListener("dragover", (e) => {
  e.preventDefault();
  stage.classList.add("over");
});
stage.addEventListener("dragleave", () => stage.classList.remove("over"));
stage.addEventListener("drop", (e) => {
  e.preventDefault();
  stage.classList.remove("over");
  const f = e.dataTransfer?.files[0];
  if (f) show(f);
});
