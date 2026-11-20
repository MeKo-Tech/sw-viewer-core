// React wrapper around createSwViewer: parses a source in a worker (or takes an
// already parsed result), shows its meshes, and falls back to the embedded
// thumbnail when the file has no display mesh.

import { type CSSProperties, type HTMLAttributes, type ReactNode, useEffect, useRef, useState } from "react";
import type { ColorRepresentation } from "three";
import { createSwViewer, type SwViewer as SwViewerInstance, type SwViewerOptions } from "../three/viewer.ts";
import type { SwParseResult } from "../types.ts";
import { type SwSource, useSwParse } from "./useSwParse.ts";

/** Viewer setup, read once on mount. */
export type SwViewerSetup = Pick<SwViewerOptions, "pixelRatio" | "maxPixelRatio" | "lighting">;

type DivAttributes = Omit<HTMLAttributes<HTMLDivElement>, "onError" | "children" | "className" | "style">;

export interface SwViewerProps extends DivAttributes {
  /** File or bytes to parse. Requires `createWorker`. */
  source?: SwSource | null;
  /** Worker factory. With Vite: `import SwParseWorker from "@meko-tech/sw-viewer-core/worker?worker"`, then `() => new SwParseWorker()`. */
  createWorker?: () => Worker;
  /** Already parsed result; takes precedence over `source`. */
  result?: SwParseResult | null;
  timeoutMs?: number;
  /** Clear color, default white. */
  background?: ColorRepresentation;
  onResult?: (result: SwParseResult) => void;
  /** Parse errors, and WebGL errors when the viewer cannot be created. */
  onError?: (error: Error) => void;
  /** Called after the first frame with a new model was drawn, e.g. to hide an overlay. */
  onFirstFrame?: () => void;
  /** The viewer instance after mount (null on unmount), e.g. for `resetView()`. */
  onReady?: (viewer: SwViewerInstance | null) => void;
  /** Pixel ratio and lighting; changes after mount are ignored. */
  viewerOptions?: SwViewerSetup;
  /** Show the embedded thumbnail when there is no mesh (default true). */
  preview?: boolean;
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
  onFirstFrame,
  onReady,
  viewerOptions,
  preview = true,
  className,
  style,
  children,
  ...divProps
}: SwViewerProps) {
  if (source && !createWorker) {
    throw new Error("SwViewer: createWorker is required when source is set");
  }

  const parse = useSwParse(result ? null : source, createWorker ?? missingWorker, { timeoutMs });
  const effective = result ?? (parse.status === "done" ? parse.result : null);

  // Callbacks through refs, so inline functions neither retrigger effects nor fire twice.
  const onResultRef = useRef(onResult);
  const onErrorRef = useRef(onError);
  const onFirstFrameRef = useRef(onFirstFrame);
  const onReadyRef = useRef(onReady);
  useEffect(() => {
    onResultRef.current = onResult;
    onErrorRef.current = onError;
    onFirstFrameRef.current = onFirstFrame;
    onReadyRef.current = onReady;
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
  const setupRef = useRef(viewerOptions);
  useEffect(() => {
    const host = canvasHostRef.current;
    if (!host) return;
    let viewer: SwViewerInstance;
    try {
      viewer = createSwViewer(host, {
        ...setupRef.current,
        background: backgroundRef.current,
        onFirstFrame: () => onFirstFrameRef.current?.(),
      });
    } catch (err) {
      // No WebGL, or the browser's context limit: report it instead of crashing the tree.
      onErrorRef.current?.(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    viewerRef.current = viewer;
    onReadyRef.current?.(viewer);
    return () => {
      viewerRef.current = null;
      onReadyRef.current?.(null);
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
  const previewBytes = preview && effective && !effective.meshes.length ? effective.preview : undefined;
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
    <div {...divProps} className={className} style={{ ...style, position: "relative" }}>
      <div ref={canvasHostRef} style={fillStyle} />
      {previewUrl && previewBytes ? <img src={previewUrl} alt="" style={previewStyle} /> : null}
      {children}
    </div>
  );
}
