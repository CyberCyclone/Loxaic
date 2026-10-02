import { describe, expect, it } from "vitest";
import { effectiveThinkingLevel, type ModelThinking } from "@loxaic/types";
import { openAiThinking, openRouterThinking, thinkingFields, thinkingFromTemplate } from "../thinking.ts";

/** The thinking block of Qwen3.8's chat template (Flash-Next and the 27B share
 * it), as shipped in unsloth's GGUFs. It validates the effort and raises on
 * any other word — "none" included — so only the words it names may be sent. */
const QWEN38 = `
{%- set reasoning_instructions = '' %}
{%- if enable_thinking is undefined or enable_thinking is true %}
    {%- set resolved_reasoning_effort = reasoning_effort|default('xhigh') %}
    {%- if resolved_reasoning_effort == 'high' %}
        {%- set resolved_reasoning_effort = 'xhigh' %}
    {%- endif %}
    {%- if resolved_reasoning_effort not in ('xhigh', 'medium', 'low') %}
        {{- raise_exception('Unexpected reasoning effort ' ~ reasoning_effort ~ '. Supported types are xhigh (default), medium, and low.') }}
    {%- endif %}
    {%- if resolved_reasoning_effort == 'xhigh' %}
        {%- set reasoning_instructions = 'Reasoning effort is set to xhigh. Please think carefully through the task.' %}
    {%- elif resolved_reasoning_effort == 'low' %}
        {%- set reasoning_instructions = 'Reasoning effort is set to low. Keep your thinking brief.' %}
    {%- endif %}
{%- endif %}
{%- if add_generation_prompt %}
    {{- '<|im_start|>assistant\\n' }}
    {%- if enable_thinking is defined and enable_thinking is false %}
        {{- '<think>\\n\\n</think>\\n\\n' }}
    {%- else %}
        {{- '<think>\\n' }}
    {%- endif %}
{%- endif %}`;

/** Qwen3.5 / 3.6: thinking can only be switched off. */
const QWEN36 = `
{%- if add_generation_prompt %}
    {{- '<|im_start|>assistant\\n' }}
    {%- if enable_thinking is defined and enable_thinking is false %}
        {{- '<think>\\n\\n</think>\\n\\n' }}
    {%- endif %}
{%- endif %}`;

/** gpt-oss reads the effort into the prompt without checking it. */
const GPT_OSS = `
{%- if not reasoning_effort is defined %}
    {%- set reasoning_effort = "medium" %}
{%- endif %}
{{- "Reasoning: " + reasoning_effort + "\\n\\n" }}`;

const PLAIN = `{%- for message in messages %}{{ '<|im_start|>' + message.role + '\\n' + message.content }}{%- endfor %}`;

describe("thinkingFromTemplate", () => {
  it("offers exactly the efforts a validating template names, and None through enable_thinking", () => {
    expect(thinkingFromTemplate(QWEN38)).toEqual({
      levels: ["None", "Low", "Medium", "High"],
      toggle: false,
      dialect: "llama",
      // "high" rather than "xhigh": the template maps one to the other, and
      // the error message's own words ("Supported types are…") are not efforts.
      wire: { None: "none", Low: "low", Medium: "medium", High: "high" },
    });
  });

  it("makes a template that can only switch thinking off a toggle", () => {
    expect(thinkingFromTemplate(QWEN36)).toEqual({ levels: ["None", "Medium"], toggle: true, dialect: "llama", wire: {} });
  });

  it("gives a template that reads the effort unchecked low, medium and high, and no None", () => {
    expect(thinkingFromTemplate(GPT_OSS)).toEqual({
      levels: ["Low", "Medium", "High"],
      toggle: false,
      dialect: "llama",
      wire: { Low: "low", Medium: "medium", High: "high" },
    });
  });

  it("finds nothing in a template that takes neither, or no template", () => {
    expect(thinkingFromTemplate(PLAIN)).toBeNull();
    expect(thinkingFromTemplate(null)).toBeNull();
    expect(thinkingFromTemplate("")).toBeNull();
  });

  it("drops a validating template whose words it does not know", () => {
    const odd = `{%- if reasoning_effort not in ('fast', 'slow') %}{{ raise_exception('no') }}{%- endif %}`;
    expect(thinkingFromTemplate(odd)).toBeNull();
  });

  it("stays linear on openers that never close", () => {
    // The shape that made the old regex scan to the end of the input once per
    // opener: 2.3 s for 128 KB, and quadratic. Both kinds, up to the cap.
    for (const opener of ["{%-", "{{"]) {
      const hostile = `{% if reasoning_effort == 'low' %}${opener.repeat(Math.floor((1024 * 1024 - 64) / opener.length))}`;
      const started = Date.now();
      expect(thinkingFromTemplate(hostile)?.levels).toContain("Low");
      expect(Date.now() - started).toBeLessThan(500);
    }
  });

  it("reads nothing from a template past the cap", () => {
    expect(thinkingFromTemplate(QWEN38 + " ".repeat(1024 * 1024))).toBeNull();
  });
});

