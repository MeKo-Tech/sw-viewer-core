// The state behind SwViewerPanel as a hook, for apps that lay out the building blocks
// themselves: viewer toggles, section picking, hidden components, measurement, pins,
// the selected drawing sheet and the first-frame flag, reset for every new result,
// plus ready-made props for <SwViewer>, <SwToolbar>, <SwSheets>, <SwSheetView>,
// <SwComponentTree> and <SwMeasurePanel>.

import { type RefObject, useCallback, useEffect, useRef, useState } from "react";
import type { SwMeasureItem } from "../geometry/measure.ts";
import { initialHiddenComponents } from "../three/components.ts";
import type { SwPinnedMeasurement } from "../three/measure.ts";
import { formatDimension as formatDimensionDefault, type SwMeasureMode, type SwMeasurement } from "../three/measureModel.ts";
import type { SwBox, SwSectionSpec } from "../three/section.ts";
import type { SwColorMode, SwViewer as SwViewerInstance } from "../three/viewer.ts";
import type { SwParseResult, SwSheet } from "../types.ts";
import type { SwComponentTreeProps } from "./SwComponentTree.tsx";
import type { SwMeasurePanelProps } from "./SwMeasurePanel.tsx";
import { useSheetUrls } from "./SwSheets.tsx";
import type { SwToolbarProps } from "./SwToolbar.tsx";
import type { SwViewerProps } from "./SwViewer.tsx";

export interface UseSwViewerStateOptions {
  /** Measure mode on load (default "auto"; null: off, e.g. on touch screens). */
  defaultMeasureMode?: SwMeasureMode | null;
  /** Edges on load (default true). */
  defaultEdges?: boolean;
  /** Colour mode on load (default "file"). */
  defaultColorMode?: SwColorMode;
  /** Number locale of the dimension labels and the toolbar, e.g. `de-DE`. */
  locale?: string;
  /** Text of dimension labels (default `formatDimension` with `locale`). */
  formatDimension?: (item: SwMeasureItem) => string;
  onMeasure?: (measurement: SwMeasurement | null) => void;
  onReady?: (viewer: SwViewerInstance | null) => void;
  onFirstFrame?: () => void;
}

/** Props for `<SwViewer>`; add your own (`viewCube`, `background`, `onError`, …). */
export type SwViewerStateViewerProps = Required<
  Pick<
    SwViewerProps,
    "edges" | "colorMode" | "section" | "measureMode" | "hiddenComponents" | "formatDimension" | "onMeasure" | "onPinsChange" | "onReady" | "onFirstFrame"
  >
> & { result: SwParseResult | null };

/** Props for `<SwToolbar>`: a group's handler is unset while it does not apply (no model, or a sheet is shown). */
export type SwViewerStateToolbarProps = Pick<
  SwToolbarProps,
  | "edges"
  | "onEdgesChange"
  | "colorMode"
  | "onColorModeChange"
  | "measureMode"
  | "onMeasureModeChange"
  | "section"
  | "onSectionChange"
  | "box"
  | "onPickSection"
  | "sectionPicking"
  | "onCancelPick"
  | "onView"
  | "onResetView"
  | "locale"
>;

/** Props for `<SwSheets>`. */
export interface SwViewerStateSheetsProps {
  sheets: readonly SwSheet[];
  urls: readonly string[];
  selected: number | null;
  onSelect: (index: number | null) => void;
  hasModel: boolean;
}

/** Props for `<SwSheetView>`. */
export interface SwViewerStateSheetViewProps {
  sheets: readonly SwSheet[];
  urls: readonly string[];
  index: number;
}

