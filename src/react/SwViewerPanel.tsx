// Ready-made viewer: toolbar, 3D view with orientation cube, and a side bar with
// sheets, component tree, measurement and model info, wired together. Apps that want
// their own layout use the building blocks (SwViewer, SwToolbar, …) directly.

import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ColorRepresentation } from "three";
import type { SwMeasureItem } from "../geometry/measure.ts";
import { initialHiddenComponents } from "../three/components.ts";
import type { SwPinnedMeasurement } from "../three/measure.ts";
import { formatDimension as formatDimensionDefault, type SwMeasureMode, type SwMeasurement } from "../three/measureModel.ts";
import type { SwBox, SwSectionSpec } from "../three/section.ts";
import { defaultViewCubeLabels } from "../three/viewCube.ts";
import type { SwColorMode, SwViewer as SwViewerInstance } from "../three/viewer.ts";
import type { SwParseResult } from "../types.ts";
import { cx } from "./helpers.ts";
import {
  type DeepPartial,
  defaultViewerPanelLabels,
  mergeLabels,
  type SwViewerPanelLabels,
} from "./labels.ts";
import { SwComponentTree } from "./SwComponentTree.tsx";
import { SwInfoPanel } from "./SwInfoPanel.tsx";
import { SwMeasurePanel } from "./SwMeasurePanel.tsx";
import { SwSheets, useSheetUrls } from "./SwSheets.tsx";
import { SwToolbar } from "./SwToolbar.tsx";
import { SwViewer, type SwViewerSetup } from "./SwViewer.tsx";
import { type SwSource, useSwParse } from "./useSwParse.ts";

export interface SwViewerPanelProps {
  /** File or bytes to parse. Requires `createWorker`. */
  source?: SwSource | null;
  createWorker?: () => Worker;
  /** Already parsed result; takes precedence over `source`. */
  result?: SwParseResult | null;
  timeoutMs?: number;
  /** File name for the info panel (default: `source.name` for a File). */
  fileName?: string;
  labels?: DeepPartial<SwViewerPanelLabels>;
  /** Number locale, e.g. `de-DE` (default `en-US`). */
  locale?: string;
  /** Measure mode on load (default "auto"; null: off). */
  defaultMeasureMode?: SwMeasureMode | null;
  /** Edges on load (default true). */
  defaultEdges?: boolean;
  /** Orientation cube (default true). */
  viewCube?: boolean;
  /** Side bar with sheets, tree, measurement and info (default true). */
  sidebar?: boolean;
  /** Density in g/cm³ for the mass (default 7.85). */
  defaultDensity?: number;
  onDensityChange?: (density: number) => void;
  /** Text of dimension labels (default `formatDimension` with `locale`). */
  formatDimension?: (item: SwMeasureItem) => string;
  /** Value with unit in the measure panel (default `formatMeasureValue` with `locale`). */
  formatValue?: (item: SwMeasureItem) => string;
  background?: ColorRepresentation;
  viewerOptions?: SwViewerSetup;
  onResult?: (result: SwParseResult) => void;
  onError?: (error: Error) => void;
  onReady?: (viewer: SwViewerInstance | null) => void;
  onMeasure?: (measurement: SwMeasurement | null) => void;
  className?: string;
  style?: CSSProperties;
}

const missingWorker = (): Worker => {
  throw new Error("SwViewerPanel: createWorker is required when source is set");
};

