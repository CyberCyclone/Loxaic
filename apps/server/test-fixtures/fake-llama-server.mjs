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
// With LOXAIC_FAKE_ROUTER_LOG set, every load appends the section it loaded
// with as a JSON line, which is how a test proves settings reached the model.
import { appendFileSync, readFileSync } from "node:fs";
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

if (args.includes("--list-devices")) {
  const devices =
    fakeHardware() === "none" ? "" : (process.env.LOXAIC_FAKE_DEVICES ?? "FAKE0: Fake GPU (24576 MiB, 24000 MiB free)");
  console.log("Available devices:");
  for (const d of devices.split(";").filter(Boolean)) console.log(`  ${d}`);
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
    if (kv && current) current[kv[1]] = kv[2];
  }
  return { globals, sections };
}

let preset = readPreset();
/** id -> "unloaded" | "loaded" */
const status = new Map();
let loadedArgs = new Map();

function merged(id) {
  return { ...preset.globals, ...(preset.sections.get(id) ?? {}) };
}

function load(id) {
  if (!preset.sections.has(id)) return false;
  if (status.get(id) === "loaded") return true;
  status.set(id, "loaded");
  loadedArgs.set(id, JSON.stringify(merged(id)));
  if (process.env.LOXAIC_FAKE_ROUTER_LOG) {
    appendFileSync(process.env.LOXAIC_FAKE_ROUTER_LOG, JSON.stringify({ event: "load", model: id, section: merged(id) }) + "\n");
  }
  return true;
}

function reload() {
  const next = readPreset();
  for (const [id] of status) {
    const now = next.sections.get(id);
    const was = loadedArgs.get(id);
    if (!now) status.delete(id);
    else if (was && JSON.stringify({ ...next.globals, ...now }) !== was) {
      status.set(id, "unloaded");
      loadedArgs.delete(id);
    }
  }
  preset = next;
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
    if (url.searchParams.get("reload") === "1") reload();
    return json(res, 200, {
      data: [...preset.sections.keys()].map((id) => ({ id, status: { value: status.get(id) ?? "unloaded" } })),
    });
  }
  if (url.pathname === "/models/load" && req.method === "POST") {
    const body = await readBody(req);
    return load(body.model) ? json(res, 200, { success: true }) : json(res, 400, { error: { message: "model not found" } });
  }
  if (url.pathname === "/models/unload" && req.method === "POST") {
    const body = await readBody(req);
    status.set(body.model, "unloaded");
    loadedArgs.delete(body.model);
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
    if (!load(body.model)) return json(res, 400, { error: { code: 400, message: `model '${body.model}' not found` } });
    res.writeHead(200, { "content-type": "text/event-stream" });
    const words = ["Hello", " from", ` ${body.model}`];
    for (const w of words) {
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: w }, finish_reason: null }] })}\n\n`);
    }
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
    res.write(
      `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } })}\n\n`,
    );
    res.end("data: [DONE]\n\n");
    return;
  }
  json(res, 404, { error: { message: "not found" } });
});

server.listen(port, "127.0.0.1", () => {
  console.error(`0.00.000.001 I srv  llama_server: listening on http://127.0.0.1:${port}`);
});
process.on("SIGTERM", () => server.close(() => process.exit(0)));