export interface SwViewerState {
  /** The viewer instance (set through `viewerProps.onReady`). */
  viewerRef: RefObject<SwViewerInstance | null>;
  /** The result has display meshes. */
  hasModel: boolean;
  /** The 3D model is on screen: it has meshes and no sheet is shown. Gates the 3D tools. */
  modelTools: boolean;
  /**
   * The first frame of the current result was drawn, or it has nothing to draw (sheets
   * or thumbnail only). False while there is no result, and when WebGL failed.
   */
  ready: boolean;
  edges: boolean;
  setEdges: (edges: boolean) => void;
  colorMode: SwColorMode;
  setColorMode: (mode: SwColorMode) => void;
  measureMode: SwMeasureMode | null;
  setMeasureMode: (mode: SwMeasureMode | null) => void;
  section: SwSectionSpec | null;
  setSection: (section: SwSectionSpec | null) => void;
  /** Set while the viewer waits for the click that places a section. */
  picking: "face" | "cylinder" | null;
  /** Waits for a click on a face or a cylinder and applies the section it gives. */
  pickSection: (kind: "face" | "cylinder") => void;
  cancelPick: () => void;
  hidden: readonly string[];
  setHidden: (ids: string[]) => void;
  measurement: SwMeasurement | null;
  pins: readonly SwPinnedMeasurement[];
  /** Selected sheet index, or null for the 3D model. */
  sheet: number | null;
  setSheet: (index: number | null) => void;
  /** Object URLs of the sheet images. */
  sheetUrls: readonly string[];
  /** Model box from `result.stats`, for the section slider. */
  box: SwBox | null;
  viewerProps: SwViewerStateViewerProps;
  toolbarProps: SwViewerStateToolbarProps;
  /** Null without sheets. */
  sheetsProps: SwViewerStateSheetsProps | null;
  /** Null while the 3D model is shown. */
  sheetViewProps: SwViewerStateSheetViewProps | null;
  /** Null without a component tree. */
  treeProps: Pick<SwComponentTreeProps, "components" | "meshes" | "hidden" | "onHiddenChange"> | null;
  /** Null without a model. */
  measureProps: Pick<SwMeasurePanelProps, "measurement" | "pins" | "mode" | "components" | "onPin" | "onRemovePin" | "onClear" | "locale"> | null;
}

/** State that belongs to one result and starts over with the next. */
interface ModelState {
  result: SwParseResult | null;
  section: SwSectionSpec | null;
  picking: "face" | "cylinder" | null;
  hidden: string[];
  measurement: SwMeasurement | null;
  pins: SwPinnedMeasurement[];
  sheet: number | null;
  frame: boolean;
}

const modelState = (result: SwParseResult | null): ModelState => ({
  result,
  section: null,
  picking: null,
  hidden: initialHiddenComponents(result),
  measurement: null,
  pins: [],
  // A drawing without a 3D model opens on its first sheet.
  sheet: result && !result.meshes.length && result.sheets?.length ? 0 : null,
  frame: false,
});

/**
 * Viewer state for a result, with props for the building blocks. Per-model state
 * (section, picking, hidden components, measurement, pins, sheet) starts over when
 * `result` changes; edges, colour mode and measure mode stay.
 *
 * ```tsx
 * const s = useSwViewerState(result, { defaultMeasureMode: null });
 * <SwToolbar {...s.toolbarProps} labels={labels.toolbar} />
 * <SwViewer {...s.viewerProps} viewCube />
 * {s.sheetViewProps && <SwSheetView {...s.sheetViewProps} />}
 * {s.treeProps && <SwComponentTree {...s.treeProps} />}
 * ```
 */
