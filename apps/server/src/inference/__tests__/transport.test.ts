import { getEventListeners } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { v4 as uuid } from "uuid";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { db, eq } from "@loxaic/db";
import { localModels } from "@loxaic/db/schema";
import { invalidateLocalModelCache } from "../../llama/catalog.ts";
import { streamCompletion, type StreamEvent } from "../provider.ts";
import {
  INFERENCE_TIMEOUT_CEILING_MS,
  createInferenceDispatcher,
  inferenceDispatcher,
  inferenceFetch,
  inferenceNetworkError,
} from "../transport.ts";

/**
 * A llama.cpp-shaped backend that is slow in the ways a real one is: it sends
 * no headers until "prompt processing" is done, and can pause mid-reply. The
 * production timeouts are disabled, which no test can wait out, so the proof
 * is a pair: a deliberately short timeout *does* cut this backend off, and the
 * real inference path survives the very same delays.
 */
// Well clear of the short timeout *and* of undici's timer resolution: headers
// and body timeouts run on its "fast timers", which tick about every 500 ms, so
// a 100 ms timeout can take over a second to fire. A 600 ms delay passed the
// control untouched.
const DELAY_MS = 2_000;
const SHORT_TIMEOUT_MS = 100;

const sse = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;

let server: http.Server;
let base: string;
/** Resolves when the backend sees a request's connection close. */
let onHangClosed: (() => void) | null = null;

/**
 * The built-in provider is the local llama.cpp router; these tests reach its
 * live path by attaching it to this backend, with one servable model ("m")
 * under a host id of this suite's own so no other suite sees it.
 */
const host = `test-transport-${uuid()}`;
const previousHost = process.env.LOXAIC_INSTANCE_ID;
function attach(url: string): void {
  vi.stubEnv("LLAMA_MODE", "attach");
  vi.stubEnv("LLAMA_ROUTER_URL", url);
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    req.resume();
    // The router's model list, asked before each request (llama/room.ts):
    // "m" is loaded, so nothing needs making room for and the request itself
    // is what each case below observes.
    if (req.url?.endsWith("/models")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "m", status: { value: "loaded" } }] }));
      return;
    }
    if (req.url?.startsWith("/hang/")) {
      // Never answers: a prompt still being evaluated.
      req.on("close", () => onHangClosed?.());
      return;
    }
    if (req.url?.startsWith("/forever/")) {
      // A model that never stops — the one this Stop is for: a thinking loop
      // on a local model, generating until the hour-long ceiling.
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const tick = setInterval(() => res.write(sse({ choices: [{ delta: { content: "again " } }] })), 20);
      res.on("close", () => {
        clearInterval(tick);
        onHangClosed?.();
      });
      return;
    }
    if (req.url?.startsWith("/fast/")) {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(sse({ choices: [{ delta: { content: "hi" }, finish_reason: "stop" }] }));
      res.end("data: [DONE]\n\n");
      return;
    }
    if (req.url?.startsWith("/sse-error/")) {
      // A 200 that reports a failure mid-stream, then keeps the connection
      // open and would keep generating — the early exit the reader must cancel.
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(sse({ error: { message: "model crashed" } }));
      res.on("close", () => onHangClosed?.());
      return;
    }
    // /slow/: headers only after DELAY_MS, then a stall mid-body.
    setTimeout(() => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(sse({ choices: [{ delta: { content: "hello" } }] }));
      setTimeout(() => {
        res.write(sse({ choices: [{ delta: { content: " world" }, finish_reason: "stop" }] }));
        res.end("data: [DONE]\n\n");
      }, DELAY_MS);
    }, DELAY_MS);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  process.env.LOXAIC_INSTANCE_ID = host;
  await db.insert(localModels).values({
    id: "m",
    hostId: host,
    repo: "test/m",
    revision: "0".repeat(40),
    quant: "Q4",
    files: [],
    sizeBytes: 0,
    status: "ready",
    enabled: true,
    displayName: "m",
    publisher: "test",
  });
  invalidateLocalModelCache();
});

