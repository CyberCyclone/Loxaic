#!/usr/bin/env node
// A stand-in for llama.cpp's `llama-server` in router mode, for tests and the
// e2e mock lane (`LOXAIC_LLAMA_SERVER_BIN`). It speaks the parts of the router
// API the server uses — measured against b11149 — so the whole local-models
// path runs with no GPU, no real llama.cpp and no model weights:
//
//   --list-devices            prints LOXAIC_FAKE_DEVICES (or one 24 GB GPU)
//   GET  /health              no auth, like the real one
//   GET  /models[?reload=1]   the preset's sections and their load status
//   POST /models/load|unload
//   GET  /props?model=        slots and n_ctx from the model's section
//   POST /v1/chat/completions a short streamed reply, autoloading the model
//
// Everything but /health requires `Authorization: Bearer $LLAMA_API_KEY`.
// With LOXAIC_FAKE_ROUTER_LOG set, every load and unload appends a JSON line
// (a load with the section it loaded with), which is how a test proves
// settings reached the model and which models were unloaded to make room.
//
// Memory, when LOXAIC_FAKE_MODEL_MIB is set: every loaded model holds that many
// MiB of the first device, a load that would not fit fails (`status.failed`,
// as the real router reports it), and `--list-devices` reports the first
// device's free memory less what is loaded. The listing is a separate process
// from the router, so the router writes what it holds to
// LOXAIC_FAKE_VRAM_STATE for the listing to read. `--models-max N` (N > 0)
// unloads the least recently used model past N, as the real router does.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";

const args = process.argv.slice(2);

/** `LOXAIC_FAKE_HARDWARE` is `gpu`, `none`, or a file holding one of them —
 * the same seam the server's detection reads (apps/server/src/llama/hardware.ts). */
function fakeHardware() {
  const value = process.env.LOXAIC_FAKE_HARDWARE;
  if (!value || value === "gpu" || value === "none") return value ?? "gpu";
  try {
    return readFileSync(value, "utf8").trim() === "none" ? "none" : "gpu";
  } catch {
    return "gpu";
  }
}

const MODEL_MIB = Number(process.env.LOXAIC_FAKE_MODEL_MIB ?? 0);
const VRAM_STATE = process.env.LOXAIC_FAKE_VRAM_STATE;
const DEVICES =
  fakeHardware() === "none" ? "" : (process.env.LOXAIC_FAKE_DEVICES ?? "FAKE0: Fake GPU (24576 MiB, 24000 MiB free)");

/** The first device's free MiB before anything is loaded. */
function baseFreeMib() {
  const m = /(\d+)\s*MiB free/.exec(DEVICES.split(";")[0] ?? "");
  return m ? Number(m[1]) : 0;
}

function heldMib() {
  if (!VRAM_STATE) return 0;
  try {
    return Number(JSON.parse(readFileSync(VRAM_STATE, "utf8")).heldMib) || 0;
  } catch {
    return 0;
  }
}

if (args.includes("--list-devices")) {
  const held = heldMib();
  console.log("Available devices:");
  DEVICES.split(";")
    .filter(Boolean)
    .forEach((d, i) => {
      const line = i === 0 && held > 0 ? d.replace(/(\d+)\s*MiB free/, (_, n) => `${String(Math.max(0, Number(n) - held))} MiB free`) : d;
      console.log(`  ${line}`);
    });
  process.exit(0);
}
if (args.includes("--version")) {
  console.log("version: fake");
  process.exit(0);
}

