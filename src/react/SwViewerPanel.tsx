// Ready-made viewer: toolbar, 3D view with orientation cube, and a side bar with
// sheets, component tree, measurement and model info, wired together by
// useSwViewerState. Apps that want their own layout use that hook with the building
// blocks (SwViewer, SwToolbar, …) directly.

import { type CSSProperties, type KeyboardEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";
import type { ColorRepresentation } from "three";
import type { SwMeasureItem } from "../geometry/measure.ts";
import type { SwMeasureMode, SwMeasurement } from "../three/measureModel.ts";
import type { SwStandardView, SwViewCubeColors } from "../three/viewCube.ts";
import type { SwViewer as SwViewerInstance } from "../three/viewer.ts";
import type { SwParseResult } from "../types.ts";
import { cx } from "./helpers.ts";
import { type DeepPartial, defaultViewerPanelLabels, mergeLabels, type SwViewerPanelLabels } from "./labels.ts";
import { SwComponentTree } from "./SwComponentTree.tsx";
import { SwInfoPanel } from "./SwInfoPanel.tsx";
import { SwMeasurePanel } from "./SwMeasurePanel.tsx";
import { SwSheets, SwSheetView } from "./SwSheets.tsx";
import { SwToolbar } from "./SwToolbar.tsx";
import { SwViewer, type SwViewerSetup } from "./SwViewer.tsx";
import { useSwViewerState } from "./useSwViewerState.ts";
import { type SwSource, useSwParse } from "./useSwParse.ts";

/** `side`: a column next to the model; `drawer`: slides over the model; false: none. */
export type SwSidebarMode = "side" | "drawer";

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
  /** Cube colours (else the `--sw-cube-*` variables, else the defaults). */
  viewCubeColors?: Partial<SwViewCubeColors>;
  /** Standard views offered in the toolbar (default front, top, right, iso; `[]`: only "fit"). */
  views?: readonly SwStandardView[];
  /**
   * Side bar with sheets, tree, measurement and info: `"side"` (or true, the default) as
   * a column, `"drawer"` over the model (tablets), false for none.
   */
  sidebar?: boolean | SwSidebarMode;
  /** Side bar open (controlled). */
  sidebarOpen?: boolean;
  /** Side bar open on load when uncontrolled (default: open as a column, closed as a drawer). */
  defaultSidebarOpen?: boolean;
  onSidebarOpenChange?: (open: boolean) => void;
  /** Toolbar button that opens and closes the side bar (default: shown for the drawer only). */
  sidebarToggle?: boolean;
  /** Show the components' saved file paths as tooltips in the tree (default false). */
  showComponentPaths?: boolean;
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
  /** After the first frame of a new model was drawn. */
  onFirstFrame?: () => void;
  onMeasure?: (measurement: SwMeasurement | null) => void;
  /** Extra controls at the end of the toolbar. */
  toolbarExtra?: ReactNode;
  /**
   * Shown over the model until it is on screen (while there is no result, then until
   * its first frame), e.g. a spinner; not after a parse error.
   */
  loadingOverlay?: ReactNode;
  /** Rendered inside the model area (a positioned box), e.g. own overlays. */
  children?: ReactNode;
  className?: string;
  style?: CSSProperties;
}

const missingWorker = (): Worker => {
  throw new Error("SwViewerPanel: createWorker is required when source is set");
};

