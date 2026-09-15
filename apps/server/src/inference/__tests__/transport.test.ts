import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { streamCompletion, type StreamEvent } from "../provider.ts";
import { createInferenceDispatcher, inferenceFetch } from "../transport.ts";

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
