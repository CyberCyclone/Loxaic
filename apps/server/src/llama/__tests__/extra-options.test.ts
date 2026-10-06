import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ExtraOptionError,
  MAX_EXTRA_OPTIONS,
  extraOptionLines,
  normalizeExtraOptions,
  parseHelp,
  reservedReason,
  type OptionList,
} from "../extra-options.ts";
import { LOAD_SETTINGS } from "../load-settings.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
// What b11342's own `llama-server --help` printed on macOS (Metal).
const help = readFileSync(path.join(here, "../../../test-fixtures/llama-help-b11342.txt"), "utf8");
const real = parseHelp(help);

function group(list: OptionList, name: string) {
  const g = list.byName.get(name);
  if (!g) throw new Error(`no ${name}`);
  return g;
}

function refusal(rows: unknown, list: OptionList = real): ExtraOptionError {
  try {
    normalizeExtraOptions(rows, list);
  } catch (err) {
    if (err instanceof ExtraOptionError) return err;
    throw err;
  }
  throw new Error("accepted");
}

describe("parseHelp, against a real b11342", () => {
  it("reads every alias of an option into one group", () => {
    const ngl = group(real, "ngl");
    expect(ngl.names).toEqual(["ngl", "gpu-layers", "n-gpu-layers"]);
    expect(ngl.takesValue).toBe(true);
    expect(group(real, "n-gpu-layers")).toBe(ngl);
  });

  it("keeps a flag's negation in its group and says it takes no value", () => {
    const kvo = group(real, "kv-offload");
    expect(kvo.names).toEqual(["kvo", "kv-offload", "nkvo", "no-kv-offload"]);
    expect(kvo.takesValue).toBe(false);
    expect(group(real, "metrics").takesValue).toBe(false);
    expect(group(real, "no-warmup")).toBe(group(real, "warmup"));
  });

  it("reads placeholders of every shape as a value", () => {
    for (const name of ["keep", "flash-attn", "rope-scaling", "tensor-split", "device", "spec-type", "override-tensor-draft", "cpu-strict", "docker-repo"]) {
      expect(group(real, name).takesValue, name).toBe(true);
    }
  });

  it("reads a description that starts on the next line", () => {
    expect(group(real, "kv-offload").description).toMatch(/KV/);
    expect(group(real, "keep").description).toMatch(/^number of tokens to keep from the initial prompt .*all\)$/);
  });

  it("does not mistake a placeholder's own comma for another name", () => {
    expect(group(real, "override-tensor-draft").names).toEqual(["spec-draft-override-tensor", "otd", "override-tensor-draft"]);
    expect(real.byName.has("..."), "a placeholder fragment").toBe(false);
  });

  it("knows every key Loxaic itself writes, which are its own names", () => {
    for (const s of LOAD_SETTINGS) expect(real.byName.has(s.flag), s.flag).toBe(true);
  });

  it("is linear on hostile text", () => {
    const hostile = `-${" ".repeat(1)}${",  -a".repeat(200_000)}\n${"-x".repeat(500_000)}`;
    const started = performance.now();
    parseHelp(hostile);
    parseHelp("-a, ".repeat(250_000));
    expect(performance.now() - started).toBeLessThan(2000);
  });
});

describe("the fake router's --help", () => {
  const fake = path.join(here, "../../../test-fixtures/fake-llama-server.mjs");
  const read = (env: Record<string, string> = {}) =>
    parseHelp(execFileSync(process.execPath, [fake, "--help"], { encoding: "utf8", env: { PATH: process.env.PATH ?? "", ...env } }));

  it("lists every key Loxaic writes, laid out as llama.cpp's is, so the e2e lane checks what production does", () => {
    const list = read();
    for (const s of LOAD_SETTINGS) expect(list.byName.has(s.flag), s.flag).toBe(true);
    expect(list.byName.get("nocb")?.names).toEqual(["cb", "cont-batching", "nocb", "no-cont-batching"]);
    expect(reservedReason(group(list, "port"))).not.toBeNull();
  });

  it("leaves out the option an older mock release does not have", () => {
    expect(read({ LOXAIC_FAKE_HELP_OMIT: "keep" }).byName.has("keep")).toBe(false);
  });
});

describe("what may not be set", () => {
  it.each([
    ["ctx-size", /Context length/],
    ["c", /Context length/],
    ["ngl", /GPU offload/],
    ["no-kv-offload", /setting/],
    ["model", /file/],
    ["port", /router/],
    ["api-key", /router/],
    ["log-file", /outside/],
    ["hf-repo", /outside/],
    ["fim-qwen-7b-default", /outside/],
    ["log-verbosity", /prompts/],
    ["lv", /prompts/],
    ["v", /prompts/],
    ["log-colors", /log/],
    ["jinja", /chat template/],
    ["no-jinja", /chat template/],
    ["rope-scale", /context stages/],
    ["dev", /GPUs to use/],
    ["help", /exit/],
    ["draft-max", /removed/],
  ])("%s", (name, why) => {
    expect(reservedReason(group(real, name))).toMatch(why);
  });

  it("leaves the options people add this for alone", () => {
    for (const name of ["keep", "metrics", "lora", "cont-batching", "no-warmup", "cache-reuse", "swa-full", "spec-draft-ngl", "lookup-cache-static"]) {
      expect(reservedReason(group(real, name)), name).toBeNull();
    }
  });

  it("refuses the lookup cache that is written to, by either name, and not the one only read", () => {
    expect(reservedReason(group(real, "lcd"))).toMatch(/outside/);
    expect(reservedReason(group(real, "lookup-cache-dynamic"))).toMatch(/outside/);
    expect(reservedReason(group(real, "lcs"))).toBeNull();
  });

  it("refuses replacing the chat template, or its arguments, which tool calls and thinking levels need", () => {
    for (const name of ["chat-template", "chat-template-file", "chat-template-kwargs"]) {
      expect(reservedReason(group(real, name)), name).toMatch(/chat template/);
    }
  });

  it("does not read a no- option as the option without it", () => {
    // `--no-host` is a backend buffer option, nothing to do with `--host`.
    expect(group(real, "no-host").names).toEqual(["no-host"]);
    expect(reservedReason(group(real, "no-host"))).toBeNull();
  });
});

