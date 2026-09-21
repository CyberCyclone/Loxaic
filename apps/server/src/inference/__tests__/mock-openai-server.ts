import { createServer, type Server } from "node:http";

/**
 * A minimal OpenAI-compatible backend, so the provider path can be exercised
 * end to end with nothing stubbed.
 *
 * It exists because the interesting assertions are all about the *wire*: that
 * the API key went out as a bearer, that the `slug::` prefix did not, that a
 * custom header arrived, and that the prompt each request carried extends the
 * one before it. None of those can be made against a mocked `streamCompletion`
 * — they are exactly the things a mock would paper over.
 *
 * Every request is recorded, including the ones it rejects: what a wrong key
 * produces is as much a case as what a right one does.
 */

export interface RecordedRequest {
  path: string;
  authorization: string | null;
  headers: Record<string, string | undefined>;
  body: {
    model?: string;
    messages?: { role: string; content?: unknown; name?: string; tool_calls?: unknown }[];
    tools?: unknown[];
    tool_choice?: unknown;
    return_progress?: unknown;
  };
}

export interface MockOpenAiOptions {
  /** When set, every other bearer is refused with a 401 whose body quotes the
   * key it rejected — which is what a real vendor does, and the reason the
   * error path has to redact. */
  apiKey?: string;
  /** Model ids `/models` reports. */
  models?: { id: string; context_length?: number }[];
  /** What a completion replies with. */
  reply?: string;
  /** Delay before the first token, for observing a queue. */
  delayMs?: number;
  /** Answer `/props` the way llama.cpp does, identifying itself as a local
   * runtime with this allocated window. */
  nCtx?: number;
  /** Stream `prompt_progress` chunks, in llama.cpp's exact shape, when the
   * request asked with `return_progress` — one malformed one among them. */
  progress?: boolean;
}

/** What `progress` streams before the reply: llama.cpp's 0% report as the
 * slot starts, a bad one, then two batches. */
export const MOCK_PROGRESS_CHUNKS = [
  { total: 1000, cache: 200, processed: 200, time_ms: 0 },
  { total: "lots", cache: 0, processed: 0, time_ms: 0 },
  { total: 1000, cache: 200, processed: 600, time_ms: 100 },
  { total: 1000, cache: 200, processed: 1000, time_ms: 200 },
];

export interface MockOpenAi {
  url: string;
  /** The API base a provider row should be given. */
  apiBase: string;
  requests: RecordedRequest[];
  completions: RecordedRequest[];
  stop(): Promise<void>;
}

function sse(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

export async function startMockOpenAi(options: MockOpenAiOptions = {}): Promise<MockOpenAi> {
  const requests: RecordedRequest[] = [];
  const models = options.models ?? [{ id: "mock-remote-model", context_length: 128_000 }];
  const reply = options.reply ?? "Hello from the mock provider.";

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body: RecordedRequest["body"] = {};
      try {
        body = raw ? (JSON.parse(raw) as RecordedRequest["body"]) : {};
      } catch {
        // A non-JSON body is still worth recording as one that arrived.
      }
      const authorization = req.headers.authorization ?? null;
      requests.push({
        path: req.url ?? "",
        authorization,
        headers: req.headers as Record<string, string | undefined>,
        body,
      });

      if (options.apiKey && authorization !== `Bearer ${options.apiKey}`) {
        res.writeHead(401, { "Content-Type": "application/json" });
        // Deliberately echoes the rejected key, the way OpenAI's own 401 does
        // ("Incorrect API key provided: sk-…"). The redaction path has nothing
        // to prove against a vendor that stays quiet.
        res.end(
          JSON.stringify({
            error: { message: `Incorrect API key provided: ${authorization ?? "none"}. Check your credentials.` },
          }),
        );
        return;
      }

      if (req.url?.endsWith("/models")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ data: models.map((m) => ({ object: "model", ...m })) }));
        return;
      }

      if (req.url?.endsWith("/chat/completions")) {
        const send = () => {
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          });
          const id = "chatcmpl-mock";
          if (options.progress && body.return_progress === true) {
            // Each carries an empty assistant delta with `content: null`,
            // exactly as llama.cpp's do — which must not read as output.
            for (const prompt_progress of MOCK_PROGRESS_CHUNKS) {
              res.write(sse({ id, choices: [{ delta: { role: "assistant", content: null } }], prompt_progress }));
            }
          }
          res.write(sse({ id, choices: [{ delta: { role: "assistant" } }] }));
          res.write(sse({ id, choices: [{ delta: { content: reply } }] }));
          res.write(sse({ id, choices: [{ delta: {}, finish_reason: "stop" }] }));
          res.write(
            sse({
              id,
              choices: [],
              usage: {
                prompt_tokens: 12,
                completion_tokens: 7,
                total_tokens: 19,
                // The OpenAI-shaped cache figure, so the "not null, not zero"
                // rule has a provider that actually reports one.
                prompt_tokens_details: { cached_tokens: 4 },
              },
            }),
          );
          res.write("data: [DONE]\n\n");
          res.end();
        };
        if (options.delayMs) setTimeout(send, options.delayMs);
        else send();
        return;
      }

      if (req.url === "/props" && options.nCtx) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ default_generation_settings: { n_ctx: options.nCtx }, total_slots: 1 }));
        return;
      }

      // Everything else — `/props`, `/api/v0/models` — is absent, exactly as
      // it is on a hosted provider.
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "not found" } }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("mock provider did not bind a port");
  const url = `http://127.0.0.1:${String(address.port)}`;

  return {
    url,
    apiBase: `${url}/v1`,
    requests,
    get completions() {
      return requests.filter((r) => r.path.endsWith("/chat/completions"));
    },
    stop: () =>
      new Promise<void>((resolve) => {
        server.close(() => { resolve(); });
      }),
  };
}
