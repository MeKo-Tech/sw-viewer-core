// Gallery of the sheet images of a drawing, with the 3D model as the first entry.

import { useEffect, useState } from "react";
import type { SwSheet } from "../types.ts";
import { cx } from "./helpers.ts";
import { type DeepPartial, defaultSheetsLabels, mergeLabels, type SwSheetsLabels } from "./labels.ts";

/** Object URLs for the sheet PNGs, revoked when the sheets change or on unmount. */
export const useSheetUrls = (sheets: readonly SwSheet[] | undefined): string[] => {
  const [urls, setUrls] = useState<string[]>([]);
  useEffect(() => {
    if (!sheets?.length) {
      setUrls([]);
      return;
    }
    const list = sheets.map((s) => URL.createObjectURL(new Blob([s.image as Uint8Array<ArrayBuffer>], { type: "image/png" })));
    setUrls(list);
    return () => {
      for (const u of list) URL.revokeObjectURL(u);
    };
  }, [sheets]);
  return urls;
};

export interface SwSheetsProps {
  sheets: readonly SwSheet[];
  /** Selected sheet index, or null for the 3D model. */
  selected: number | null;
  onSelect: (index: number | null) => void;
  /** Offer the 3D model entry (default true). */
  hasModel?: boolean;
  /** Precomputed object URLs (from `useSheetUrls`), to share them with a large view. */
  urls?: readonly string[];
  labels?: DeepPartial<SwSheetsLabels>;
  /** Show the title (default true). */
  header?: boolean;
  className?: string;
}

export function SwSheets({ sheets, selected, onSelect, hasModel = true, urls: given, labels: partial, header = true, className }: SwSheetsProps) {
  const L = mergeLabels(defaultSheetsLabels, partial);
  const own = useSheetUrls(given ? undefined : sheets);
  const urls = given ?? own;
  return (
    <section className={cx("sw-sheets", className)} aria-label={L.title}>
      {header ? (
        <header className="sw-section-header">
          <h3 className="sw-title">{L.title}</h3>
        </header>
      ) : null}
      <div className="sw-sheet-list" role="group" aria-label={L.title}>
        {hasModel ? (
          <button type="button" className="sw-sheet-thumb sw-sheet-model" aria-pressed={selected === null} onClick={() => onSelect(null)}>
            <svg className="sw-sheet-cube" viewBox="0 0 40 30" aria-hidden="true">
              <path d="M20 4 31 9.5v11L20 26 9 20.5v-11Z M9 9.5 20 15l11-5.5 M20 15v11" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
            </svg>
            <span className="sw-sheet-name">{L.model}</span>
          </button>
        ) : null}
        {sheets.map((s, i) => (
          <button key={i} type="button" className="sw-sheet-thumb" aria-pressed={selected === i} onClick={() => onSelect(i)}>
            {urls[i] ? <img src={urls[i]} alt="" /> : null}
            <span className="sw-sheet-name">{L.sheet(s.name, i)}</span>
          </button>
        ))}
      </div>
    </section>
  );
}
