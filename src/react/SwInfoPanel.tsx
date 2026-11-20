// Model facts: size, volume, area, mass from an editable density, face types, file
// version and the document properties.

import { useId, useState } from "react";
import { formatNumber } from "../three/measureModel.ts";
import type { SwFaceInfo, SwParseResult } from "../types.ts";
import { cx, faceTypeCounts, massGrams, modelSize, parseDecimal, propertyRows } from "./helpers.ts";
import { type DeepPartial, defaultInfoPanelLabels, mergeLabels, type SwInfoPanelLabels } from "./labels.ts";

const FACE_TYPES: SwFaceInfo["type"][] = ["plane", "cylinder", "cone", "sphere", "other"];

export interface SwInfoPanelProps {
  result: SwParseResult;
  fileName?: string;
  /** Density in g/cm³ (controlled). */
  density?: number;
  /** Initial density when uncontrolled (default 7.85, steel). Hide the mass with `showMass={false}`. */
  defaultDensity?: number;
  onDensityChange?: (density: number) => void;
  showMass?: boolean;
  /** Show the properties table (default true). */
  showProperties?: boolean;
  /** Number locale, e.g. `de-DE` (default `en-US`). */
  locale?: string;
  labels?: DeepPartial<SwInfoPanelLabels>;
  /** Show the title (default true). */
  header?: boolean;
  className?: string;
}

export function SwInfoPanel({
  result,
  fileName,
  density,
  defaultDensity = 7.85,
  onDensityChange,
  showMass = true,
  showProperties = true,
  locale,
  labels: partial,
  header = true,
  className,
}: SwInfoPanelProps) {
  const L = mergeLabels(defaultInfoPanelLabels, partial);
  const id = useId();
  const [own, setOwn] = useState(defaultDensity);
  const [text, setText] = useState<string | null>(null);
  const rho = density ?? own;
  const nf = (x: number, d: number) => formatNumber(x, d, locale);
  const stats = result.stats;
  const counts = faceTypeCounts(result.meshes);
  const totalFaces = FACE_TYPES.reduce((s, t) => s + (counts[t] ?? 0), 0);
  const props = showProperties ? propertyRows(result.properties) : [];

  const rows: [string, string][] = [];
  if (fileName) rows.push([L.file, fileName]);
  rows.push([L.kind, L.kinds[result.kind]]);
  if (stats) {
    const s = modelSize(stats);
    rows.push([L.size, `${s.map((x) => nf(x, 2)).join(" × ")} mm`]);
    if (result.meshes.length) {
      rows.push([L.volume, `${nf(stats.volume / 1000, 2)} cm³`]);
      rows.push([L.area, `${nf(stats.area / 100, 2)} cm²`]);
    }
  }
  if (totalFaces) {
    const parts = FACE_TYPES.filter((t) => counts[t]).map((t) => `${counts[t]} ${L.faceTypes[t]}`);
    rows.push([L.faces, `${totalFaces} (${parts.join(", ")})`]);
  }
  if (result.version !== undefined) rows.push([L.version, String(result.version)]);

  return (
    <section className={cx("sw-info", className)} aria-label={L.title}>
      {header ? (
        <header className="sw-section-header">
          <h3 className="sw-title">{L.title}</h3>
        </header>
      ) : null}
      <dl className="sw-kv">
        {rows.map(([k, v]) => (
          <div key={k} className="sw-kv-row">
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
        {showMass && stats && result.meshes.length ? (
          <>
            <div className="sw-kv-row">
              <dt>
                <label htmlFor={`${id}-density`}>{L.density}</label>
              </dt>
              <dd>
                <input
                  id={`${id}-density`}
                  className="sw-input sw-input-number"
                  inputMode="decimal"
                  value={text ?? String(rho)}
                  onChange={(e) => {
                    setText(e.target.value);
                    const v = parseDecimal(e.target.value);
                    if (Number.isFinite(v) && v >= 0) {
                      setOwn(v);
                      onDensityChange?.(v);
                    }
                  }}
                  onBlur={() => setText(null)}
                />{" "}
                {L.densityUnit}
              </dd>
            </div>
            <div className="sw-kv-row">
              <dt>{L.mass}</dt>
              <dd>{nf(massGrams(stats.volume, rho), 1)} g</dd>
            </div>
          </>
        ) : null}
      </dl>
      {props.length ? (
        <details className="sw-props">
          <summary>
            {L.properties} ({props.length})
          </summary>
          <table className="sw-table">
            <tbody>
              {props.map(([k, v]) => (
                <tr key={k}>
                  <th scope="row">{k}</th>
                  <td>{v}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      ) : null}
      {stats && result.meshes.length ? <p className="sw-hint sw-note">{L.approxNote}</p> : null}
    </section>
  );
}
