// React wrapper around createSwViewer: parses a source in a worker (or takes an
// already parsed result), shows its meshes, and falls back to the embedded
// thumbnail when the file has no display mesh.

import { type CSSProperties, type HTMLAttributes, type ReactNode, useEffect, useRef, useState } from "react";
import type { ColorRepresentation } from "three";
import type { SwMeasureItem } from "../geometry/measure.ts";
import type { SwPinnedMeasurement } from "../three/measure.ts";
import { formatDimension as defaultFormatDimension, type SwMeasureMode, type SwMeasurement, type SwViewerPick } from "../three/measureModel.ts";
import type { SwSectionSpec } from "../three/section.ts";
import type { SwViewCubeLabels } from "../three/viewCube.ts";
import {
  createSwViewer,
  type SwColorMode,
  type SwViewer as SwViewerInstance,
  type SwViewerOptions,
} from "../three/viewer.ts";
import type { SwParseResult } from "../types.ts";
import { type SwSource, useSwParse } from "./useSwParse.ts";

/** Viewer setup, read once on mount. */
export type SwViewerSetup = Pick<SwViewerOptions, "pixelRatio" | "maxPixelRatio" | "lighting">;

type DivAttributes = Omit<HTMLAttributes<HTMLDivElement>, "onError" | "onSelect" | "children" | "className" | "style">;

export interface SwViewerProps extends DivAttributes {
  /** File or bytes to parse. Requires `createWorker`. */
  source?: SwSource | null;
  /** Worker factory. With Vite: `import SwParseWorker from "@meko-tech/sw-viewer-core/worker?worker"`, then `() => new SwParseWorker()`. */
  createWorker?: () => Worker;
  /** Already parsed result; takes precedence over `source`. */
  result?: SwParseResult | null;
  timeoutMs?: number;
  /** Clear color, default white. */
  background?: ColorRepresentation;
  onResult?: (result: SwParseResult) => void;
  /** Parse errors, and WebGL errors when the viewer cannot be created. */
  onError?: (error: Error) => void;
  /** Called after the first frame with a new model was drawn, e.g. to hide an overlay. */
  onFirstFrame?: () => void;
  /** The viewer instance after mount (null on unmount), e.g. for `resetView()`. */
  onReady?: (viewer: SwViewerInstance | null) => void;
  /** Pixel ratio and lighting; changes after mount are ignored. */
  viewerOptions?: SwViewerSetup;
  /** Show the embedded thumbnail when there is no mesh (default true). */
  preview?: boolean;
  /** Show the model edges (default true). */
  edges?: boolean;
  /** `file` (default): file colours; `part`: one colour per part file. */
  colorMode?: SwColorMode;
  /** Section plane, or null/undefined for none. */
  section?: SwSectionSpec | null;
  /** Measure pick filter; null/undefined turns measuring off. */
  measureMode?: SwMeasureMode | null;
  /**
   * Hidden component ids (controlled). Without it, the viewer starts with the components
   * SolidWorks saved as hidden; see `initialHiddenComponents`.
   */
  hiddenComponents?: readonly string[];
  /** Orientation cube in the top-right corner (default false). */
  viewCube?: boolean;
  /** Texts on the cube faces (default English). */
  viewCubeLabels?: SwViewCubeLabels;
  /** Text of dimension labels (default `formatDimension`); used for dimensions drawn afterwards. */
  formatDimension?: (item: SwMeasureItem) => string;
  onMeasure?: (measurement: SwMeasurement | null) => void;
  onSelect?: (picks: SwViewerPick[]) => void;
  onPinsChange?: (pins: SwPinnedMeasurement[]) => void;
  className?: string;
  style?: CSSProperties;
  /** Overlay rendered inside the container, e.g. a spinner. */
  children?: ReactNode;
}

const missingWorker = (): Worker => {
  throw new Error("SwViewer: createWorker is required when source is set");
};

const fillStyle: CSSProperties = { position: "absolute", inset: 0 };

const previewStyle: CSSProperties = {
  position: "absolute",
  inset: 0,
  margin: "auto",
  maxWidth: "100%",
  maxHeight: "100%",
  objectFit: "contain",
  pointerEvents: "none",
};

