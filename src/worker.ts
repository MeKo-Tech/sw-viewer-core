// Parse worker. The host should terminate it after a timeout: parsing runs
// untrusted input.

import { parseSwFile } from "./parse.ts";
import {
  type SwParseReply,
  type SwParseRequest,
  transferables,
} from "./protocol.ts";

const post = (msg: SwParseReply, transfer: Transferable[] = []) =>
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(msg, transfer);

self.onmessage = async (ev: MessageEvent<SwParseRequest>) => {
  post({ type: "parsing" });
  try {
    const result = await parseSwFile(new Uint8Array(ev.data.buffer));
    post({ type: "done", result }, transferables(result));
  } catch (err) {
    post({
      type: "error",
      error: err instanceof Error ? err.message : String(err),
    });
  }
};
