// A complete three.js viewer for parse results: renderer, lights, orbit controls and
// resize handling, mounted into a container element, with model edges, component
// visibility, section views, measuring and an orientation cube. Used by the React
// component and usable on its own.

import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { CSS2DRenderer } from "three/examples/jsm/renderers/CSS2DRenderer.js";
import { describe, type SwMeasureItem } from "../geometry/measure.ts";
import type { SwComponentNode, SwParseResult, Vec3 } from "../types.ts";
import { componentParents, initialHiddenComponents, isComponentHidden, partColors, setComponentHidden } from "./components.ts";
import { SwMeasureTool, type SwPinnedMeasurement } from "./measure.ts";
import { formatDimension as formatDimensionDefault, type SwMeasureMode, type SwMeasurement, type SwViewerPick } from "./measureModel.ts";
import { applyPartColors, buildSwGroup, disposeObject, fitCamera, setEdgesVisible, swMeshData } from "./scene.ts";
import { type SwBox, type SwSectionSpec, SwSectionView, sectionFromDescription } from "./section.ts";
import {
  defaultViewCubeLabels,
  type SwStandardView,
  SwViewCube,
  type SwViewCubeColors,
  type SwViewCubeLabels,
  VIEW_DIRECTIONS,
  viewCubeColorsFromCss,
} from "./viewCube.ts";

/** `file`: colours as saved in the file; `part`: one palette colour per part file (assemblies). */
export type SwColorMode = "file" | "part";

export interface SwViewerOptions {
  /** Clear color, default white. */
  background?: THREE.ColorRepresentation;
  /** Default `window.devicePixelRatio`. */
  pixelRatio?: number;
  /** Upper bound for the pixel ratio, e.g. 2 on tablets to save fill rate. */
  maxPixelRatio?: number;
  /**
   * "fixed" (default): the key light stays at world direction (1,1,1), so the shading
   * changes while orbiting, like moin-bridge's StepViewer. "headlight": the key light
   * moves with the camera.
   */
  lighting?: "fixed" | "headlight";
  /** Called after the first frame with a new model was drawn. */
  onFirstFrame?: () => void;
  /** Show the model edges (default true). */
  edges?: boolean;
  /** Initial colour mode (default "file"). */
  colorMode?: SwColorMode;
  /** Show the orientation cube in the top-right corner (default false). */
  viewCube?: boolean;
  /** Texts on the cube faces (default English). */
  viewCubeLabels?: SwViewCubeLabels;
  /**
   * Cube colours. Unset ones come from the `--sw-cube-*` custom properties on the
   * container (read when the cube is created), else the defaults.
   */
  viewCubeColors?: Partial<SwViewCubeColors>;
  /** Text of a dimension label (default `formatDimension`, e.g. `Ø20.000`). */
  formatDimension?: (item: SwMeasureItem) => string;
  /** The measurement after every selection change; null when nothing is selected. */
  onMeasure?: (measurement: SwMeasurement | null) => void;
  /** The picked elements after every selection change. */
  onSelect?: (picks: SwViewerPick[]) => void;
  /** The pinned dimensions after pinning, removing or clearing. */
  onPinsChange?: (pins: SwPinnedMeasurement[]) => void;
}