const PanelIcon = ({ open }: { open: boolean }) => (
  <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M15 4v16" />
    <path d={open ? "m8 10 2 2-2 2" : "m10 10-2 2 2 2"} />
  </svg>
);

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
  viewCubeColors,
  views,
  sidebar = true,
  sidebarOpen,
  defaultSidebarOpen,
  onSidebarOpenChange,
  sidebarToggle,
  showComponentPaths = false,
  defaultDensity,
  onDensityChange,
  formatDimension,
  formatValue,
  background,
  viewerOptions,
  onResult,
  onError,
  onReady,
  onFirstFrame,
  onMeasure,
  toolbarExtra,
  loadingOverlay,
  children,
  className,
  style,
}: SwViewerPanelProps) {
  if (source && !given && !createWorker) throw new Error("SwViewerPanel: createWorker is required when source is set");
  const L = mergeLabels(defaultViewerPanelLabels, partial);
  const parse = useSwParse(given ? null : source, createWorker ?? missingWorker, { timeoutMs });
  const result = given ?? (parse.status === "done" ? parse.result : null);
  const name = fileName ?? (typeof File !== "undefined" && source instanceof File ? source.name : undefined);
  const s = useSwViewerState(result, { defaultMeasureMode, defaultEdges, locale, formatDimension, onMeasure, onReady, onFirstFrame });

  const mode: SwSidebarMode | null = sidebar === true ? "side" : sidebar === false ? null : sidebar;
  const [ownOpen, setOwnOpen] = useState(defaultSidebarOpen ?? mode !== "drawer");
  const open = sidebarOpen ?? ownOpen;
  const setOpen = (next: boolean) => {
    setOwnOpen(next);
    onSidebarOpenChange?.(next);
  };
  const showToggle = !!mode && !!result && (sidebarToggle ?? mode === "drawer");
  const sideId = useId();

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

  const parseError = parse.status === "error" ? parse.error : null;
  const status =
    parse.status === "parsing" && !loadingOverlay
      ? (L.loading ?? null)
      : parseError
        ? (L.error?.(parseError) ?? parseError.message)
        : result && !s.hasModel && !result.preview && !result.sheets?.length
          ? L.empty
          : null;
  const sideShown = !!mode && !!result;

  return (
    <div className={cx("sw-panel", className)} style={style} data-sidebar={mode ?? undefined}>
      <SwToolbar className="sw-panel-toolbar" labels={L.toolbar} views={views} {...s.toolbarProps}>
        {toolbarExtra}
        {showToggle ? (
          <button
            type="button"
            className="sw-btn sw-btn-icon sw-sidebar-toggle"
            aria-expanded={open}
            aria-controls={sideId}
            aria-label={open ? L.sidebarHide : L.sidebarShow}
            title={open ? L.sidebarHide : L.sidebarShow}
            onClick={() => setOpen(!open)}
          >
            <PanelIcon open={open} />
          </button>
        ) : null}
      </SwToolbar>
      <div className="sw-panel-body" data-side={sideShown && mode === "side" && open ? "" : undefined}>
        <div className="sw-panel-stage">
          <SwViewer
            className="sw-panel-viewer"
            {...s.viewerProps}
            background={background}
            viewerOptions={viewerOptions}
            viewCube={viewCube}
            viewCubeLabels={L.viewCube}
            viewCubeColors={viewCubeColors}
            onError={onError}
          />
          {s.sheetViewProps ? <SwSheetView {...s.sheetViewProps} labels={L.sheets} /> : null}
          {status ? (
            <div className={cx("sw-status", parseError && "sw-status-error")} role="status">
              {status}
            </div>
          ) : null}
          {loadingOverlay && !s.ready && !parseError ? <div className="sw-panel-loading">{loadingOverlay}</div> : null}
          {children}
        </div>
        {sideShown && result ? (
          <aside
            id={sideId}
            className="sw-panel-side"
            data-drawer={mode === "drawer" ? "" : undefined}
            hidden={!open}
            onKeyDown={
              mode === "drawer"
                ? (e: KeyboardEvent) => {
                    if (e.key === "Escape") setOpen(false);
                  }
                : undefined
            }
          >
            {s.sheetsProps ? <SwSheets {...s.sheetsProps} labels={L.sheets} /> : null}
            {s.treeProps ? <SwComponentTree {...s.treeProps} labels={L.tree} showPaths={showComponentPaths} /> : null}
            {s.measureProps ? <SwMeasurePanel {...s.measureProps} formatValue={formatValue} labels={L.measure} /> : null}
            <SwInfoPanel result={result} fileName={name} defaultDensity={defaultDensity} onDensityChange={onDensityChange} locale={locale} labels={L.info} />
          </aside>
        ) : null}
      </div>
    </div>
  );
}