describe("openAiThinking", () => {
  it("knows which OpenAI models take which efforts", () => {
    expect(openAiThinking("gpt-5")?.levels).toEqual(["Low", "Medium", "High"]);
    expect(openAiThinking("gpt-5-mini")?.levels).toEqual(["Low", "Medium", "High"]);
    expect(openAiThinking("gpt-5-codex")?.levels).toEqual(["Low", "Medium", "High"]);
    // "none" only from 5.1: older models answer it with a 400.
    expect(openAiThinking("gpt-5.1")?.levels).toEqual(["None", "Low", "Medium", "High"]);
    expect(openAiThinking("gpt-5.2-2025-12-11")?.levels).toEqual(["None", "Low", "Medium", "High"]);
    expect(openAiThinking("gpt-6")?.levels).toEqual(["None", "Low", "Medium", "High"]);
    expect(openAiThinking("gpt-5-pro")?.levels).toEqual(["High"]);
    expect(openAiThinking("o3")?.levels).toEqual(["Low", "Medium", "High"]);
    expect(openAiThinking("o4-mini")?.levels).toEqual(["Low", "Medium", "High"]);
    expect(openAiThinking("openai/o3-mini")?.dialect).toBe("openai");
  });

  it("gives chat and non-reasoning models nothing", () => {
    for (const id of ["gpt-5-chat-latest", "gpt-4o", "gpt-4.1", "o1-mini", "o1-preview", "text-embedding-3-large", "dall-e-3"]) {
      expect({ id, thinking: openAiThinking(id) }).toEqual({ id, thinking: null });
    }
  });
});

describe("openRouterThinking", () => {
  it("follows the listing's supported_parameters, never offering None", () => {
    expect(openRouterThinking(["tools", "reasoning", "include_reasoning"])).toEqual({
      levels: ["Low", "Medium", "High"],
      toggle: false,
      dialect: "openrouter",
      wire: { Low: "low", Medium: "medium", High: "high" },
    });
    expect(openRouterThinking(["tools", "temperature"])).toBeNull();
    expect(openRouterThinking(undefined)).toBeNull();
    expect(openRouterThinking("reasoning")).toBeNull();
  });
});

describe("thinkingFields", () => {
  const qwen38 = thinkingFromTemplate(QWEN38);
  const qwen36 = thinkingFromTemplate(QWEN36);
  const gptOss = thinkingFromTemplate(GPT_OSS);

  it("sends llama.cpp reasoning_effort, and its word for off", () => {
    expect(thinkingFields(qwen38, "High")).toEqual({ reasoning_effort: "high" });
    expect(thinkingFields(qwen38, "Medium")).toEqual({ reasoning_effort: "medium" });
    expect(thinkingFields(qwen38, "Low")).toEqual({ reasoning_effort: "low" });
    // Both words: b11149+ converts the effort, an older build reads the kwarg.
    expect(thinkingFields(qwen38, "None")).toEqual({ reasoning_effort: "none", chat_template_kwargs: { enable_thinking: false } });
  });

  it("switches a toggle model on or off, whatever level was asked for", () => {
    expect(thinkingFields(qwen36, "None")).toEqual({ reasoning_effort: "none", chat_template_kwargs: { enable_thinking: false } });
    for (const level of ["Low", "Medium", "High"] as const) {
      expect(thinkingFields(qwen36, level)).toEqual({ chat_template_kwargs: { enable_thinking: true } });
    }
  });

  it("never sends a level the model does not take", () => {
    // gpt-oss cannot be switched off: None is clamped up to Low, not sent.
    expect(thinkingFields(gptOss, "None")).toEqual({ reasoning_effort: "low" });
    // gpt-5-pro takes high only.
    expect(thinkingFields(openAiThinking("gpt-5-pro"), "Low")).toEqual({ reasoning_effort: "high" });
    expect(thinkingFields(openAiThinking("gpt-5"), "None")).toEqual({ reasoning_effort: "low" });
  });

  it("uses each hosted vendor's own field", () => {
    expect(thinkingFields(openAiThinking("gpt-5.1"), "None")).toEqual({ reasoning_effort: "none" });
    expect(thinkingFields(openAiThinking("o3"), "High")).toEqual({ reasoning_effort: "high" });
    expect(thinkingFields(openRouterThinking(["reasoning"]), "Low")).toEqual({ reasoning: { effort: "low" } });
    expect(thinkingFields(openRouterThinking(["reasoning"]), "None")).toEqual({ reasoning: { effort: "low" } });
  });

  it("sends nothing for a model that takes no level", () => {
    expect(thinkingFields(null, "High")).toEqual({});
    expect(thinkingFields(undefined, "None")).toEqual({});
    expect(thinkingFields({ levels: [], toggle: false, dialect: "openai", wire: {} }, "High")).toEqual({});
  });
});

describe("effectiveThinkingLevel", () => {
  const some: ModelThinking = { levels: ["None", "Low", "High"], toggle: false, dialect: "llama", wire: {} };

  it("keeps an offered level and takes the cheaper of two equally near otherwise", () => {
    expect(effectiveThinkingLevel(some, "High")).toBe("High");
    expect(effectiveThinkingLevel(some, "Medium")).toBe("Low");
  });

  it("reads a toggle as off or on", () => {
    const toggle: ModelThinking = { levels: ["None", "Medium"], toggle: true, dialect: "llama", wire: {} };
    expect(effectiveThinkingLevel(toggle, "None")).toBe("None");
    expect(effectiveThinkingLevel(toggle, "High")).toBe("Medium");
  });
});