export interface SwViewer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  /** Renders the dimension labels; its element overlays the canvas. */
  readonly labelRenderer: CSS2DRenderer;
  /** Shows the meshes of `result` (or clears the model for null) and fits the camera. */
  setModel(result: SwParseResult | null): THREE.Group | null;
  /** Fits the camera to the current model again. */
  resetView(): void;
  setBackground(color: THREE.ColorRepresentation): void;
  /** Shows or hides the model edges. */
  setEdgesVisible(visible: boolean): void;
  /** Shows or hides a component and its sub-tree. */
  setComponentVisible(id: string, visible: boolean): void;
  /** Replaces the set of hidden component ids (children of hidden nodes are hidden too). */
  setHiddenComponents(ids: readonly string[]): void;
  getHiddenComponents(): string[];
  setColorMode(mode: SwColorMode): void;
  /** Sets or clears the section. */
  setSection(spec: SwSectionSpec | null): void;
  getSection(): SwSectionSpec | null;
  /** World bounding box of the model (from `result.stats`), null without a model. */
  getBox(): SwBox | null;
  /**
   * Waits for a click on a planar face (`face`: cut parallel to it) or on a cylinder,
   * cone or circle (`cylinder`: cut through its axis) and returns the section spec,
   * without applying it. Null when cancelled (Escape, `cancelSectionPick`, new model).
   */
  pickSectionTarget(kind: "face" | "cylinder"): Promise<SwSectionSpec | null>;
  cancelSectionPick(): void;
  /** Turns measuring on with a pick filter, or off with null. */
  setMeasureMode(mode: SwMeasureMode | null): void;
  getMeasurement(): SwMeasurement | null;
  /** Keeps the current dimensions on screen; null when nothing is measured. */
  pinMeasurement(): SwPinnedMeasurement | null;
  removePinnedMeasurement(id: number): void;
  getPinnedMeasurements(): SwPinnedMeasurement[];
  /** Clears the selection and the pinned dimensions. */
  clearMeasurements(): void;
  clearSelection(): void;
  /** Replaces the dimension label formatter (null: default) and redraws. */
  setMeasureFormatter(format: ((item: SwMeasureItem) => string) | null): void;
  /** Turns the camera to a standard view (or a direction from the target to the camera) and fits the model. */
  setView(view: SwStandardView | Vec3, options?: { animate?: boolean; fit?: boolean }): void;
  /** Shows, hides or rebuilds the cube; omitted labels and colours keep the current ones. */
  setViewCube(visible: boolean, labels?: SwViewCubeLabels, colors?: Partial<SwViewCubeColors>): void;
  /** Stops rendering, frees all GPU resources and releases the WebGL context. */
  dispose(): void;
}

const OVERLAY_CSS = `
:where(.sw-labels){position:absolute;inset:0;pointer-events:none;overflow:hidden}
:where(.sw-dim){background:var(--sw-dim-bg,#fff);color:var(--sw-dim,#c2410c);border:1px solid var(--sw-dim,#c2410c);border-radius:4px;padding:1px 6px;font:600 12px/1.4 system-ui,sans-serif;white-space:nowrap;font-variant-numeric:tabular-nums}
:where(.sw-dim-end){width:5px;height:5px;border-radius:50%;background:var(--sw-dim,#d9480f)}
:where(.sw-measure-point){width:8px;height:8px;border-radius:50%;background:var(--sw-pick,#3d8bfd);box-shadow:0 0 0 2px #fff,0 0 0 3px var(--sw-pick,#3d8bfd)}
:where(.sw-measure-point.sw-hover){opacity:.65}
:where(.sw-snap){width:0;height:0}
:where(.sw-snap)::before{content:"";position:absolute;left:-6px;top:-6px;width:12px;height:12px;box-sizing:border-box;border:2px solid var(--sw-snap,#1d5fc9);border-radius:50%}
:where(.sw-snap[data-kind=corner])::before{border-radius:0}
:where(.sw-snap[data-kind=midpoint])::before{border-radius:0;transform:rotate(45deg) scale(.85)}
`;

/** Adds the low-specificity default styles of the dimension labels once per document. */
const injectOverlayStyles = (doc: Document) => {
  if (doc.getElementById("sw-viewer-overlay-css")) return;
  const style = doc.createElement("style");
  style.id = "sw-viewer-overlay-css";
  style.textContent = OVERLAY_CSS;
  doc.head.prepend(style);
};

/** Avoids a degenerate up vector for straight top/bottom views. */
const safeDir = (d: THREE.Vector3) => {
  d.normalize();
  if (Math.abs(d.x) < 1e-6 && Math.abs(d.z) < 1e-6) d.set(0, Math.sign(d.y) || 1, 1e-4).normalize();
  return d;
};

/**
 * Creates the viewer inside `container`. Throws when WebGL is unavailable (or the
 * browser's context limit is reached); callers should catch that and show a fallback.
 */
