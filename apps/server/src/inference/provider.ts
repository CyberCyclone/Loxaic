const BASE_URL = process.env.INFERENCE_BASE_URL || "http://localhost:4002";
const MOCK_MODE = process.env.MOCK_INFERENCE === "true";

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type LlamaTimings = {
  prompt_n: number;
  prompt_ms: number;
  prompt_per_token_ms: number;
  prompt_per_second: number;
  predicted_n: number;
  predicted_ms: number;
  predicted_per_token_ms: number;
  predicted_per_second: number;
  cache_n?: number;
  total_ms?: number;
};

export type CompletionResult = {
  text: string;
  content: string;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  timings: LlamaTimings | null;
};

export async function* streamCompletion(
  model: string,
  messages: ChatMessage[],
): AsyncGenerator<
  { type: "delta"; content: string }
  | { type: "done"; result: CompletionResult },
  void,
  unknown
> {
  if (MOCK_MODE) {
    yield* mockStream(messages);
    return;
  }
  yield* liveStream(model, messages);
}

async function* mockStream(
  messages: ChatMessage[],
): AsyncGenerator<
  { type: "delta"; content: string }
  | { type: "done"; result: CompletionResult },
  void,
  unknown
> {
  const last = messages[messages.length - 1];
  const response = `[Mock] Echo: ${last?.content || "Hello"}`;
  const words = response.split(" ");

  for (let i = 0; i < words.length; i++) {
    yield { type: "delta", content: (i === 0 ? "" : " ") + words[i] };
    await new Promise((r) => setTimeout(r, 50));
  }

  yield {
    type: "done",
    result: {
      text: response,
      content: response,
      usage: { prompt_tokens: 10, completion_tokens: words.length, total_tokens: 10 + words.length },
      timings: {
        prompt_n: 10,
        prompt_ms: 50,
        prompt_per_token_ms: 5,
        prompt_per_second: 200,
        predicted_n: words.length,
        predicted_ms: 150,
        predicted_per_token_ms: 15,
        predicted_per_second: 66,
        cache_n: 3,
        total_ms: 200,
      },
    },
  };
}

async function* liveStream(
  model: string,
  messages: ChatMessage[],
): AsyncGenerator<
  { type: "delta"; content: string }
  | { type: "done"; result: CompletionResult },
  void,
  unknown
> {
  const startTime = Date.now();
  let ttftRecorded = false;
  let fullText = "";

  const response = await fetch(`${BASE_URL}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages,
      stream: true,
      stream_options: { include_usage: true },
    }),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    throw new Error(`Inference error ${response.status}: ${errText}`);
  }

  if (!response.body) throw new Error("Inference response has no body");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let lastUsage: CompletionResult["usage"] | null = null;
  let lastTimings: LlamaTimings | null = null;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data: ")) continue;
        const jsonStr = trimmed.slice(6);
        if (jsonStr === "[DONE]") continue;

        try {
          const parsed = JSON.parse(jsonStr);
          const choice = parsed.choices?.[0];
          if (choice?.delta?.content) {
            if (!ttftRecorded) {
              ttftRecorded = true;
            }
            fullText += choice.delta.content;
            yield { type: "delta", content: choice.delta.content };
          }
          if (parsed.usage) lastUsage = parsed.usage;
          if (parsed.timings) lastTimings = parsed.timings as LlamaTimings;
        } catch {
          // ignore parse errors
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  if (lastTimings) lastTimings.total_ms = Date.now() - startTime;

  yield {
    type: "done",
    result: {
      text: fullText,
      content: fullText,
      usage: lastUsage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      timings: lastTimings,
    },
  };
}