import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
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

beforeAll(async () => {
  server = http.createServer((req, res) => {
    req.resume();
    if (req.url?.startsWith("/hang/")) {
      // Never answers: a prompt still being evaluated.
      req.on("close", () => onHangClosed?.());
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
});

afterAll(async () => {
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
    vi.stubEnv("INFERENCE_BASE_URL", `${base}/slow`);
    const text = await collect(streamCompletion("m", [{ role: "user", content: "hi" }]));
    expect(text).toBe("hello world");
  });

  it("Stop still works while waiting for headers: rejects promptly with AbortError and closes the connection", async () => {
    vi.stubEnv("MOCK_INFERENCE", "false");
    vi.stubEnv("INFERENCE_BASE_URL", `${base}/hang`);
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
      vi.stubEnv("INFERENCE_BASE_URL", `${base}/fast`);
      expect(await collect(streamCompletion("m", [{ role: "user", content: "hi" }]))).toBe("hi");
      expect(dispatch).toHaveBeenCalled();
    } finally {
      dispatch.mockRestore();
    }
  });

  it("an early exit mid-stream cancels the response, so the backend sees the connection close", async () => {
    vi.stubEnv("MOCK_INFERENCE", "false");
    vi.stubEnv("INFERENCE_BASE_URL", `${base}/sse-error`);
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
    vi.stubEnv("INFERENCE_BASE_URL", `http://127.0.0.1:${String(port)}`);
    await expect(collect(streamCompletion("m", [{ role: "user", content: "hi" }]))).rejects.toThrow(
      /Could not reach the model server: the connection was refused/,
    );
  });
});
