// The current measurement as a table, with a button to keep it, and the list of kept
// (pinned) dimensions.

import type { SwPinnedMeasurement } from "../three/measure.ts";
import { formatMeasureValue, type SwMeasureMode, type SwMeasurement } from "../three/measureModel.ts";
import type { SwDescription, SwMeasureItem } from "../geometry/measure.ts";
import type { SwComponentNode } from "../types.ts";
import { flattenComponents } from "../three/components.ts";
import { cx } from "./helpers.ts";
import { type DeepPartial, defaultMeasurePanelLabels, mergeLabels, type SwMeasurePanelLabels } from "./labels.ts";

export interface SwMeasurePanelProps {
  measurement: SwMeasurement | null;
  pins?: readonly SwPinnedMeasurement[];
  /** Shows the "keep" button. */
  onPin?: () => void;
  onRemovePin?: (id: number) => void;
  /** Shows "clear all" (selection and pins). */
  onClear?: () => void;
  /** Mode for the hint without a selection; null: measuring is off. */
  mode?: SwMeasureMode | null;
  /** Component tree, to show component names. */
  components?: readonly SwComponentNode[];
  /** Value with unit (default `formatMeasureValue` with `locale`). */
  formatValue?: (item: SwMeasureItem) => string;
  locale?: string;
  labels?: DeepPartial<SwMeasurePanelLabels>;
  header?: boolean;
  className?: string;
}

export function SwMeasurePanel({
  measurement: m,
  pins = [],
  onPin,
  onRemovePin,
  onClear,
  mode = "auto",
  components,
  formatValue,
  locale,
  labels: partial,
  header = true,
  className,
}: SwMeasurePanelProps) {
  const L = mergeLabels(defaultMeasurePanelLabels, partial);
  const fmt = formatValue ?? ((item: SwMeasureItem) => formatMeasureValue(item, { locale, units: L.units }));
  // A kind or shape missing from the labels (e.g. labels typed against an older version) shows the English hint.
  const itemLabel = (it: SwMeasureItem) => L.items[it.kind] ?? it.label;
  const shapeLabel = (d: SwDescription) => L.shapes[d.shape] ?? d.label;
  const names = new Map(flattenComponents(components).map((n) => [n.id, n.name]));
  const title = (x: SwMeasurement) => {
    if (x.picks.length === 1) return shapeLabel(x.descriptions[0]);
    return x.primary ? itemLabel(x.primary) : x.descriptions.map((d) => shapeLabel(d)).join(" – ");
  };

  const rows: [string, string][] = [];
  if (m) {
    for (const it of m.items) if (it !== m.primary) rows.push([itemLabel(it), fmt(it)]);
    if (m.picks.length === 1) {
      const p = m.picks[0];
      if (p.kind === "point" && p.snap) rows.push([L.snap, L.snapKinds[p.snap]]);
    } else {
      m.picks.forEach((p, i) => rows.push([L.element(i + 1), shapeLabel(m.descriptions[i])]));
    }
    const comps = [...new Set(m.picks.map((p) => p.componentId).filter((c): c is string => !!c))];
    if (comps.length) rows.push([L.component, comps.map((c) => names.get(c) ?? c).join(", ")]);
  }

  return (
    <section className={cx("sw-measure", className)} aria-label={L.title}>
      {header ? (
        <header className="sw-section-header">
          <h3 className="sw-title">{L.title}</h3>
          {onClear && (m || pins.length) ? (
            <button type="button" className="sw-btn sw-btn-small" onClick={onClear}>
              {L.clear}
            </button>
          ) : null}
        </header>
      ) : null}
      <div aria-live="polite">
        {m ? (
          <>
            <div className="sw-primary">
              <span>{m.primary && m.picks.length === 1 ? itemLabel(m.primary) : title(m)}</span>
              {m.primary ? <b>{fmt(m.primary)}</b> : null}
            </div>
            {m.picks.length === 1 && m.primary ? <div className="sw-hint">{title(m)}</div> : null}
            {rows.length ? (
              <table className="sw-table">
                <tbody>
                  {rows.map(([k, v], i) => (
                    <tr key={i}>
                      <th scope="row">{k}</th>
                      <td>{v}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : null}
            {onPin ? (
              <button type="button" className="sw-btn sw-btn-small" onClick={onPin}>
                {L.pin}
              </button>
            ) : null}
          </>
        ) : (
          <p className="sw-hint">{L.hints[mode ?? "off"]}</p>
        )}
      </div>
      {onPin || pins.length ? (
        <div className="sw-pins">
          <h4 className="sw-subtitle">{L.pinned}</h4>
          {pins.length ? (
            <ol className="sw-pin-list">
              {pins.map((p) => (
                <li key={p.id} className="sw-pin">
                  <span className="sw-pin-no">({p.id})</span>
                  <span className="sw-pin-text">
                    {title(p.measurement)}
                    {p.measurement.primary ? <b> {fmt(p.measurement.primary)}</b> : null}
                  </span>
                  {onRemovePin ? (
                    <button type="button" className="sw-btn sw-btn-icon" aria-label={L.remove(p.id)} title={L.remove(p.id)} onClick={() => onRemovePin(p.id)}>
                      ×
                    </button>
                  ) : null}
                </li>
              ))}
            </ol>
          ) : (
            <p className="sw-hint">{L.noPins}</p>
          )}
        </div>
      ) : null}
    </section>
  );
}
