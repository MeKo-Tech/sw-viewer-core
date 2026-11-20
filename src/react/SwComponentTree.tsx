// Component tree of an assembly or drawing with a visibility checkbox per node.
// Unchecking a node hides its whole sub-tree; suppressed components are shown disabled.

import { useMemo } from "react";
import { componentParents, isComponentHidden, partColors, rgbCss, setComponentHidden } from "../three/components.ts";
import type { SwComponentNode, SwMesh } from "../types.ts";
import { countComponents, cx } from "./helpers.ts";
import { type DeepPartial, defaultComponentTreeLabels, mergeLabels, type SwComponentTreeLabels } from "./labels.ts";

export interface SwComponentTreeProps {
  components: readonly SwComponentNode[];
  /** Hidden component ids (see `initialHiddenComponents`). */
  hidden: readonly string[];
  onHiddenChange: (hidden: string[]) => void;
  /** Meshes, so the swatches also cover parts referenced only by meshes. */
  meshes?: readonly Pick<SwMesh, "componentId">[];
  /** Colour swatch per part (default true): the colours of the viewer's `part` colour mode. */
  swatches?: boolean;
  labels?: DeepPartial<SwComponentTreeLabels>;
  /** Show the title and summary (default true). */
  header?: boolean;
  className?: string;
}

export function SwComponentTree({
  components,
  hidden,
  onHiddenChange,
  meshes,
  swatches = true,
  labels: partial,
  header = true,
  className,
}: SwComponentTreeProps) {
  const L = mergeLabels(defaultComponentTreeLabels, partial);
  const colors = useMemo(() => (swatches ? partColors(components, meshes) : null), [components, meshes, swatches]);
  const parents = useMemo(() => componentParents(components), [components]);
  const hiddenSet = useMemo(() => new Set(hidden), [hidden]);
  const { parts, assemblies } = useMemo(() => countComponents(components), [components]);

  const renderNodes = (nodes: readonly SwComponentNode[], depth: number) => (
    <ul className="sw-tree-list" role={depth ? "group" : undefined}>
      {nodes.map((n) => {
        const visible = !isComponentHidden(n.id, hiddenSet, parents);
        const color = colors?.get(n.id);
        return (
          <li key={n.id} className={cx("sw-tree-node", n.kind === "assembly" && "sw-tree-assembly", n.suppressed && "sw-tree-suppressed")}>
            <label className="sw-tree-row" title={n.path}>
              <input
                type="checkbox"
                checked={visible && !n.suppressed}
                disabled={n.suppressed}
                aria-label={L.toggle(n.name)}
                onChange={(e) => onHiddenChange(setComponentHidden(components, hidden, n.id, e.target.checked))}
              />
              {n.kind === "part" && color ? <span className="sw-swatch" style={{ background: rgbCss(color) }} aria-hidden="true" /> : null}
              <span className="sw-tree-name">{n.name}</span>
              {n.suppressed ? <span className="sw-tree-note">({L.suppressed})</span> : null}
            </label>
            {n.children.length ? renderNodes(n.children, depth + 1) : null}
          </li>
        );
      })}
    </ul>
  );

  return (
    <section className={cx("sw-tree", className)} aria-label={L.title}>
      {header ? (
        <header className="sw-section-header">
          <h3 className="sw-title">{L.title}</h3>
          <span className="sw-hint">{L.count(parts, assemblies)}</span>
          {hidden.length ? (
            <button type="button" className="sw-btn sw-btn-small" onClick={() => onHiddenChange([])}>
              {L.showAll}
            </button>
          ) : null}
        </header>
      ) : null}
      {renderNodes(components, 0)}
    </section>
  );
}
