// React demo: pick a SolidWorks file and show it in <SwViewerPanel> (toolbar, section,
// measuring, component tree, sheets, info). "Deutsch" shows how an app passes its own labels.

import { StrictMode, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  type DeepPartial,
  type SwParseResult,
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
  tree: { title: "Komponenten", suppressed: "unterdrückt", count: (p, a) => `${p} Teile${a ? `, ${a} Unterbaugruppen` : ""}`, showAll: "Alle zeigen" },
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
  sheets: { title: "Blätter", model: "3D-Modell" },
  viewCube: { front: "VORNE", back: "HINTEN", top: "OBEN", bottom: "UNTEN", left: "LINKS", right: "RECHTS" },
  loading: "Wird gelesen …",
};

declare global {
  interface Window {
    __swViewer?: SwViewerInstance | null;
    __swResult?: SwParseResult;
  }
}

function App() {
  const [file, setFile] = useState<File | null>(null);
  const [lang, setLang] = useState<"en" | "de">("en");
  const [warnings, setWarnings] = useState<string[]>([]);
  const labels = useMemo(() => (lang === "de" ? de : undefined), [lang]);

  return (
    <div className="app">
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
        {warnings.length > 0 && <span className="warn">Warnings: {warnings.join("; ")}</span>}
      </header>
      <SwViewerPanel
        className="viewer"
        source={file}
        createWorker={createWorker}
        labels={labels}
        locale={lang === "de" ? "de-DE" : "en-US"}
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