export function useSwViewerState(result: SwParseResult | null, options: UseSwViewerStateOptions = {}): SwViewerState {
  const { defaultMeasureMode = "auto", defaultEdges = true, defaultColorMode = "file", locale, formatDimension } = options;
  const viewerRef = useRef<SwViewerInstance | null>(null);
  const [edges, setEdges] = useState(defaultEdges);
  const [colorMode, setColorMode] = useState<SwColorMode>(defaultColorMode);
  const [measureMode, setMeasureMode] = useState<SwMeasureMode | null>(defaultMeasureMode);

  // Adjusted during render, so a new result never renders with the previous one's state.
  const [stored, setStored] = useState(() => modelState(result));
  let model = stored;
  if (stored.result !== result) {
    model = modelState(result);
    setStored(model);
  }
  /** Patches the state of `forResult` only; late callbacks of an old result are dropped. */
  const patch = useCallback(
    (forResult: SwParseResult | null, p: Partial<Omit<ModelState, "result">>) =>
      setStored((m) => (m.result === forResult ? { ...m, ...p } : m)),
    [],
  );

  const optionsRef = useRef(options);
  useEffect(() => {
    optionsRef.current = options;
  });

  const sheetUrls = useSheetUrls(result?.sheets);
  const hasModel = !!result?.meshes.length;
  const modelTools = hasModel && model.sheet === null;
  const ready = !!result && (!hasModel || model.frame);
  const box: SwBox | null = result?.stats ? { min: result.stats.bboxMin, max: result.stats.bboxMax } : null;

  const pickSection = (kind: "face" | "cylinder") => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    const forResult = result;
    patch(forResult, { picking: kind });
    // Resolves with null when cancelled (Escape, cancelPick, a new model); never rejects.
    void viewer.pickSectionTarget(kind).then((spec) => {
      setStored((m) => (m.result !== forResult ? m : { ...m, picking: m.picking === kind ? null : m.picking, section: spec ?? m.section }));
    });
  };
  const cancelPick = () => viewerRef.current?.cancelSectionPick();
  const setSection = (section: SwSectionSpec | null) => patch(result, { section });
  const setHidden = (hidden: string[]) => patch(result, { hidden });
  const setSheet = (sheet: number | null) => patch(result, { sheet });

  const viewerProps: SwViewerStateViewerProps = {
    result,
    edges,
    colorMode,
    section: model.section,
    measureMode,
    hiddenComponents: model.hidden,
    formatDimension: formatDimension ?? ((item) => formatDimensionDefault(item, { locale })),
    onMeasure: (m) => {
      patch(result, { measurement: m });
      optionsRef.current.onMeasure?.(m);
    },
    onPinsChange: (pins) => patch(result, { pins }),
    onReady: (v) => {
      viewerRef.current = v;
      optionsRef.current.onReady?.(v);
    },
    onFirstFrame: () => {
      patch(result, { frame: true });
      optionsRef.current.onFirstFrame?.();
    },
  };

  const toolbarProps: SwViewerStateToolbarProps = {
    edges,
    onEdgesChange: modelTools ? setEdges : undefined,
    colorMode,
    onColorModeChange: modelTools && result?.components?.length ? setColorMode : undefined,
    measureMode,
    onMeasureModeChange: modelTools ? setMeasureMode : undefined,
    section: model.section,
    onSectionChange: modelTools ? setSection : undefined,
    box,
    onPickSection: modelTools ? pickSection : undefined,
    sectionPicking: model.picking,
    onCancelPick: cancelPick,
    onView: modelTools ? (v) => viewerRef.current?.setView(v) : undefined,
    onResetView: modelTools ? () => viewerRef.current?.setView("iso") : undefined,
    locale,
  };

  const sheets = result?.sheets;
  return {
    viewerRef,
    hasModel,
    modelTools,
    ready,
    edges,
    setEdges,
    colorMode,
    setColorMode,
    measureMode,
    setMeasureMode,
    section: model.section,
    setSection,
    picking: model.picking,
    pickSection,
    cancelPick,
    hidden: model.hidden,
    setHidden,
    measurement: model.measurement,
    pins: model.pins,
    sheet: model.sheet,
    setSheet,
    sheetUrls,
    box,
    viewerProps,
    toolbarProps,
    sheetsProps: sheets?.length ? { sheets, urls: sheetUrls, selected: model.sheet, onSelect: setSheet, hasModel } : null,
    sheetViewProps: sheets?.length && model.sheet !== null ? { sheets, urls: sheetUrls, index: model.sheet } : null,
    treeProps: result?.components?.length
      ? { components: result.components, meshes: result.meshes, hidden: model.hidden, onHiddenChange: setHidden }
      : null,
    measureProps: hasModel
      ? {
          measurement: model.measurement,
          pins: model.pins,
          mode: measureMode,
          components: result?.components,
          onPin: () => viewerRef.current?.pinMeasurement(),
          onRemovePin: (id) => viewerRef.current?.removePinnedMeasurement(id),
          onClear: () => viewerRef.current?.clearMeasurements(),
          locale,
        }
      : null,
  };
}