function arg(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

const port = Number(arg("--port") ?? 0);
const presetFile = arg("--models-preset");
const apiKey = process.env.LLAMA_API_KEY ?? "";

/**
 * The id the real router serves a section under. b11149 reads a section name
 * with a ":" as a HuggingFace `repo:quant` reference and rewrites the part after
 * the last ":" — uppercased, a leading "UD-" dropped — so `[a/b:UD-Q5_K_XL]` is
 * served as `a/b:Q5_K_XL` and a request for the name as written is "not found".
 * Measured by listing a preset of such names against the real binary; a name
 * with no ":" is served exactly as written. Imitated here because a fake that
 * kept every name was how a downloaded Unsloth model shipped unusable.
 */
function routerId(name) {
  const i = name.lastIndexOf(":");
  if (i < 0) return name;
  return name.slice(0, i + 1) + name.slice(i + 1).toUpperCase().replace(/^UD-/, "");
}

/**
 * The preset keys this fake accepts — every key the server writes, and nothing
 * else. The real router refuses an unknown key (`option 'mlock' not recognized
 * in preset`: fatal at boot, a 500 on reload), and a fake that accepted
 * anything would let a misspelt key pass every e2e run. The YaRN keys were
 * confirmed against b11149 before they were added here.
 */
const PRESET_KEYS = new Set([
  "version", "model", "mmproj", "jinja", "device",
  "ctx-size", "rope-freq-base", "rope-freq-scale", "n-gpu-layers", "n-cpu-moe", "kv-offload", "load-mode",
  "threads", "threads-batch", "batch-size", "ubatch-size", "flash-attn", "cache-type-k", "cache-type-v",
  "parallel", "kv-unified", "temp", "top-k", "top-p", "min-p", "repeat-penalty", "presence-penalty",
  "frequency-penalty", "seed",
  "rope-scaling", "rope-scale", "yarn-orig-ctx", "yarn-ext-factor", "yarn-attn-factor", "yarn-beta-slow", "yarn-beta-fast",
]);

/** Parse the INI into { globals, sections: Map<id, Record<string,string>> }. */
function readPreset() {
  const sections = new Map();
  const globals = {};
  if (!presetFile) return { globals, sections };
  let current = null;
  for (const raw of readFileSync(presetFile, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith(";")) continue;
    const header = /^\[(.+)\]$/.exec(line);
    if (header) {
      current = header[1] === "*" ? globals : {};
      if (header[1] !== "*") sections.set(routerId(header[1]), current);
      continue;
    }
    const kv = /^([^=]+?)\s*=\s*(.*)$/.exec(line);
    if (kv && !PRESET_KEYS.has(kv[1])) throw new Error(`option '${kv[1]}' not recognized in preset`);
    if (kv && current) current[kv[1]] = kv[2];
  }
  return { globals, sections };
}

let preset;
try {
  preset = readPreset();
} catch (err) {
  // As the real router: an unrecognised key is fatal at boot.
  process.stderr.write(`E srv  llama_server: failed to initialize router models: ${err.message}\n`);
  process.exit(1);
}
/** id -> "unloaded" | "loaded" */
const status = new Map();
/** Ids whose last load failed. */
const failed = new Set();
/** id -> last use, for --models-max. */
const lastUse = new Map();
let loadedArgs = new Map();
const modelsMax = Number(arg("--models-max") ?? 0);

function merged(id) {
  return { ...preset.globals, ...(preset.sections.get(id) ?? {}) };
}

function logEvent(entry) {
  if (process.env.LOXAIC_FAKE_ROUTER_LOG) appendFileSync(process.env.LOXAIC_FAKE_ROUTER_LOG, JSON.stringify(entry) + "\n");
}

function loadedIds() {
  return [...status].filter(([, v]) => v === "loaded").map(([id]) => id);
}

function writeVram() {
  if (VRAM_STATE) writeFileSync(VRAM_STATE, JSON.stringify({ heldMib: loadedIds().length * MODEL_MIB }));
}

function unload(id) {
  if (status.get(id) !== "loaded") return;
  status.set(id, "unloaded");
  loadedArgs.delete(id);
  logEvent({ event: "unload", model: id });
  writeVram();
}

function load(id) {
  if (!preset.sections.has(id)) return false;
  lastUse.set(id, Date.now());
  if (status.get(id) === "loaded") return true;
  if (modelsMax > 0) {
    const others = loadedIds().sort((a, b) => (lastUse.get(a) ?? 0) - (lastUse.get(b) ?? 0));
    while (others.length >= modelsMax) unload(others.shift());
  }
  if (MODEL_MIB > 0 && (loadedIds().length + 1) * MODEL_MIB > baseFreeMib()) {
    failed.add(id);
    logEvent({ event: "load-failed", model: id });
    return "oom";
  }
  failed.delete(id);
  status.set(id, "loaded");
  loadedArgs.set(id, JSON.stringify(merged(id)));
  logEvent({ event: "load", model: id, section: merged(id) });
  writeVram();
  return true;
}

function reload() {
  // An unrecognised key on a live reload keeps the old list (the caller answers 500).
  const next = readPreset();
  for (const [id] of status) {
    const now = next.sections.get(id);
    const was = loadedArgs.get(id);
    if (!now) {
      status.delete(id);
      loadedArgs.delete(id);
    } else if (was && JSON.stringify({ ...next.globals, ...now }) !== was) {
      status.set(id, "unloaded");
      loadedArgs.delete(id);
    }
  }
  preset = next;
  writeVram();
}

function json(res, code, body) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      try {
        resolve(JSON.parse(data || "{}"));
      } catch {
        resolve({});
      }
    });
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  if (url.pathname === "/health") return json(res, 200, { status: "ok" });
  if (apiKey && req.headers.authorization !== `Bearer ${apiKey}`) {
    return json(res, 401, { error: { code: 401, message: "Invalid API Key", type: "authentication_error" } });
  }
  if (url.pathname === "/models" && req.method === "GET") {
    if (url.searchParams.get("reload") === "1") {
      try {
        reload();
      } catch (err) {
        return json(res, 500, { error: { message: err.message } });
      }
    }
    return json(res, 200, {
      data: [...preset.sections.keys()].map((id) => ({
        id,
        status: { value: status.get(id) ?? "unloaded", ...(failed.has(id) ? { failed: true } : {}) },
      })),
    });
  }
  if (url.pathname === "/models/load" && req.method === "POST") {
    const body = await readBody(req);
    // A load that takes a moment, as a real one does (LOXAIC_FAKE_LOAD_MS), so
    // a context-stage switch can be watched reloading. The model reads as
    // `loading` meanwhile, and an unload during it wins.
    const loadMs = Number(process.env.LOXAIC_FAKE_LOAD_MS ?? 0);
    if (loadMs > 0 && preset.sections.has(body.model) && status.get(body.model) !== "loaded") {
      status.set(body.model, "loading");
      await new Promise((r) => setTimeout(r, loadMs));
      if (status.get(body.model) !== "loading") return json(res, 200, { success: true });
      status.set(body.model, "unloaded");
    }
    const ok = load(body.model);
    if (ok === "oom") return json(res, 500, { error: { message: "failed to load model: out of device memory" } });
    return ok ? json(res, 200, { success: true }) : json(res, 400, { error: { message: "model not found" } });
  }
  if (url.pathname === "/models/unload" && req.method === "POST") {
    const body = await readBody(req);
    unload(body.model);
    return json(res, 200, { success: true });
  }
  if (url.pathname === "/props") {
    const id = url.searchParams.get("model");
    if (!id) return json(res, 400, { error: { message: "model name is missing from the request" } });
    if (status.get(id) !== "loaded") return json(res, 400, { error: { message: "model is not loaded" } });
    const s = merged(id);
    const slots = Number(s.parallel ?? 1);
    const ctx = Number(s["ctx-size"] ?? 4096);
    const unified = s["kv-unified"] === "true" || s.parallel === undefined;
    return json(res, 200, { total_slots: slots, default_generation_settings: { n_ctx: unified ? ctx : Math.floor(ctx / slots) } });
  }
  if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
    const body = await readBody(req);
    const ok = load(body.model);
    if (ok === "oom") return json(res, 500, { error: { code: 500, message: "failed to load model: out of device memory" } });
    if (!ok) return json(res, 400, { error: { code: 400, message: `model '${body.model}' not found` } });
    res.writeHead(200, { "content-type": "text/event-stream" });
    const words = ["Hello", " from", ` ${body.model}`];
    // "take your time" makes the reply slow (1.5 s a word; "take your time
    // 6000" is 6 s a word), so a test can hold a run on the model while
    // something else asks for it — a context-stage switch waits for exactly
    // this. A client that goes away ends it.
    const lastUser = [...(body.messages ?? [])].reverse().find((m) => m.role === "user");
    const slowMatch = /take your time(?: (\d+))?/i.exec(typeof lastUser?.content === "string" ? lastUser.content : JSON.stringify(lastUser?.content ?? ""));
    const perWordMs = slowMatch ? Number(slowMatch[1] ?? 1500) : 0;
    let gone = false;
    res.on("close", () => { gone = true; });
    // llama.cpp's `return_progress`: a report as the slot starts, then one per
    // batch, each on a content-less chunk of this same stream. A warm-up after
    // a context-stage switch (`max_tokens: 1`) evaluates slowly, as re-reading
    // a whole conversation does, so the pill's percentage can be watched.
    if (body.return_progress === true) {
      const total = promptSize(body);
      const steps = 5;
      const stepMs = body.max_tokens === 1 ? 700 : 0;
      for (let i = 0; i <= steps; i++) {
        if (i > 0 && stepMs > 0) await new Promise((r) => setTimeout(r, stepMs));
        if (gone) return;
        const processed = Math.round((total * i) / steps);
        res.write(
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", content: null }, finish_reason: null }], prompt_progress: { total, cache: 0, processed, time_ms: i * stepMs } })}\n\n`,
        );
      }
    }
    for (const w of words) {
      if (perWordMs > 0) await new Promise((r) => setTimeout(r, perWordMs));
      if (gone) return;
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: w }, finish_reason: null }] })}\n\n`);
    }
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
    // A prompt that says so reports itself as nearly filling the model's
    // context, so an e2e run can cross the 75% and 85% thresholds without
    // sending 200k real tokens: "fill the context" is 80% of `ctx-size`,
    // "overflow the context" 90%. Read from what the model was loaded with, so
    // it follows the model's context stage.
    const promptTokens = promptSize(body);
    res.write(
      `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: promptTokens, completion_tokens: 3, total_tokens: promptTokens + 3 } })}\n\n`,
    );
    res.end("data: [DONE]\n\n");
    return;
  }
  json(res, 404, { error: { message: "not found" } });
});

/** What a request's prompt "costs": "fill the context" in the last user
 * message is 80% of the window the model was loaded with, "overflow the
 * context" 90%, anything else 10 tokens. */
function promptSize(body) {
  const last = [...(body.messages ?? [])].reverse().find((m) => m.role === "user");
  const said = typeof last?.content === "string" ? last.content : JSON.stringify(last?.content ?? "");
  const fill = /overflow the context/i.test(said) ? 0.9 : /fill the context/i.test(said) ? 0.8 : 0;
  return fill > 0 ? Math.round(Number(merged(body.model)["ctx-size"] ?? 4096) * fill) : 10;
}

writeVram();
server.listen(port, "127.0.0.1", () => {
  console.error(`0.00.000.001 I srv  llama_server: listening on http://127.0.0.1:${port}`);
});
process.on("SIGTERM", () => server.close(() => process.exit(0)));
