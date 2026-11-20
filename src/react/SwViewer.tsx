// React wrapper around createSwViewer: parses a source in a worker (or takes an
// already parsed result), shows its meshes, and falls back to the embedded
// thumbnail when the file has no display mesh.

import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from "react";
import type { ColorRepresentation } from "three";
import { createSwViewer, type SwViewer as SwViewerInstance } from "../three/viewer.ts";
import type { SwParseResult } from "../types.ts";
import { type SwSource, useSwParse } from "./useSwParse.ts";

export interface SwViewerProps {
  /** File or bytes to parse. Requires `createWorker`. */
  source?: SwSource | null;
  /** Worker factory, e.g. `() => new Worker(new URL("…/worker.js", import.meta.url), { type: "module" })`. */
  createWorker?: () => Worker;
  /** Already parsed result; takes precedence over `source`. */
  result?: SwParseResult | null;
  timeoutMs?: number;
  /** Clear color, default white. */
  background?: ColorRepresentation;
  onResult?: (result: SwParseResult) => void;
  onError?: (error: Error) => void;
  className?: string;
  style?: CSSProperties;
  /** Overlay rendered inside the container, e.g. a spinner. */
  children?: ReactNode;
}

const missingWorker = (): Worker => {
  throw new Error("SwViewer: createWorker is required when source is set");
};

const fillStyle: CSSProperties = { position: "absolute", inset: 0 };

const previewStyle: CSSProperties = {
  position: "absolute",
  inset: 0,
  margin: "auto",
  maxWidth: "100%",
  maxHeight: "100%",
  objectFit: "contain",
  pointerEvents: "none",
};

export function SwViewer({
  source = null,
  createWorker,
  result = null,
  timeoutMs,
  background = 0xffffff,
  onResult,
  onError,
  className,
  style,
  children,
}: SwViewerProps) {
  if (source && !createWorker) {
    throw new Error("SwViewer: createWorker is required when source is set");
  }

  const parse = useSwParse(result ? null : source, createWorker ?? missingWorker, { timeoutMs });
  const effective = result ?? (parse.status === "done" ? parse.result : null);

  // Callbacks through refs, so inline functions neither retrigger effects nor fire twice.
  const onResultRef = useRef(onResult);
  const onErrorRef = useRef(onError);
  useEffect(() => {
    onResultRef.current = onResult;
    onErrorRef.current = onError;
  });
  const notifiedRef = useRef<unknown>(null);
  useEffect(() => {
    if (notifiedRef.current === parse) return;
    notifiedRef.current = parse;
    if (parse.status === "done") onResultRef.current?.(parse.result);
    else if (parse.status === "error") onErrorRef.current?.(parse.error);
  }, [parse]);

  // Viewer lifecycle. Effects run in declaration order, so the model effect below
  // always sees the viewer of the current mount (also under StrictMode remounts).
  const canvasHostRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<SwViewerInstance | null>(null);
  const backgroundRef = useRef(background);
  backgroundRef.current = background;
  useEffect(() => {
    const host = canvasHostRef.current;
    if (!host) return;
    const viewer = createSwViewer(host, { background: backgroundRef.current });
    viewerRef.current = viewer;
    return () => {
      viewerRef.current = null;
      viewer.dispose();
    };
  }, []);

  useEffect(() => {
    viewerRef.current?.setModel(effective);
  }, [effective]);

  useEffect(() => {
    viewerRef.current?.setBackground(background);
  }, [background]);

  // Thumbnail fallback for results without display meshes.
  const previewBytes = effective && !effective.meshes.length ? effective.preview : undefined;
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!previewBytes?.length) {
      setPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(new Blob([previewBytes as Uint8Array<ArrayBuffer>], { type: "image/png" }));
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [previewBytes]);

  return (
    <div className={className} style={{ ...style, position: "relative" }}>
      <div ref={canvasHostRef} style={fillStyle} />
      {previewUrl && previewBytes ? <img src={previewUrl} alt="" style={previewStyle} /> : null}
      {children}
    </div>
  );
}