export function SwViewer({
  source = null,
  createWorker,
  result = null,
  timeoutMs,
  background = 0xffffff,
  onResult,
  onError,
  onFirstFrame,
  onReady,
  viewerOptions,
  preview = true,
  edges = true,
  colorMode = "file",
  section = null,
  measureMode = null,
  hiddenComponents,
  viewCube = false,
  viewCubeLabels,
  formatDimension,
  onMeasure,
  onSelect,
  onPinsChange,
  className,
  style,
  children,
  ...divProps
}: SwViewerProps) {
  if (source && !createWorker) {
    throw new Error("SwViewer: createWorker is required when source is set");
  }

  const parse = useSwParse(result ? null : source, createWorker ?? missingWorker, { timeoutMs });
  const effective = result ?? (parse.status === "done" ? parse.result : null);

  // Callbacks through refs, so inline functions neither retrigger effects nor fire twice.
  const onResultRef = useRef(onResult);
  const onErrorRef = useRef(onError);
  const onFirstFrameRef = useRef(onFirstFrame);
  const onReadyRef = useRef(onReady);
  const onMeasureRef = useRef(onMeasure);
  const onSelectRef = useRef(onSelect);
  const onPinsChangeRef = useRef(onPinsChange);
  const formatRef = useRef(formatDimension);
  useEffect(() => {
    onResultRef.current = onResult;
    onErrorRef.current = onError;
    onFirstFrameRef.current = onFirstFrame;
    onReadyRef.current = onReady;
    onMeasureRef.current = onMeasure;
    onSelectRef.current = onSelect;
    onPinsChangeRef.current = onPinsChange;
    formatRef.current = formatDimension;
  });
  const notifiedRef = useRef<unknown>(null);
  useEffect(() => {
    if (notifiedRef.current === parse) return;
    notifiedRef.current = parse;
    if (parse.status === "done") onResultRef.current?.(parse.result);
    else if (parse.status === "error") onErrorRef.current?.(parse.error);
  }, [parse]);

  // Viewer lifecycle. Effects run in declaration order, so the model effect below
  // always sees the viewer of the current mount (also under StrictMode remounts).
  const canvasHostRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<SwViewerInstance | null>(null);
  const backgroundRef = useRef(background);
  backgroundRef.current = background;
  const setupRef = useRef(viewerOptions);
  // Current state for a (re)created viewer, e.g. after a StrictMode remount.
  const initialRef = useRef({ edges, colorMode, viewCube, viewCubeLabels });
  initialRef.current = { edges, colorMode, viewCube, viewCubeLabels };
  useEffect(() => {
    const host = canvasHostRef.current;
    if (!host) return;
    let viewer: SwViewerInstance;
    try {
      viewer = createSwViewer(host, {
        ...setupRef.current,
        background: backgroundRef.current,
        ...initialRef.current,
        onFirstFrame: () => onFirstFrameRef.current?.(),
        onMeasure: (m) => onMeasureRef.current?.(m),
        onSelect: (p) => onSelectRef.current?.(p),
        onPinsChange: (p) => onPinsChangeRef.current?.(p),
        formatDimension: (item) => (formatRef.current ?? defaultFormatDimension)(item),
      });
    } catch (err) {
      // No WebGL, or the browser's context limit: report it instead of crashing the tree.
      onErrorRef.current?.(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    viewerRef.current = viewer;
    onReadyRef.current?.(viewer);
    return () => {
      viewerRef.current = null;
      onReadyRef.current?.(null);
      viewer.dispose();
    };
  }, []);

  useEffect(() => {
    viewerRef.current?.setModel(effective);
  }, [effective]);

  useEffect(() => {
    if (hiddenComponents) viewerRef.current?.setHiddenComponents(hiddenComponents);
  }, [hiddenComponents, effective]);

  useEffect(() => {
    viewerRef.current?.setSection(section);
  }, [section]);

  useEffect(() => {
    viewerRef.current?.setMeasureMode(measureMode);
  }, [measureMode]);

  useEffect(() => {
    viewerRef.current?.setEdgesVisible(edges);
  }, [edges]);

  useEffect(() => {
    viewerRef.current?.setColorMode(colorMode);
  }, [colorMode]);

  // The initial cube comes from the options; later toggles and label changes go here.
  const cubeKey = `${viewCube}:${JSON.stringify(viewCubeLabels ?? null)}`;
  const cubeKeyRef = useRef(cubeKey);
  useEffect(() => {
    if (cubeKeyRef.current === cubeKey) return;
    cubeKeyRef.current = cubeKey;
    viewerRef.current?.setViewCube(viewCube, viewCubeLabels);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cubeKey]);

  useEffect(() => {
    viewerRef.current?.setBackground(background);
  }, [background]);

  // Thumbnail fallback for results without display meshes.
  const previewBytes = preview && effective && !effective.meshes.length ? effective.preview : undefined;
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!previewBytes?.length) {
      setPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(new Blob([previewBytes as Uint8Array<ArrayBuffer>], { type: "image/png" }));
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [previewBytes]);

  return (
    <div {...divProps} className={className} style={{ ...style, position: "relative" }}>
      <div ref={canvasHostRef} style={fillStyle} />
      {previewUrl && previewBytes ? <img src={previewUrl} alt="" style={previewStyle} /> : null}
      {children}
    </div>
  );
}
