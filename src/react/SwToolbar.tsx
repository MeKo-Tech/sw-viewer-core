// Toolbar for the viewer: edges, colour mode, measure modes, section menu and views.
// Every control is optional: a group renders only when its change handler is given.

import type { ReactNode } from "react";
import { MEASURE_MODES, type SwMeasureMode } from "../three/measureModel.ts";
import { type SwAxis, type SwBox, type SwSectionSpec, sectionRange } from "../three/section.ts";
import type { SwStandardView } from "../three/viewCube.ts";
import type { SwColorMode } from "../three/viewer.ts";
import { cx, sliderStep } from "./helpers.ts";
import { type DeepPartial, defaultToolbarLabels, mergeLabels, type SwToolbarLabels } from "./labels.ts";

const AXES: SwAxis[] = ["x", "y", "z"];
const VIEWS: SwStandardView[] = ["front", "top", "right", "iso"];

export interface SwToolbarProps {
  labels?: DeepPartial<SwToolbarLabels>;
  edges?: boolean;
  onEdgesChange?: (edges: boolean) => void;
  colorMode?: SwColorMode;
  /** Shows the "colour by part" toggle (assemblies). */
  onColorModeChange?: (mode: SwColorMode) => void;
  measureMode?: SwMeasureMode | null;
  /** Shows the measure group. Off is null. */
  onMeasureModeChange?: (mode: SwMeasureMode | null) => void;
  section?: SwSectionSpec | null;
  /** Shows the section menu. */
  onSectionChange?: (section: SwSectionSpec | null) => void;
  /** Model box, for the section slider (e.g. from `result.stats` or `viewer.getBox()`). */
  box?: SwBox | null;
  /** Shows "Through axis" / "On face"; the caller starts `viewer.pickSectionTarget(kind)`. */
  onPickSection?: (kind: "face" | "cylinder") => void;
  /** Set while a section pick is pending, to show its hint. */
  sectionPicking?: "face" | "cylinder" | null;
  onCancelPick?: () => void;
  /** Shows the view buttons. */
  onView?: (view: SwStandardView) => void;
  onResetView?: () => void;
  /** Standard views offered as buttons (default front, top, right, iso). */
  views?: readonly SwStandardView[];
  /** Number formatting locale of the slider value. */
  locale?: string;
  className?: string;
  /** Extra controls at the end. */
  children?: ReactNode;
}

const Toggle = (props: { pressed: boolean; onClick: () => void; title?: string; children: ReactNode }) => (
  <button type="button" className="sw-btn" aria-pressed={props.pressed} title={props.title} onClick={props.onClick}>
    {props.children}
  </button>
);

