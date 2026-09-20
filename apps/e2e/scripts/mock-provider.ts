import { createServer, type Server } from 'node:http';

/**
 * A stand-in for an external LLM provider — OpenRouter, OpenAI, Anthropic —
 * speaking the OpenAI-compatible protocol the real ones do.
 *
 * It exists because `MOCK_INFERENCE` deliberately does **not** cover an added
 * provider: mock mode stands in for the backend `INFERENCE_BASE_URL` names,
 * and leaving an added one live is what lets the mock lane exercise the whole
 * provider path — the bearer, the model id with our `slug::` prefix stripped
 * off, the streamed reply — with nothing stubbed. Against a mocked
 * `streamCompletion` none of those could be asserted at all.
 *
 * Two keys, for the same reason `mock-github.ts` has two tokens: a spec cannot
 * reconfigure a server started once per stand-up, so every behaviour has to be
 * reachable by choosing a credential. The rejected one matters more than the
 * accepted one here — its 401 body quotes the key it rejected, exactly as
 * OpenAI's own does, which is what the redaction path has to survive.
 */
export const VALID_KEY = 'sk-e2e-valid-key-0123456789';
export const WRONG_KEY = 'sk-e2e-wrong-key-0123456789';

/** What this provider lists. Names nothing the built-in mock backend serves,
 * so a spec asserting on a group can never be reading the wrong one. */
export const PROVIDER_MODELS = [
  { id: 'acme/nova-large', context_length: 200_000 },
  { id: 'acme/nova-mini', context_length: 64_000 },
];

export interface RecordedRequest {
  path: string;
  authorization: string | null;
  model: string | null;
}

export interface MockProvider {
  /** The API base a provider row should be given, version segment included. */
  apiBase: string;
  stop: () => Promise<void>;
}

function sse(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

export async function startMockProvider(): Promise<MockProvider> {
  const requests: RecordedRequest[] = [];

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const url = req.url ?? '';

      // Before the auth gate, like mock-github's `/__e2e/pulls`: this is the
      // harness asking what was recorded, not a client being served.
      if (url.startsWith('/__e2e/requests')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(requests));
        return;
      }

      let body: { model?: string } = {};
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        body = raw ? (JSON.parse(raw) as { model?: string }) : {};
      } catch {
        // A malformed body is still a request that arrived.
      }
      const authorization = req.headers.authorization ?? null;
      requests.push({ path: url, authorization, model: body.model ?? null });

      if (authorization !== `Bearer ${VALID_KEY}`) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        // Quotes the rejected credential on purpose — see the module comment.
        res.end(
          JSON.stringify({
            error: { message: `Incorrect API key provided: ${authorization ?? 'none'}.` },
          }),
        );
        return;
      }

      if (url.endsWith('/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: PROVIDER_MODELS.map((m) => ({ object: 'model', ...m })) }));
        return;
      }

      if (url.endsWith('/chat/completions')) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        const id = 'chatcmpl-e2e';
        res.write(sse({ id, choices: [{ delta: { role: 'assistant' } }] }));
        // Distinctive, so a spec asserting on it cannot be reading the
        // built-in mock backend's reply by mistake.
        res.write(sse({ id, choices: [{ delta: { content: 'Reply from the external provider.' } }] }));
        res.write(sse({ id, choices: [{ delta: {}, finish_reason: 'stop' }] }));
        res.write(sse({ id, choices: [], usage: { prompt_tokens: 11, completion_tokens: 6, total_tokens: 17 } }));
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }

      // Everything else — `/props`, `/api/v0/models` — is absent, as it is on
      // every hosted provider.
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'not found' } }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('mock provider did not bind a port');

  return {
    apiBase: `http://127.0.0.1:${String(address.port)}/v1`,
    stop: () =>
      new Promise<void>((resolve) => {
        server.close(() => { resolve(); });
      }),
  };
}
