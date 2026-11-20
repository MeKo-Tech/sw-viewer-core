// React demo: pick a SolidWorks file and show it in <SwViewerPanel> (toolbar, section,
// measuring, component tree, sheets, info). "Deutsch" shows how an app passes its own
// labels; "Side bar" switches between a column and a drawer (tablets); "Touch" sets
// --sw-control-size for 44 px targets; "Dark" themes everything through --sw-* variables
// set on the app's root element.

import { type CSSProperties, StrictMode, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  type DeepPartial,
  type SwParseResult,
  type SwSidebarMode,
  type SwViewerInstance,
  SwViewerPanel,
  type SwViewerPanelLabels,
} from "../src/react/index.ts";
import "../src/react/sw-viewer.css";

const createWorker = () => new Worker(new URL("../src/worker.ts", import.meta.url), { type: "module" });

// Partial German labels: everything not listed keeps the English default.
const de: DeepPartial<SwViewerPanelLabels> = {
  toolbar: {
    edges: "Kanten",
    measure: "Messen",
    measureModes: { auto: "Auto", point: "Punkt", edge: "Kante", face: "Fläche", angle: "Winkel" },
    section: "Schnitt",
    sectionOff: "Aus",
    sectionThroughAxis: "Durch Achse",
    sectionOnFace: "An Fläche",
    sectionFlip: "Seite",
    sectionOffset: "Position",
    sectionAngle: "Drehung",
    sectionContour: "Kontur",
    viewNames: { front: "Vorne", top: "Oben", right: "Rechts", iso: "Iso" },
    resetView: "Einpassen",
    colorByPart: "Farbe je Teil",
  },
  sidebarShow: "Details zeigen",
  sidebarHide: "Details ausblenden",
  tree: {
    title: "Komponenten",
    suppressed: "unterdrückt",
    count: (p, a) => `${p} Teile${a ? `, ${a} Unterbaugruppen` : ""}`,
    showAll: "Alle zeigen",
    toggle: (name) => `${name} anzeigen`,
    expand: (name) => `${name} aufklappen`,
    collapse: (name) => `${name} zuklappen`,
  },
  measure: {
    title: "Messung",
    pin: "Maß behalten",
    pinned: "Behaltene Maße",
    noPins: "Noch keine Maße behalten.",
    clear: "Alles löschen",
    hints: { auto: "Punkt, Kante oder Fläche anklicken – ein zweites Element ergibt Abstand oder Winkel." },
    // One text per measured value kind; kinds left out keep the English default.
    items: {
      diameter: "Durchmesser",
      "hole-diameter": "Bohrungsdurchmesser",
      radius: "Radius",
      area: "Fläche",
      "edge-length": "Kantenlänge",
      distance: "Abstand",
      "plane-distance": "Abstand (parallel)",
      angle: "Winkel",
    },
    shapes: { plane: "Ebene", cylinder: "Zylinder", hole: "Bohrung", line: "Linie", circle: "Kreis", arc: "Bogen", point: "Punkt" },
  },
  info: {
    title: "Bauteil",
    file: "Datei",
    kind: "Typ",
    kinds: { part: "Teil", assembly: "Baugruppe", drawing: "Zeichnung" },
    size: "Abmessungen",
    volume: "Volumen ≈",
    area: "Oberfläche ≈",
    density: "Dichte",
    mass: "Masse ≈",
    faces: "Flächen",
    faceTypes: { plane: "Ebenen", cylinder: "Zylinder", cone: "Kegel", sphere: "Kugeln", other: "Freiform" },
    version: "Dateiversion",
    properties: "Eigenschaften",
    approxNote: "Werte mit ≈ sind Näherungen aus dem Dreiecksnetz.",
  },
  sheets: { title: "Blätter", model: "3D-Modell", sheetFallback: (n) => `Blatt ${n}` },
  viewCube: { front: "VORNE", back: "HINTEN", top: "OBEN", bottom: "UNTEN", left: "LINKS", right: "RECHTS" },
  loading: "Wird gelesen …",
};

declare global {
  interface Window {
    __swViewer?: SwViewerInstance | null;
    __swResult?: SwParseResult;
  }
}

/** A dark theme: the --sw-* variables on the app root reach every block, the cube included. */
const dark = {
  "--sw-fg": "#e5e7eb",
  "--sw-muted": "#9ca3af",
  "--sw-bg": "#111827",
  "--sw-bg-subtle": "#1f2937",
  "--sw-border": "#374151",
  "--sw-border-hover": "#4b5563",
  "--sw-accent": "#60a5fa",
  "--sw-accent-bg": "#1e3a5f",
  "--sw-overlay-bg": "rgb(17 24 39 / 0.8)",
  "--sw-cube-face": "#e5e7eb",
  "--sw-cube-edge": "#cbd5e1",
  "--sw-cube-corner": "#94a3b8",
  background: "#111827",
  color: "#e5e7eb",
} as CSSProperties;

const touch = { "--sw-control-size": "44px", "--sw-checkbox-size": "20px", "--sw-font": "15px/1.4 system-ui, sans-serif" } as CSSProperties;

function App() {
  const [file, setFile] = useState<File | null>(null);
  const [lang, setLang] = useState<"en" | "de">("en");
  const [sidebar, setSidebar] = useState<SwSidebarMode>(() => (window.matchMedia("(max-width: 1100px)").matches ? "drawer" : "side"));
  const [isTouch, setTouch] = useState(false);
  const [isDark, setDark] = useState(false);
  const [warnings, setWarnings] = useState<string[]>([]);
  const labels = useMemo(() => (lang === "de" ? de : undefined), [lang]);

  return (
    <div className="app" style={{ ...(isDark ? dark : null), ...(isTouch ? touch : null) }}>
      <header>
        <h1>SolidWorks Viewer (React)</h1>
        <input
          type="file"
          accept=".sldprt,.sldasm,.slddrw"
          onChange={(ev) => {
            setFile(ev.target.files?.[0] ?? null);
            setWarnings([]);
          }}
        />
        <label>
          <input type="checkbox" checked={lang === "de"} onChange={(e) => setLang(e.target.checked ? "de" : "en")} /> Deutsch
        </label>
        <label>
          Side bar{" "}
          <select value={sidebar} onChange={(e) => setSidebar(e.target.value as SwSidebarMode)}>
            <option value="side">column</option>
            <option value="drawer">drawer</option>
          </select>
        </label>
        <label>
          <input type="checkbox" checked={isTouch} onChange={(e) => setTouch(e.target.checked)} /> Touch
        </label>
        <label>
          <input type="checkbox" checked={isDark} onChange={(e) => setDark(e.target.checked)} /> Dark
        </label>
        {warnings.length > 0 && <span className="warn">Warnings: {warnings.join("; ")}</span>}
      </header>
      <SwViewerPanel
        // Remount on theme changes, so the cube picks up the new --sw-cube-* colours.
        key={isDark ? "dark" : "light"}
        className="viewer"
        source={file}
        createWorker={createWorker}
        labels={labels}
        locale={lang === "de" ? "de-DE" : "en-US"}
        sidebar={sidebar}
        sidebarToggle
        background={isDark ? 0x1f2937 : undefined}
        loadingOverlay={file ? <span className="spinner" role="progressbar" aria-label="Loading" /> : null}
        onResult={(r) => {
          window.__swResult = r;
          setWarnings(r.warnings);
        }}
        onReady={(v) => {
          window.__swViewer = v;
        }}
      />
    </div>
  );
}

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
