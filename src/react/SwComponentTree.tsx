// Component tree of an assembly or drawing with a visibility checkbox per node.
// Unchecking a node hides its whole sub-tree; suppressed components are shown disabled.
// Sub-assemblies can be collapsed; large trees start collapsed, so only what is open
// is rendered.

import { useMemo, useState } from "react";
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
  /**
   * Sub-assemblies start collapsed when the tree has more nodes than this (default
   * 200); smaller trees start fully expanded. Either way each one can be toggled.
   */
  collapseAbove?: number;
  className?: string;
}

/** Node count above which sub-assemblies start collapsed. */
export const DEFAULT_COLLAPSE_ABOVE = 200;

export function SwComponentTree({
  components,
  hidden,
  onHiddenChange,
  meshes,
  swatches = true,
  labels: partial,
  header = true,
  collapseAbove = DEFAULT_COLLAPSE_ABOVE,
  className,
}: SwComponentTreeProps) {
  const L = mergeLabels(defaultComponentTreeLabels, partial);
  const colors = useMemo(() => (swatches ? partColors(components, meshes) : null), [components, meshes, swatches]);
  const parents = useMemo(() => componentParents(components), [components]);
  const hiddenSet = useMemo(() => new Set(hidden), [hidden]);
  const { parts, assemblies } = useMemo(() => countComponents(components), [components]);
  const openByDefault = parts + assemblies <= collapseAbove;
  // Ids whose open state differs from the default, for the current tree only.
  const [toggledState, setToggledState] = useState<{ components: readonly SwComponentNode[]; ids: ReadonlySet<string> }>({
    components,
    ids: new Set(),
  });
  const toggled = toggledState.components === components ? toggledState.ids : null;
  const isOpen = (id: string) => openByDefault !== !!toggled?.has(id);
  const toggleOpen = (id: string) => {
    const ids = new Set(toggled ?? []);
    if (!ids.delete(id)) ids.add(id);
    setToggledState({ components, ids });
  };
  const expandLabel = L.expand ?? defaultComponentTreeLabels.expand!;
  const collapseLabel = L.collapse ?? defaultComponentTreeLabels.collapse!;

  const renderNodes = (nodes: readonly SwComponentNode[], depth: number) => (
    <ul className="sw-tree-list" role={depth ? "group" : undefined}>
      {nodes.map((n) => {
        const visible = !isComponentHidden(n.id, hiddenSet, parents);
        const color = colors?.get(n.id);
        const open = n.children.length ? isOpen(n.id) : false;
        return (
          <li key={n.id} className={cx("sw-tree-node", n.kind === "assembly" && "sw-tree-assembly", n.suppressed && "sw-tree-suppressed")}>
            {n.children.length ? (
              <button
                type="button"
                className="sw-tree-toggle"
                aria-expanded={open}
                aria-label={open ? collapseLabel(n.name) : expandLabel(n.name)}
                onClick={() => toggleOpen(n.id)}
              />
            ) : null}
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
            {open ? renderNodes(n.children, depth + 1) : null}
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