afterAll(async () => {
  await db.delete(localModels).where(eq(localModels.hostId, host));
  if (previousHost === undefined) Reflect.deleteProperty(process.env, "LOXAIC_INSTANCE_ID");
  else process.env.LOXAIC_INSTANCE_ID = previousHost;
  invalidateLocalModelCache();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

afterEach(() => {
  vi.unstubAllEnvs();
  onHangClosed = null;
});

async function collect(stream: AsyncGenerator<StreamEvent>) {
  let text = "";
  for await (const event of stream) if (event.type === "done") text = event.result.text;
  return text;
}

describe("inference transport", () => {
  it("control: a short headers timeout cuts this backend off, with a message that says so", async () => {
    const short = createInferenceDispatcher({ headersTimeout: SHORT_TIMEOUT_MS });
    try {
      await expect(
        inferenceFetch(`${base}/slow/v1/chat/completions`, { method: "POST", body: "{}" }, short),
      ).rejects.toThrow(/did not start its reply before the request timed out/);
    } finally {
      await short.destroy();
    }
  });

  it("the real inference path waits out slow headers and a mid-reply stall", async () => {
    vi.stubEnv("MOCK_INFERENCE", "false");
    attach(`${base}/slow`);
    const text = await collect(streamCompletion("m", [{ role: "user", content: "hi" }]));
    expect(text).toBe("hello world");
  });

  it("Stop still works while waiting for headers: rejects promptly with AbortError and closes the connection", async () => {
    vi.stubEnv("MOCK_INFERENCE", "false");
    attach(`${base}/hang`);
    const closed = new Promise<void>((resolve) => {
      onHangClosed = resolve;
    });
    const abort = new AbortController();
    const started = Date.now();
    setTimeout(() => {
      abort.abort();
    }, SHORT_TIMEOUT_MS);

    const err = await collect(
      streamCompletion("m", [{ role: "user", content: "hi" }], { signal: abort.signal }),
    ).then(
      () => null,
      (e: unknown) => e as Error,
    );

    expect(err?.name).toBe("AbortError");
    expect(Date.now() - started).toBeLessThan(2_000);
    // The backend is told, so it stops evaluating a prompt nobody wants.
    await closed;
  });

  it("the real path uses the shared dispatcher, whose timeouts are the long ceiling — not 0, not undici's 300 s", async () => {
    // The delays above cannot tell 1 h from undici's 300 s default, so read the
    // options off the dispatcher production actually uses. undici keeps them
    // under Symbol('options'); if that moves, this fails loudly, not silently.
    expect(INFERENCE_TIMEOUT_CEILING_MS).toBeGreaterThanOrEqual(60 * 60 * 1000);
    const dispatcher = inferenceDispatcher();
    const optionsKey = Object.getOwnPropertySymbols(dispatcher).find((s) => s.description === "options");
    if (!optionsKey) throw new Error("undici no longer keeps Agent options under Symbol('options')");
    const options = (dispatcher as unknown as Record<symbol, { headersTimeout?: number; bodyTimeout?: number }>)[
      optionsKey
    ];
    expect(options.headersTimeout).toBe(INFERENCE_TIMEOUT_CEILING_MS);
    expect(options.bodyTimeout).toBe(INFERENCE_TIMEOUT_CEILING_MS);

    // And streamCompletion really sends through that instance, rather than the
    // global fetch or a fresh default Agent.
    const dispatch = vi.spyOn(dispatcher, "dispatch");
    try {
      vi.stubEnv("MOCK_INFERENCE", "false");
      attach(`${base}/fast`);
      expect(await collect(streamCompletion("m", [{ role: "user", content: "hi" }]))).toBe("hi");
      expect(dispatch).toHaveBeenCalled();
    } finally {
      dispatch.mockRestore();
    }
  });

  it("an early exit mid-stream cancels the response, so the backend sees the connection close", async () => {
    vi.stubEnv("MOCK_INFERENCE", "false");
    attach(`${base}/sse-error`);
    const closed = new Promise<void>((resolve) => {
      onHangClosed = resolve;
    });
    await expect(collect(streamCompletion("m", [{ role: "user", content: "hi" }]))).rejects.toThrow(
      /Inference backend error: model crashed/,
    );
    // Releasing the reader alone leaves this open until the hour-long ceiling.
    await closed;
  });

  it("an unrecognised network failure names its code but never the backend's address", () => {
    const cause = Object.assign(new Error("connect EHOSTUNREACH 10.0.0.5:4002"), { code: "EHOSTUNREACH" });
    const err = inferenceNetworkError(new TypeError("fetch failed", { cause })) as Error;
    expect(err.message).toBe("The request to the model server failed (EHOSTUNREACH).");
    expect(err.message).not.toMatch(/10\.0\.3\.14|4002/);

    const uncoded = inferenceNetworkError(
      new TypeError("fetch failed", { cause: new Error("connect somewhere.internal:4002") }),
    ) as Error;
    expect(uncoded.message).toBe("The request to the model server failed.");
  });

  it("an unreachable backend reports what happened, not a bare 'fetch failed'", async () => {
    const dead = http.createServer();
    await new Promise<void>((resolve) => dead.listen(0, "127.0.0.1", resolve));
    const port = (dead.address() as AddressInfo).port;
    await new Promise((resolve) => dead.close(resolve));

    vi.stubEnv("MOCK_INFERENCE", "false");
    attach(`http://127.0.0.1:${String(port)}`);
    await expect(collect(streamCompletion("m", [{ role: "user", content: "hi" }]))).rejects.toThrow(
      /Could not reach the model server: the connection was refused/,
    );
  });
});

/**
 * What undici's FinalizationRegistry does to a long request once its internal
 * Request object has been collected: it removes the listener that tied the
 * caller's signal to the request. Garbage collection cannot be made to happen
 * on cue, so this removes that listener directly — undici builds it as a
 * function named `abort` (fetch/request.js's buildAbort). Found live that way:
 * one aborted signal, no listeners, fetch still "ongoing".
 */
function severFetchLink(signal: AbortSignal): number {
  const theirs = getEventListeners(signal, "abort").filter((l) => l.name === "abort");
  for (const l of theirs) signal.removeEventListener("abort", l as EventListener);
  return theirs.length;
}

describe("Stop once undici has lost its own link to the run's signal", () => {
  it("still ends a streaming reply, and the backend sees the connection close", async () => {
    const closed = new Promise<void>((resolve) => {
      onHangClosed = resolve;
    });
    const abort = new AbortController();
    const response = await inferenceFetch(`${base}/forever/v1/chat/completions`, { method: "POST", signal: abort.signal });
    if (!response.body) throw new Error("the stand-in answered with no body");
    const reader = response.body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
    await reader.read();
    // The precondition this case exists for: fetch's own link was there, and is gone.
    expect(severFetchLink(abort.signal)).toBe(1);

    abort.abort();
    const started = Date.now();
    const outcome = await Promise.race([
      (async () => {
        try {
          for (;;) if ((await reader.read()).done) return "ended";
        } catch {
          return "stopped";
        }
      })(),
      new Promise((resolve) => {
        setTimeout(() => { resolve("still streaming"); }, 3_000);
      }),
    ]);
    expect(outcome).toBe("stopped");
    expect(Date.now() - started).toBeLessThan(2_000);
    await closed;
  });

  it("still ends a request that is waiting for headers", async () => {
    const closed = new Promise<void>((resolve) => {
      onHangClosed = resolve;
    });
    const abort = new AbortController();
    const pending = inferenceFetch(`${base}/hang/v1/chat/completions`, { method: "POST", signal: abort.signal });
    expect(severFetchLink(abort.signal)).toBe(1);
    setTimeout(() => { abort.abort(); }, SHORT_TIMEOUT_MS);
    const started = Date.now();
    await expect(pending).rejects.toBeDefined();
    expect(Date.now() - started).toBeLessThan(2_000);
    await closed;
  });

  it("ends the run's stream of a local model — the path the engine reads — once Stop is pressed", async () => {
    vi.stubEnv("MOCK_INFERENCE", "false");
    attach(`${base}/forever`);
    const abort = new AbortController();
    const started = Date.now();
    const outcome = await (async () => {
      try {
        for await (const event of streamCompletion("m", [{ role: "user", content: "hi" }], { signal: abort.signal })) {
          if (event.type === "delta" && !abort.signal.aborted) {
            severFetchLink(abort.signal);
            abort.abort();
          }
          if (Date.now() - started > 3_000) return "still streaming";
        }
        return "ended";
      } catch {
        return "stopped";
      }
    })();
    expect(outcome).toBe("stopped");
  });

  it("still reports an ordinary Stop as an AbortError while fetch's link is intact", async () => {
    const abort = new AbortController();
    const pending = inferenceFetch(`${base}/hang/v1/chat/completions`, { method: "POST", signal: abort.signal });
    setTimeout(() => { abort.abort(); }, SHORT_TIMEOUT_MS);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("leaves no listener on the run's signal once a request has finished", async () => {
    const abort = new AbortController();
    const response = await inferenceFetch(`${base}/fast/v1/chat/completions`, { method: "POST", signal: abort.signal });
    await response.text();
    // One run's signal outlives many requests; each must let go of it.
    await new Promise((resolve) => setImmediate(resolve));
    expect(getEventListeners(abort.signal, "abort").filter((l) => l.name !== "abort")).toHaveLength(0);
  });
});
