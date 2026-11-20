// React hook around parseSwInWorker: parses a file/blob/buffer in a fresh worker
// and exposes the progress as a small state machine. Changing the source or
// unmounting aborts the running parse.

import { useEffect, useRef, useState } from "react";
import { parseSwInWorker } from "../client.ts";
import type { SwParseResult } from "../types.ts";

export type SwSource = File | Blob | ArrayBuffer | Uint8Array;

/**
 * Always returns a fresh ArrayBuffer the caller may transfer. ArrayBuffer and
 * Uint8Array input is copied, so the caller's data is never detached.
 */
export const toArrayBuffer = async (source: SwSource): Promise<ArrayBuffer> => {
  if (source instanceof ArrayBuffer) return source.slice(0);
  if (ArrayBuffer.isView(source)) {
    const copy = new ArrayBuffer(source.byteLength);
    new Uint8Array(copy).set(source);
    return copy;
  }
  return (source as Blob).arrayBuffer();
};

export type SwParseState =
  | { status: "idle" }
  | { status: "parsing" }
  | { status: "done"; result: SwParseResult }
  | { status: "error"; error: Error };

export interface UseSwParseOptions {
  /** Worker timeout, default from parseSwInWorker (30 s). */
  timeoutMs?: number;
}

const IDLE: SwParseState = { status: "idle" };

const toError = (err: unknown): Error => (err instanceof Error ? err : new Error(String(err)));

/**
 * Parses `source` in a worker from `createWorker`. Pass null to stay idle.
 * `createWorker` may be an inline function; only a new `source` or `timeoutMs`
 * starts a new parse.
 */
export const useSwParse = (
  source: SwSource | null,
  createWorker: () => Worker,
  options: UseSwParseOptions = {},
): SwParseState => {
  const { timeoutMs } = options;
  const [state, setState] = useState<SwParseState>(IDLE);
  const createWorkerRef = useRef(createWorker);

  // Declared before the parse effect, so the ref is current when that runs.
  useEffect(() => {
    createWorkerRef.current = createWorker;
  });

  useEffect(() => {
    if (!source) {
      setState((s) => (s.status === "idle" ? s : IDLE));
      return;
    }
    const controller = new AbortController();
    const { signal } = controller;
    setState({ status: "parsing" });
    toArrayBuffer(source)
      .then((buffer) => {
        if (signal.aborted) return null;
        return parseSwInWorker(() => createWorkerRef.current(), buffer, { timeoutMs, signal });
      })
      .then(
        (result) => {
          if (signal.aborted || !result) return;
          setState({ status: "done", result });
        },
        (err: unknown) => {
          if (signal.aborted) return;
          setState({ status: "error", error: toError(err) });
        },
      );
    return () => controller.abort();
  }, [source, timeoutMs]);

  return state;
};