describe("normalizeExtraOptions", () => {
  it("keeps the key as typed, without its dashes, and tidies the value", () => {
    expect(
      normalizeExtraOptions(
        [
          { key: "--keep", value: " 64 " },
          { key: "no-warmup", value: "TRUE" },
          { key: "metrics", value: "false" },
        ],
        real,
      ),
    ).toEqual([
      { key: "keep", value: "64" },
      { key: "no-warmup", value: "true" },
      { key: "metrics", value: "false" },
    ]);
  });

  it("names the row it refuses", () => {
    const err = refusal([{ key: "keep", value: "1" }, { key: "bogus-key", value: "1" }]);
    expect(err.index).toBe(1);
    expect(err.message).toMatch(/no option "bogus-key"/);
  });

  it("refuses a reserved option by any of its names", () => {
    expect(refusal([{ key: "-ngl", value: "99" }]).message).toMatch(/GPU offload/);
  });

  it("refuses one option set twice, under two names", () => {
    const err = refusal([{ key: "metrics", value: "true" }, { key: "keep", value: "1" }, { key: "warmup", value: "true" }, { key: "no-warmup", value: "true" }]);
    expect(err.index).toBe(3);
    expect(err.message).toMatch(/same option as "warmup"/);
    expect(refusal([{ key: "keep", value: "1" }, { key: "keep", value: "2" }]).message).toMatch(/set twice/);
  });

  it("takes only true or false for a switch, and something for an option with a value", () => {
    expect(refusal([{ key: "metrics", value: "yes" }]).message).toMatch(/true or false/);
    expect(refusal([{ key: "keep", value: "  " }]).message).toMatch(/needs a value/);
  });

  it.each([
    ["key=1", "not an option name"],
    ["[*]", "not an option name"],
    ["a b", "not an option name"],
    ["", "Type the option's name"],
  ])("refuses the key %j", (key, why) => {
    expect(refusal([{ key, value: "1" }]).message).toContain(why);
  });

  it("refuses a value that would end the line", () => {
    expect(refusal([{ key: "keep", value: "1\n[evil]\nmodel = /etc/passwd" }]).message).toMatch(/one line/);
  });

  it("lets a stored row this build does not know stand as it is, and nothing else", () => {
    const kept = [{ key: "bogus-key", value: "1" }];
    expect(normalizeExtraOptions([{ key: "bogus-key", value: " 1 " }, { key: "keep", value: "2" }], real, kept)).toEqual([
      { key: "bogus-key", value: "1" },
      { key: "keep", value: "2" },
    ]);
    expect(refusal([{ key: "bogus-key", value: "2" }], real).message).toMatch(/no option "bogus-key"/);
    expect(() => normalizeExtraOptions([{ key: "bogus-key", value: "2" }], real, kept)).toThrow(/no option "bogus-key"/);
    expect(() => normalizeExtraOptions([{ key: "bogus-key", value: "1" }, { key: "bogus-key", value: "1" }], real, kept)).toThrow(/no option/);
  });

  it("caps the list", () => {
    const rows = Array.from({ length: MAX_EXTRA_OPTIONS + 1 }, () => ({ key: "keep", value: "1" }));
    expect(refusal(rows).index).toBeNull();
  });
});

describe("extraOptionLines", () => {
  it("writes what the build accepts", () => {
    expect(extraOptionLines([{ key: "keep", value: "64" }, { key: "metrics", value: "true" }], real)).toEqual({
      lines: ["keep = 64", "metrics = true"],
      skipped: [],
    });
  });

  it("leaves out a row the build running now does not know, so the router still starts", () => {
    const older = parseHelp(help.replace(/^--keep N.*$/m, ""));
    expect(older.byName.has("keep")).toBe(false);
    expect(extraOptionLines([{ key: "keep", value: "64" }, { key: "metrics", value: "true" }], older)).toEqual({
      lines: ["metrics = true"],
      skipped: ["keep"],
    });
  });

  it("writes nothing it could not check", () => {
    expect(extraOptionLines([{ key: "keep", value: "64" }], null)).toEqual({ lines: [], skipped: ["keep"] });
  });

  it("re-checks a stored row that came by another route", () => {
    const rows = [
      { key: "port", value: "1" },
      { key: "keep", value: "1\nmodel = x" },
      { key: "metrics", value: "on" },
      { key: "keep", value: "1" },
      { key: "keep", value: "2" },
    ];
    expect(extraOptionLines(rows, real)).toEqual({ lines: ["keep = 1"], skipped: ["port", "keep", "metrics", "keep"] });
  });
});
