// React demo: pick a SolidWorks file and show it with <SwViewer>.

import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { type SwParseResult, SwViewer } from "../src/react/index.ts";

const createWorker = () => new Worker(new URL("../src/worker.ts", import.meta.url), { type: "module" });

type Status = { kind: "idle" } | { kind: "parsing" } | { kind: "done"; result: SwParseResult } | { kind: "error"; message: string };

const statusText = (status: Status): string => {
  switch (status.kind) {
    case "idle":
      return "Keine Datei ausgewählt";
    case "parsing":
      return "Wird gelesen …";
    case "done": {
      const { kind, meshes, preview } = status.result;
      if (meshes.length) return `${kind}: ${meshes.length} Mesh(es)`;
      return preview ? `${kind}: kein Display-Mesh, zeige Vorschaubild` : `${kind}: keine Geometrie gefunden`;
    }
    case "error":
      return `Fehler: ${status.message}`;
  }
};

function App() {
  const [file, setFile] = useState<File | null>(null);
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  return (
    <div className="app">
      <header>
        <h1>SolidWorks Viewer (React)</h1>
        <input
          type="file"
          accept=".sldprt,.sldasm"
          onChange={(ev) => {
            const next = ev.target.files?.[0] ?? null;
            setFile(next);
            setStatus(next ? { kind: "parsing" } : { kind: "idle" });
          }}
        />
        <span className={status.kind === "error" ? "error" : "status"}>{statusText(status)}</span>
        {status.kind === "done" && status.result.warnings.length > 0 && (
          <span className="warn">Warnungen: {status.result.warnings.join("; ")}</span>
        )}
      </header>
      <SwViewer
        className="viewer"
        source={file}
        createWorker={createWorker}
        onResult={(result) => setStatus({ kind: "done", result })}
        onError={(error) => setStatus({ kind: "error", message: error.message })}
      >
        {status.kind === "parsing" && <div className="overlay">Wird gelesen …</div>}
      </SwViewer>
    </div>
  );
}

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
