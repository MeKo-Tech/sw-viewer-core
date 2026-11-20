// Host side of the parse worker: send the file, wait for the result, and kill the
// worker after a timeout. Parsing runs untrusted input, so the worker never
// outlives one file.

import type { SwParseReply, SwParseRequest } from "./protocol.ts";
import type { SwParseResult } from "./types.ts";

export const DEFAULT_PARSE_TIMEOUT_MS = 30_000;

export interface ParseInWorkerOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Called once the worker has received the file and started parsing. */
  onParsing?: () => void;
}

export class SwParseTimeoutError extends Error {
  constructor(ms: number) {
    super(`SolidWorks parse timed out after ${ms} ms`);
    this.name = "SwParseTimeoutError";
  }
}

/**
 * Parses `buffer` in a fresh worker from `createWorker` and terminates it
 * afterwards. The buffer is transferred, so it is detached after the call.
 *
 * Pass the worker factory from the app so the bundler sees the worker URL:
 * `() => new Worker(new URL("…/worker.js", import.meta.url), { type: "module" })`.
 */
export const parseSwInWorker = (
  createWorker: () => Worker,
  buffer: ArrayBuffer,
  { timeoutMs = DEFAULT_PARSE_TIMEOUT_MS, signal, onParsing }: ParseInWorkerOptions = {},
): Promise<SwParseResult> =>
  new Promise<SwParseResult>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      return;
    }
    const worker = createWorker();
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      worker.terminate();
    };
    const onAbort = () => {
      finish();
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      finish();
      reject(new SwParseTimeoutError(timeoutMs));
    }, timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });

    worker.onmessage = (ev: MessageEvent<SwParseReply>) => {
      const msg = ev.data;
      if (msg.type === "parsing") {
        onParsing?.();
        return;
      }
      finish();
      if (msg.type === "done") {
        resolve(msg.result);
      } else {
        reject(new Error(msg.error));
      }
    };
    worker.onerror = (ev: ErrorEvent) => {
      finish();
      reject(new Error(ev.message || "SolidWorks parse worker failed"));
    };
    const request: SwParseRequest = { buffer };
    worker.postMessage(request, [buffer]);
  });