export function SwViewerPanel({
  source = null,
  createWorker,
  result: given = null,
  timeoutMs,
  fileName,
  labels: partial,
  locale,
  defaultMeasureMode = "auto",
  defaultEdges = true,
  viewCube = true,
  sidebar = true,
  defaultDensity,
  onDensityChange,
  formatDimension,
  formatValue,
  background,
  viewerOptions,
  onResult,
  onError,
  onReady,
  onMeasure,
  className,
  style,
}: SwViewerPanelProps) {
  if (source && !given && !createWorker) throw new Error("SwViewerPanel: createWorker is required when source is set");
  const L = mergeLabels(defaultViewerPanelLabels, partial);
  const parse = useSwParse(given ? null : source, createWorker ?? missingWorker, { timeoutMs });
  const result = given ?? (parse.status === "done" ? parse.result : null);
  const name = fileName ?? (typeof File !== "undefined" && source instanceof File ? source.name : undefined);

  const viewerRef = useRef<SwViewerInstance | null>(null);
  const [edges, setEdges] = useState(defaultEdges);
  const [colorMode, setColorMode] = useState<SwColorMode>("file");
  const [measureMode, setMeasureMode] = useState<SwMeasureMode | null>(defaultMeasureMode);
  const [section, setSection] = useState<SwSectionSpec | null>(null);
  const [picking, setPicking] = useState<"face" | "cylinder" | null>(null);
  // Hidden ids belong to the result they were set for; a new result starts from its
  // saved state in the same render, so stale ids never reach the new model.
  const [hiddenState, setHiddenState] = useState<{ result: SwParseResult | null; ids: string[] }>({ result: null, ids: [] });
  const hidden = useMemo(
    () => (hiddenState.result === result ? hiddenState.ids : initialHiddenComponents(result)),
    [hiddenState, result],
  );
  const setHidden = useCallback((ids: string[]) => setHiddenState({ result, ids }), [result]);
  const [measurement, setMeasurement] = useState<SwMeasurement | null>(null);
  const [pins, setPins] = useState<SwPinnedMeasurement[]>([]);
  const [sheet, setSheet] = useState<number | null>(null);
  const sheetUrls = useSheetUrls(result?.sheets);

  // Per-model state starts over with every new result.
  useEffect(() => {
    setSection(null);
    setPicking(null);
    setMeasurement(null);
    setPins([]);
    setSheet(result && !result.meshes.length && result.sheets?.length ? 0 : null);
  }, [result]);

  const onResultRef = useRef(onResult);
  const onErrorRef = useRef(onError);
  useEffect(() => {
    onResultRef.current = onResult;
    onErrorRef.current = onError;
  });
  useEffect(() => {
    if (parse.status === "done") onResultRef.current?.(parse.result);
    else if (parse.status === "error") onErrorRef.current?.(parse.error);
  }, [parse]);

  const box: SwBox | null = useMemo(
    () => (result?.stats ? { min: result.stats.bboxMin, max: result.stats.bboxMax } : null),
    [result],
  );

  const pickSection = useCallback((kind: "face" | "cylinder") => {
    const v = viewerRef.current;
    if (!v) return;
    setPicking(kind);
    v.pickSectionTarget(kind).then((spec) => {
      setPicking((cur) => (cur === kind ? null : cur));
      if (spec) setSection(spec);
    });
  }, []);

  const hasModel = !!result?.meshes.length;
  const status =
    parse.status === "parsing" ? L.loading : parse.status === "error" ? L.error(parse.error) : result && !hasModel && !result.preview && !result.sheets?.length ? L.empty : null;

  return (
    <div className={cx("sw-panel", className)} style={style}>
      <SwToolbar
        className="sw-panel-toolbar"
        labels={L.toolbar}
        edges={edges}
        onEdgesChange={hasModel ? setEdges : undefined}
        colorMode={colorMode}
        onColorModeChange={hasModel && result?.components?.length ? setColorMode : undefined}
        measureMode={measureMode}
        onMeasureModeChange={hasModel ? setMeasureMode : undefined}
        section={section}
        onSectionChange={hasModel ? setSection : undefined}
        box={box}
        onPickSection={hasModel ? pickSection : undefined}
        sectionPicking={picking}
        onCancelPick={() => viewerRef.current?.cancelSectionPick()}
        onView={hasModel ? (v) => viewerRef.current?.setView(v) : undefined}
        onResetView={hasModel ? () => viewerRef.current?.setView("iso") : undefined}
        locale={locale}
      />
      <div className="sw-panel-body">
        <div className="sw-panel-stage">
          <SwViewer
            className="sw-panel-viewer"
            result={result}
            background={background}
            viewerOptions={viewerOptions}
            edges={edges}
            colorMode={colorMode}
            section={section}
            measureMode={measureMode}
            hiddenComponents={hidden}
            viewCube={viewCube}
            viewCubeLabels={{ ...defaultViewCubeLabels, ...L.viewCube }}
            formatDimension={formatDimension ?? ((item) => formatDimensionDefault(item, { locale }))}
            onMeasure={(m) => {
              setMeasurement(m);
              onMeasure?.(m);
            }}
            onPinsChange={setPins}
            onError={onError}
            onReady={(v) => {
              viewerRef.current = v;
              onReady?.(v);
            }}
          />
          {sheet !== null && sheetUrls[sheet] ? (
            <div className="sw-sheet-view">
              <img src={sheetUrls[sheet]} alt={L.sheets.sheet?.(result?.sheets?.[sheet]?.name ?? "", sheet) ?? ""} />
            </div>
          ) : null}
          {status ? (
            <div className={cx("sw-status", parse.status === "error" && "sw-status-error")} role="status">
              {status}
            </div>
          ) : null}
        </div>
        {sidebar && result ? (
          <aside className="sw-panel-side">
            {result.sheets?.length ? (
              <SwSheets sheets={result.sheets} urls={sheetUrls} selected={sheet} onSelect={setSheet} hasModel={hasModel} labels={L.sheets} />
            ) : null}
            {result.components?.length ? (
              <SwComponentTree components={result.components} meshes={result.meshes} hidden={hidden} onHiddenChange={setHidden} labels={L.tree} />
            ) : null}
            {hasModel ? (
              <SwMeasurePanel
                measurement={measurement}
                pins={pins}
                mode={measureMode}
                components={result.components}
                onPin={() => viewerRef.current?.pinMeasurement()}
                onRemovePin={(id) => viewerRef.current?.removePinnedMeasurement(id)}
                onClear={() => viewerRef.current?.clearMeasurements()}
                formatValue={formatValue}
                locale={locale}
                labels={L.measure}
              />
            ) : null}
            <SwInfoPanel result={result} fileName={name} defaultDensity={defaultDensity} onDensityChange={onDensityChange} locale={locale} labels={L.info} />
          </aside>
        ) : null}
      </div>
    </div>
  );
}
