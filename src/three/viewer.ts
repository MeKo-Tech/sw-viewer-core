// A complete three.js viewer for parse results: renderer, lights, orbit controls and
// resize handling, mounted into a container element. Used by the React component and
// usable on its own.

import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { SwParseResult } from "../types.ts";
import { buildSwGroup, disposeObject, fitCamera } from "./scene.ts";

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
}

export interface SwViewer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  /** Shows the meshes of `result` (or clears the model for null) and fits the camera. */
  setModel(result: SwParseResult | null): THREE.Group | null;
  /** Fits the camera to the current model again. */
  resetView(): void;
  setBackground(color: THREE.ColorRepresentation): void;
  /** Stops rendering, frees all GPU resources and releases the WebGL context. */
  dispose(): void;
}

/**
 * Creates the viewer inside `container`. Throws when WebGL is unavailable (or the
 * browser's context limit is reached); callers should catch that and show a fallback.
 */
export const createSwViewer = (container: HTMLElement, options: SwViewerOptions = {}): SwViewer => {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  const pixelRatio = options.pixelRatio ?? window.devicePixelRatio;
  renderer.setPixelRatio(Math.min(pixelRatio, options.maxPixelRatio ?? Infinity));
  renderer.setClearColor(options.background ?? 0xffffff, 1);
  renderer.domElement.style.display = "block";
  container.prepend(renderer.domElement);

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
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  let model: THREE.Group | null = null;
  let firstFramePending = false;

  const resize = () => {
    const w = container.clientWidth;
    const h = container.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  const observer = new ResizeObserver(resize);
  observer.observe(container);
  resize();

  renderer.setAnimationLoop(() => {
    controls.update();
    renderer.render(scene, camera);
    if (firstFramePending) {
      firstFramePending = false;
      options.onFirstFrame?.();
    }
  });

  const clearModel = () => {
    if (!model) return;
    scene.remove(model);
    disposeObject(model);
    model = null;
  };

  return {
    renderer,
    scene,
    camera,
    controls,
    setModel(result) {
      clearModel();
      if (!result?.meshes.length) return null;
      model = buildSwGroup(result.meshes);
      scene.add(model);
      fitCamera(camera, model, controls);
      firstFramePending = true;
      return model;
    },
    resetView() {
      if (model) fitCamera(camera, model, controls);
    },
    setBackground(color) {
      renderer.setClearColor(color, 1);
    },
    dispose() {
      observer.disconnect();
      renderer.setAnimationLoop(null);
      clearModel();
      controls.dispose();
      renderer.dispose();
      // Browsers cap live WebGL contexts (Safari especially); free ours right away.
      renderer.forceContextLoss();
      renderer.domElement.remove();
    },
  };
};