export function SwToolbar({
  labels: partial,
  edges,
  onEdgesChange,
  colorMode,
  onColorModeChange,
  measureMode = null,
  onMeasureModeChange,
  section = null,
  onSectionChange,
  box,
  onPickSection,
  sectionPicking = null,
  onCancelPick,
  onView,
  onResetView,
  views = VIEWS,
  locale,
  className,
  children,
}: SwToolbarProps) {
  const L = mergeLabels(defaultToolbarLabels, partial);
  const range = section && box ? sectionRange(section, box) : null;
  const offset =
    section?.offset ?? (section?.kind === "axis" && box ? (box.min[AXES.indexOf(section.axis)] + box.max[AXES.indexOf(section.axis)]) / 2 : 0);
  const setSection = (patch: Partial<SwSectionSpec>) => section && onSectionChange?.({ ...section, ...patch } as SwSectionSpec);
  const axisCenter = (a: SwAxis) => (box ? (box.min[AXES.indexOf(a)] + box.max[AXES.indexOf(a)]) / 2 : 0);

  return (
    <div role="toolbar" aria-label={L.toolbar} className={cx("sw-toolbar", className)}>
      {onResetView || onView ? (
        <div className="sw-group" role="group" aria-label={L.views}>
          {onResetView ? (
            <button type="button" className="sw-btn" onClick={onResetView}>
              {L.resetView}
            </button>
          ) : null}
          {onView
            ? views.map((v) => (
                <button key={v} type="button" className="sw-btn" onClick={() => onView(v)}>
                  {L.viewNames[v]}
                </button>
              ))
            : null}
        </div>
      ) : null}

      {onEdgesChange || onColorModeChange ? (
        <div className="sw-group">
          {onEdgesChange ? (
            <Toggle pressed={!!edges} onClick={() => onEdgesChange(!edges)}>
              {L.edges}
            </Toggle>
          ) : null}
          {onColorModeChange ? (
            <Toggle pressed={colorMode === "part"} onClick={() => onColorModeChange(colorMode === "part" ? "file" : "part")}>
              {L.colorByPart}
            </Toggle>
          ) : null}
        </div>
      ) : null}

      {onMeasureModeChange ? (
        <div className="sw-group" role="group" aria-label={L.measure}>
          <span className="sw-group-label" aria-hidden="true">
            {L.measure}
          </span>
          {MEASURE_MODES.map((m) => (
            <Toggle key={m} pressed={measureMode === m} title={L.measureModeHints[m]} onClick={() => onMeasureModeChange(measureMode === m ? null : m)}>
              {L.measureModes[m]}
            </Toggle>
          ))}
        </div>
      ) : null}

      {onSectionChange ? (
        <details className="sw-menu">
          <summary className="sw-btn" data-active={section ? "" : undefined}>
            {L.section}
          </summary>
          <div className="sw-menu-body">
            <div className="sw-group" role="group" aria-label={L.section}>
              <Toggle pressed={!section} onClick={() => onSectionChange(null)}>
                {L.sectionOff}
              </Toggle>
              {AXES.map((a) => (
                <Toggle
                  key={a}
                  pressed={section?.kind === "axis" && section.axis === a}
                  onClick={() => onSectionChange({ kind: "axis", axis: a, offset: axisCenter(a), flip: section?.flip, contour: section?.contour })}
                >
                  {L.sectionAxis[a]}
                </Toggle>
              ))}
              {onPickSection ? (
                <>
                  <Toggle pressed={sectionPicking === "cylinder" || (!sectionPicking && section?.kind === "cylinder")} onClick={() => onPickSection("cylinder")}>
                    {L.sectionThroughAxis}
                  </Toggle>
                  <Toggle pressed={sectionPicking === "face" || (!sectionPicking && section?.kind === "face")} onClick={() => onPickSection("face")}>
                    {L.sectionOnFace}
                  </Toggle>
                </>
              ) : null}
            </div>
            {sectionPicking ? (
              <p className="sw-hint" role="status">
                {L.sectionPickHint[sectionPicking]}{" "}
                {onCancelPick ? (
                  <button type="button" className="sw-btn sw-btn-small" onClick={onCancelPick}>
                    {L.cancel}
                  </button>
                ) : null}
              </p>
            ) : null}
            {section && range ? (
              <>
                <label className="sw-field">
                  <span>{L.sectionOffset}</span>
                  <input
                    type="range"
                    min={Math.min(range[0], offset)}
                    max={Math.max(range[1], offset)}
                    step={sliderStep(range[0], range[1])}
                    value={offset}
                    onChange={(e) => setSection({ offset: Number(e.target.value) })}
                  />
                  <output>{offset.toLocaleString(locale, { maximumFractionDigits: 2 })} mm</output>
                </label>
                {section.kind === "cylinder" ? (
                  <label className="sw-field">
                    <span>{L.sectionAngle}</span>
                    <input
                      type="range"
                      min={0}
                      max={180}
                      step={1}
                      value={section.angle ?? 0}
                      onChange={(e) => setSection({ angle: Number(e.target.value) })}
                    />
                    <output>{section.angle ?? 0}°</output>
                  </label>
                ) : null}
                <div className="sw-group">
                  <Toggle pressed={!!section.flip} onClick={() => setSection({ flip: !section.flip })}>
                    {L.sectionFlip}
                  </Toggle>
                  <Toggle pressed={section.contour !== false} onClick={() => setSection({ contour: section.contour === false })}>
                    {L.sectionContour}
                  </Toggle>
                </div>
              </>
            ) : null}
          </div>
        </details>
      ) : null}
      {children}
    </div>
  );
}
