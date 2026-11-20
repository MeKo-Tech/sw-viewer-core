import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSwInWorker, SwParseTimeoutError } from "../src/client.ts";
import { transferables, type SwParseReply } from "../src/protocol.ts";
import type { SwParseResult } from "../src/types.ts";

class FakeWorker {
  onmessage: ((ev: MessageEvent<SwParseReply>) => void) | null = null;
  onerror: ((ev: ErrorEvent) => void) | null = null;
  terminated = false;
  private readonly replies: SwParseReply[];
  constructor(replies: SwParseReply[]) {
    this.replies = replies;
  }
  postMessage() {
    for (const data of this.replies) {
      queueMicrotask(() => this.onmessage?.({ data } as MessageEvent<SwParseReply>));
    }
  }
  terminate() {
    this.terminated = true;
  }
}

const result = { kind: "part" as const, meshes: [], warnings: [] };

test("resolves with the result and terminates the worker", async () => {
  const w = new FakeWorker([{ type: "parsing" }, { type: "done", result }]);
  let parsing = false;
  const r = await parseSwInWorker(() => w as unknown as Worker, new ArrayBuffer(8), {
    onParsing: () => {
      parsing = true;
    },
  });
  assert.deepEqual(r, result);
  assert.ok(parsing);
  assert.ok(w.terminated);
});

test("rejects with the worker's error", async () => {
  const w = new FakeWorker([{ type: "error", error: "bad file" }]);
  await assert.rejects(parseSwInWorker(() => w as unknown as Worker, new ArrayBuffer(8)), /bad file/);
  assert.ok(w.terminated);
});

test("times out and terminates", async () => {
  const w = new FakeWorker([{ type: "parsing" }]);
  await assert.rejects(
    parseSwInWorker(() => w as unknown as Worker, new ArrayBuffer(8), { timeoutMs: 10 }),
    SwParseTimeoutError,
  );
  assert.ok(w.terminated);
});

test("aborts and terminates", async () => {
  const w = new FakeWorker([{ type: "parsing" }]);
  const ac = new AbortController();
  const p = parseSwInWorker(() => w as unknown as Worker, new ArrayBuffer(8), { signal: ac.signal });
  ac.abort(new Error("closed"));
  await assert.rejects(p, /closed/);
  assert.ok(w.terminated);
});

test("transfers shared geometry for repeated assembly instances", () => {
  const geometry = {
    positions: Float32Array.of(1, 2, 3),
    normals: Float32Array.of(0, 0, 1),
    indices: Uint32Array.of(0),
  };
  const result: SwParseResult = {
    kind: "assembly",
    meshes: [{ ...geometry, name: "Part-1" }, { ...geometry, name: "Part-2" }],
    warnings: [],
  };

  const received = structuredClone(result, { transfer: transferables(result) });
  assert.equal(received.meshes[0].positions.buffer, received.meshes[1].positions.buffer);
  assert.deepEqual(received.meshes[1].positions, Float32Array.of(1, 2, 3));
});