export const createSwViewer = (container: HTMLElement, options: SwViewerOptions = {}): SwViewer => {
  // stencil: the closed section cap; localClipping: the section plane.
  const renderer = new THREE.WebGLRenderer({ antialias: true, stencil: true });
  renderer.localClippingEnabled = true;
  const pixelRatio = options.pixelRatio ?? window.devicePixelRatio;
  renderer.setPixelRatio(Math.min(pixelRatio, options.maxPixelRatio ?? Infinity));
  renderer.setClearColor(options.background ?? 0xffffff, 1);
  const canvas = renderer.domElement;
  canvas.style.display = "block";
  canvas.style.outline = "none";
  canvas.tabIndex = 0;
  container.prepend(canvas);

  injectOverlayStyles(container.ownerDocument);
  // The label overlay is absolutely positioned over the canvas; in a static container it
  // would align with some outer ancestor instead. Restored on dispose.
  const view = container.ownerDocument.defaultView;
  const restorePosition =
    view && view.getComputedStyle(container).position === "static" ? container.style.position : undefined;
  if (restorePosition !== undefined) container.style.position = "relative";
  const labelRenderer = new CSS2DRenderer();
  labelRenderer.domElement.className = "sw-labels";
  Object.assign(labelRenderer.domElement.style, { position: "absolute", inset: "0", pointerEvents: "none" });
  canvas.after(labelRenderer.domElement);

  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 0.7));
  const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);
  if (options.lighting === "headlight") {
    camera.add(dirLight);
  } else {
    scene.add(dirLight);
  }
  dirLight.position.set(1, 1, 1);
  scene.add(camera);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  let model: THREE.Group | null = null;
  let result: SwParseResult | null = null;
  let box: SwBox | null = null;
  let firstFramePending = false;
  let edgesVisible = options.edges ?? true;
  let colorMode: SwColorMode = options.colorMode ?? "file";
  let hidden = new Set<string>();
  let parents = new Map<string, string>();
  let components: SwComponentNode[] | undefined;

  const section = new SwSectionView();
  scene.add(section.group);
  let contourRaf = 0;
  const scheduleContours = () => {
    cancelAnimationFrame(contourRaf);
    contourRaf = requestAnimationFrame(() => {
      contourRaf = 0;
      section.updateContours();
    });
  };

  const measure = new SwMeasureTool(
    {
      canvas,
      camera,
      target: controls.target,
      scene,
      section,
      model: () => model,
      edgesVisible: () => edgesVisible,
    },
    {
      onMeasure: (m) => options.onMeasure?.(m),
      onSelect: (p) => options.onSelect?.(p),
      onPinsChange: (p) => options.onPinsChange?.(p),
    },
  );
  if (options.formatDimension) measure.format = options.formatDimension;

  let cubeLabels = options.viewCubeLabels ?? defaultViewCubeLabels;
  let cubeColors = options.viewCubeColors ?? {};
  const makeCube = () => new SwViewCube(cubeLabels, { ...viewCubeColorsFromCss(container), ...cubeColors });
  let cube: SwViewCube | null = options.viewCube ? makeCube() : null;

  // ---------- camera animation ----------
  let anim: { from: THREE.Vector3; to: THREE.Vector3; t0: THREE.Vector3; t1: THREE.Vector3; d0: number; d1: number; start: number } | null = null;
  const ANIM_MS = 400;

  const fitDistance = () => {
    if (!model || !box) return camera.position.distanceTo(controls.target);
    const maxDim = Math.max(box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]) || 1;
    return maxDim * 1.5 * Math.sqrt(3);
  };

  const setView: SwViewer["setView"] = (view, opts = {}) => {
    if (!model || !box) return;
    const dir = safeDir(new THREE.Vector3(...(typeof view === "string" ? VIEW_DIRECTIONS[view] : view)));
    const fit = opts.fit ?? true;
    const center = new THREE.Vector3((box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2, (box.min[2] + box.max[2]) / 2);
    const from = camera.position.clone().sub(controls.target);
    const d0 = from.length() || fitDistance();
    camera.up.set(0, 1, 0);
    anim = {
      from: from.normalize(),
      to: dir,
      t0: controls.target.clone(),
      t1: fit ? center : controls.target.clone(),
      d0,
      d1: fit ? fitDistance() : d0,
      start: performance.now(),
    };
    if (opts.animate === false) stepAnim(anim.start + ANIM_MS);
  };

  const stepAnim = (now: number) => {
    if (!anim) return;
    const t = Math.min(1, (now - anim.start) / ANIM_MS);
    const e = t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
    const q = new THREE.Quaternion().setFromUnitVectors(anim.from, anim.to);
    const dir = anim.from.clone().applyQuaternion(new THREE.Quaternion().slerp(q, e));
    if (t >= 1) dir.copy(anim.to);
    const target = anim.t0.clone().lerp(anim.t1, e);
    const dist = anim.d0 + (anim.d1 - anim.d0) * e;
    controls.target.copy(target);
    camera.position.copy(target).add(safeDir(dir).multiplyScalar(dist));
    const maxDim = box ? Math.max(box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]) || 1 : 1;
    camera.near = maxDim * 0.01;
    camera.far = maxDim * 100;
    camera.updateProjectionMatrix();
    camera.lookAt(target);
    if (t >= 1) anim = null;
  };

  // ---------- resize and loop ----------
  const resize = () => {
    const w = container.clientWidth;
    const h = container.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h);
    labelRenderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  const observer = new ResizeObserver(resize);
  observer.observe(container);
  resize();

  renderer.setAnimationLoop((now) => {
    if (anim) stepAnim(now);
    controls.update();
    renderer.render(scene, camera);
    labelRenderer.render(scene, camera);
    if (cube && model) cube.render(renderer, camera, controls.target);
    if (firstFramePending) {
      firstFramePending = false;
      options.onFirstFrame?.();
    }
  });

  // ---------- view cube and double click, before OrbitControls sees the events ----------
  const listeners: [EventTarget, string, EventListener, boolean][] = [];
  const listen = <E extends Event>(target: EventTarget, type: string, fn: (ev: E) => void, capture = false) => {
    target.addEventListener(type, fn as EventListener, capture);
    listeners.push([target, type, fn as EventListener, capture]);
  };
  const onCube = (ev: PointerEvent | MouseEvent) =>
    !!cube && !!model && ev.target === canvas && cube.contains(ev.clientX, ev.clientY, canvas.getBoundingClientRect());
  let cubeDown = false;
  listen<PointerEvent>(
    container,
    "pointerdown",
    (ev) => {
      canvas.focus({ preventScroll: true });
      cubeDown = onCube(ev);
      if (cubeDown) ev.stopPropagation();
    },
    true,
  );
  listen<PointerEvent>(
    container,
    "pointerup",
    (ev) => {
      if (!cubeDown) return;
      cubeDown = false;
      ev.stopPropagation();
      const dir = cube?.hit(ev.clientX, ev.clientY, canvas.getBoundingClientRect());
      if (dir) setView(dir);
    },
    true,
  );
  listen<PointerEvent>(
    container,
    "pointermove",
    (ev) => {
      if (!cube || !model || ev.buttons) return;
      const on = cube.hover(ev.clientX, ev.clientY, canvas.getBoundingClientRect());
      if (onCube(ev)) {
        ev.stopPropagation();
        canvas.style.cursor = on ? "pointer" : "";
      }
    },
    true,
  );
  listen<MouseEvent>(canvas, "dblclick", (ev) => {
    if (!model || onCube(ev) || measure.picking) return;
    const h = measure.pickAt(ev.clientX, ev.clientY, "face");
    if (h?.pick.kind !== "face") return;
    const d = describe(h.pick);
    const n = d.type === "plane" ? d.normal : d.type === "cylinder" ? d.axis : undefined;
    if (!n) return;
    // Look onto the face from the side the camera is on.
    const toCam = camera.position.clone().sub(controls.target);
    const v = new THREE.Vector3(...n);
    if (v.dot(toCam) < 0) v.negate();
    setView(v.toArray() as Vec3, { fit: false });
  });

  // ---------- model state ----------
  const applyVisibility = () => {
    if (!model) return;
    for (const o of model.children) {
      const data = swMeshData(o);
      if (!data) continue;
      o.visible = data.componentId !== undefined ? !isComponentHidden(data.componentId, hidden, parents) : data.swMesh.visible !== false;
    }
    measure.pruneHidden();
    if (section.active) scheduleContours();
  };

  const applyColors = () => {
    if (!model) return;
    applyPartColors(model, colorMode === "part" && result ? partColors(result.components, result.meshes) : null);
  };

  const clearModel = () => {
    measure.reset();
    section.setModel(null);
    if (!model) return;
    scene.remove(model);
    disposeObject(model);
    model = null;
  };

  const modelBox = (r: SwParseResult, group: THREE.Group): SwBox => {
    if (r.stats) return { min: [...r.stats.bboxMin], max: [...r.stats.bboxMax] };
    group.updateMatrixWorld(true);
    const b = new THREE.Box3().setFromObject(group);
    return { min: b.min.toArray() as Vec3, max: b.max.toArray() as Vec3 };
  };

  return {
    renderer,
    scene,
    camera,
    controls,
    labelRenderer,
    setModel(next) {
      clearModel();
      // A frame still pending for the previous model must not fire for an empty scene.
      firstFramePending = false;
      result = next;
      box = null;
      components = next?.components;
      parents = componentParents(components);
      hidden = new Set(initialHiddenComponents(next));
      if (!next?.meshes.length) return null;
      model = buildSwGroup(next.meshes);
      setEdgesVisible(model, edgesVisible);
      scene.add(model);
      box = modelBox(next, model);
      applyColors();
      applyVisibility();
      section.setModel(model, box);
      if (section.active) scheduleContours();
      anim = null;
      camera.up.set(0, 1, 0);
      fitCamera(camera, model, controls);
      firstFramePending = true;
      return model;
    },
    resetView() {
      if (!model) return;
      anim = null;
      camera.up.set(0, 1, 0);
      fitCamera(camera, model, controls);
    },
    setBackground(color) {
      renderer.setClearColor(color, 1);
    },
    setEdgesVisible(visible) {
      edgesVisible = visible;
      if (model) setEdgesVisible(model, visible);
    },
    setComponentVisible(id, visible) {
      hidden = new Set(setComponentHidden(components, [...hidden], id, visible));
      applyVisibility();
    },
    setHiddenComponents(ids) {
      hidden = new Set(ids);
      applyVisibility();
    },
    getHiddenComponents: () => [...hidden],
    setColorMode(mode) {
      colorMode = mode;
      applyColors();
    },
    setSection(spec) {
      section.set(spec);
      measure.clearSelection();
      if (spec) scheduleContours();
    },
    getSection: () => section.current,
    getBox: () => (box ? { min: [...box.min], max: [...box.max] } : null),
    async pickSectionTarget(kind) {
      for (;;) {
        const pick = await measure.waitForSectionPick(kind);
        if (!pick || !model) return null;
        const viewDir = camera.position.clone().sub(controls.target).normalize().toArray() as Vec3;
        const spec = sectionFromDescription(describe(pick), kind, { box: box ?? undefined, viewDir });
        if (spec) return spec;
      }
    },
    cancelSectionPick() {
      measure.cancelSectionPick();
    },
    setMeasureMode(mode) {
      measure.setMode(mode);
    },
    getMeasurement: () => measure.measurement,
    pinMeasurement: () => measure.pin(),
    removePinnedMeasurement(id) {
      measure.removePin(id);
    },
    getPinnedMeasurements: () => measure.pinList,
    clearMeasurements() {
      measure.clearSelection();
      measure.clearPins();
    },
    clearSelection() {
      measure.clearSelection();
    },
    setMeasureFormatter(format) {
      measure.format = format ?? ((item) => formatDimensionDefault(item));
      measure.refresh();
    },
    setView,
    setViewCube(visible, labels, colors) {
      cube?.dispose();
      if (labels) cubeLabels = labels;
      if (colors) cubeColors = colors;
      cube = visible ? makeCube() : null;
    },
    dispose() {
      observer.disconnect();
      renderer.setAnimationLoop(null);
      cancelAnimationFrame(contourRaf);
      for (const [t, type, fn, capture] of listeners) t.removeEventListener(type, fn, capture);
      clearModel();
      measure.dispose();
      section.dispose();
      cube?.dispose();
      cube = null;
      controls.dispose();
      labelRenderer.domElement.remove();
      if (restorePosition !== undefined) container.style.position = restorePosition;
      renderer.dispose();
      // Browsers cap live WebGL contexts (Safari especially); free ours right away.
      renderer.forceContextLoss();
      canvas.remove();
    },
  };
};
