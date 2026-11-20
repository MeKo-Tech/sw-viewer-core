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
}

export interface SwViewer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  /** Shows the meshes of `result` (or clears the model for null) and fits the camera. */
  setModel(result: SwParseResult | null): THREE.Group | null;
  setBackground(color: THREE.ColorRepresentation): void;
  /** Stops rendering and frees all GPU resources. The canvas is removed from the container. */
  dispose(): void;
}

export const createSwViewer = (container: HTMLElement, options: SwViewerOptions = {}): SwViewer => {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(options.pixelRatio ?? window.devicePixelRatio);
  renderer.setClearColor(options.background ?? 0xffffff, 1);
  renderer.domElement.style.display = "block";
  container.prepend(renderer.domElement);

  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 0.7));
  const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);
  camera.add(dirLight);
  dirLight.position.set(1, 1, 1);
  scene.add(camera);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  let model: THREE.Group | null = null;

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
      return model;
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
      renderer.domElement.remove();
    },
  };
};
