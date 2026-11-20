// Demo: drop a .SLDPRT, parse it in the worker, render it with three.js. The scene
// setup mirrors moin-bridge's StepViewer/stepScene so the integration stays close.

import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { signedVolume } from "../src/displayMesh.ts";
import type { SwParseReply } from "../src/protocol.ts";
import type { SwMesh, SwParseResult } from "../src/types.ts";

const PARSE_TIMEOUT_MS = 30_000;

const stage = document.getElementById("stage") as HTMLDivElement;
const info = document.getElementById("info") as HTMLSpanElement;
const warn = document.getElementById("warn") as HTMLSpanElement;
const drop = document.getElementById("drop") as HTMLDivElement;
const previewImg = document.getElementById("preview") as HTMLImageElement;
const fileInput = document.getElementById("file") as HTMLInputElement;

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setClearColor(0xffffff, 1);
stage.prepend(renderer.domElement);

const scene = new THREE.Scene();
scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 0.7));
const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
scene.add(dirLight);
const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);
camera.add(dirLight);
dirLight.position.set(1, 1, 1);
scene.add(camera);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
let model: THREE.Group | null = null;

const resize = () => {
  const { clientWidth: w, clientHeight: h } = stage;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
};
new ResizeObserver(resize).observe(stage);

renderer.setAnimationLoop(() => {
  controls.update();
  renderer.render(scene, camera);
});

const buildGroup = (meshes: SwMesh[]) => {
  const group = new THREE.Group();
  for (const m of meshes) {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(m.positions, 3));
    if (m.normals) {
      g.setAttribute("normal", new THREE.BufferAttribute(m.normals, 3));
    } else {
      g.computeVertexNormals();
    }
    g.setIndex(new THREE.BufferAttribute(m.indices, 1));
    const color = m.color ? new THREE.Color(...m.color) : new THREE.Color(0xcccccc);
    const mesh = new THREE.Mesh(g, new THREE.MeshPhongMaterial({ color, specular: 0, side: THREE.DoubleSide }));
    if (m.matrix) {
      mesh.matrixAutoUpdate = false;
      mesh.matrix.fromArray(m.matrix);
      mesh.matrixWorldNeedsUpdate = true;
    }
    group.add(mesh);
  }
  return group;
};

const fitCamera = (obj: THREE.Object3D) => {
  const box = new THREE.Box3().setFromObject(obj);
  const center = box.getCenter(new THREE.Vector3());
  const maxDim = Math.max(...box.getSize(new THREE.Vector3()).toArray()) || 1;
  camera.near = maxDim * 0.01;
  camera.far = maxDim * 100;
  const d = maxDim * 1.5;
  camera.position.set(center.x + d, center.y + d, center.z + d);
  camera.updateProjectionMatrix();
  controls.target.copy(center);
  controls.update();
};

const clearModel = () => {
  if (!model) return;
  scene.remove(model);
  model.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      o.geometry.dispose();
      (o.material as THREE.Material).dispose();
    }
  });
  model = null;
};

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
  clearModel();
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
      model = buildGroup(r.meshes);
      scene.add(model);
      fitCamera(model);
      const m = r.meshes[0];
      info.textContent =
        `${file.name} · ${r.kind} · v${r.version} · ${m.faceRanges?.length} Flächen · ` +
        `${(m.indices.length / 3).toLocaleString("de")} Dreiecke · ` +
        `V ≈ ${signedVolume(m).toLocaleString("de", { maximumFractionDigits: 1 })} mm³ · ${ms.toFixed(0)} ms`;
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
