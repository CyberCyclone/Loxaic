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
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
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
  // `LOXAIC_FAKE_VERSION`: what a mock *release* of this fake says it is, set
  // by the wrapper script inside the mock archive (the server builds the
  // child's environment from scratch, so it cannot come from there). The real
  // binary prints this line to stderr.
  console.error(`version: ${process.env.LOXAIC_FAKE_VERSION ?? "fake"}`);
  process.exit(0);
}

/**
 * Options beyond the keys Loxaic writes, which an admin may add as extra
 * options (extra-options.ts): `keep` takes a number (and a value that is not
 * one fails the model's load, as b11342's does), the rest are switches. `port`,
 * `host` and `log-file` are listed so the server's refusal of them is exercised
 * through `--help`, as on the real build; they are never accepted in a preset.
 * `LOXAIC_FAKE_HELP_OMIT` names one this fake then neither lists nor accepts:
 * an older release, in the mock release server.
 */
const EXTRA_OPTIONS = [
  ["--keep N", "number of tokens to keep from the initial prompt (default: 0, -1 = all)"],
  ["--metrics", "enable prometheus compatible metrics endpoint (default: disabled)"],
  ["-cb,   --cont-batching, -nocb, --no-cont-batching", "whether to enable continuous batching (a.k.a dynamic batching) (default: enabled)"],
];
const OMITTED = process.env.LOXAIC_FAKE_HELP_OMIT ?? "";
const EXTRA_KEYS = new Set(
  EXTRA_OPTIONS.flatMap(([head]) => head.split(/,\s+/).map((n) => n.split(" ")[0].replace(/^-+/, ""))).filter((k) => k !== OMITTED),
);
/** Keys Loxaic writes that are switches, for the help text's layout. */
const SWITCHES = new Set(["jinja", "kv-offload", "kv-unified"]);

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
  // Multi-token prediction, confirmed against b11342 (a Qwen3.5-0.8B with
  // its own head drafted and reported `draft_n`/`draft_n_accepted`).
  "spec-type", "spec-draft-model", "spec-draft-n-max",
  // Where a model's memory goes (placement.ts), confirmed against b11342 on
  // Metal and on Pheonix's V620s.
  "log-verbosity", "lazy-mode",
]);

if (args.includes("--help")) {
  // llama.cpp's layout: names at column 0, the description at column 40 (or
  // on the next line when the names are longer), continuation lines indented.
  const out = ["----- common params -----", ""];
  const line = (head, text) => {
    if (head.length < 39) out.push(`${head.padEnd(40)}${text}`);
    else out.push(head, `${" ".repeat(40)}${text}`);
  };
  for (const key of PRESET_KEYS) {
    if (key === "version") continue;
    line(SWITCHES.has(key) ? `--${key}, --no-${key}` : `--${key} VALUE`, `the fake's ${key}`);
  }
  for (const [head, text] of EXTRA_OPTIONS) if (!head.includes(`--${OMITTED} `) && !head.endsWith(`--${OMITTED}`)) line(head, text);
  line("--host HOST", "ip address to listen, or bind to an UNIX socket");
  line("--port PORT", "port to listen (default: 8080)");
  line("--log-file FNAME", "Log to file");
  console.log(out.join("\n"));
  process.exit(0);
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
    // `LOXAIC_FAKE_REJECT_KEY` makes this fake a build that does not know one
    // of the keys Loxaic writes — how an older release or a fork really
    // fails: fatally, at boot, naming the key.
    if (kv && ((!PRESET_KEYS.has(kv[1]) && !EXTRA_KEYS.has(kv[1])) || kv[1] === process.env.LOXAIC_FAKE_REJECT_KEY)) {
      throw new Error(`option '${kv[1]}' not recognized in preset`);
    }
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
/** Loads so far, for each one's own child port. */
let spawnCount = 0;
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
  // As the real router, which the placement tracker reads.
  process.stderr.write(`0.00.000.300 I srv        unload: stopping model instance name=${id}\n`);
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
  // As the real router: each load is a child on its own port, announced on
  // the router's output, with the child's lines forwarded as `[    P] line`.
  const childPort = 40000 + (spawnCount++ % 20000);
  process.stderr.write(`0.00.000.100 I srv    operator(): spawning server instance with name=${id} on port ${childPort}\n`);
  // As the real child: an unknown speculative type, or a draft file that is
  // not there, fails the load (not the router). A model file named "Crashy"
  // loaded with MTP dies the way llama.cpp b11342 dies loading
  // Qwen3.8-Flash-Next with unsloth's head (ggml-org/llama.cpp#29811).
  const spec = merged(id);
  const crashes = spec["spec-type"] === "draft-mtp" && /crashy/i.test(spec.model ?? "");
  // As b11342's child: an option's value is read when the model loads, not
  // when the router reads the preset, so a bad one fails this load only.
  if (spec.keep !== undefined && !/^-?\d+$/.test(spec.keep)) {
    const p = String(childPort).padStart(5, " ");
    process.stderr.write(
      [
        `[${p}] error while handling argument "--keep": stoi: no conversion`,
        `[${p}] --keep N                                number of tokens to keep from the initial prompt (default: 0, -1 =`,
        `0.00.000.200 I srv    operator(): instance name=${id} exited with status 1`,
      ].join("\n") + "\n",
    );
    failed.add(id);
    logEvent({ event: "load-failed", model: id, reason: "argument" });
    return "failed";
  }
  const badSpec =
    (spec["spec-type"] !== undefined && spec["spec-type"] !== "draft-mtp") ||
    (spec["spec-draft-model"] !== undefined && !existsSync(spec["spec-draft-model"])) ||
    crashes;
  if (badSpec) {
    const p = String(childPort).padStart(5, " ");
    if (crashes) {
      process.stderr.write(
        [
          `[${p}] 0.33.703.461 I spec common_specu: adding speculative implementation 'draft-mtp'`,
          `[${p}] /home/runner/work/llama.cpp/llama.cpp/ggml/src/ggml-backend.cpp:205: GGML_ASSERT(buffer) failed`,
          `[${p}] #5  0x00007bed0de6f0e2 in ggml_abort () from /opt/llama/libggml-base.so.0`,
          `[${p}] #8  0x00007bed0c84367e in llama_kv_cache::set_input_k_idxs(ggml_tensor*, llama_ubatch const*) const ()`,
          `0.00.000.200 I srv    operator(): instance name=${id} exited with status 134`,
        ].join("\n") + "\n",
      );
    }
    failed.add(id);
    logEvent({ event: "load-failed", model: id, reason: "speculative" });
    return "failed";
  }
  if (MODEL_MIB > 0 && (loadedIds().length + 1) * MODEL_MIB > baseFreeMib()) {
    failed.add(id);
    logEvent({ event: "load-failed", model: id });
    return "oom";
  }
  failed.delete(id);
  if (Number(spec["log-verbosity"] ?? 3) >= 4) process.stderr.write(allocationLines(spec, childPort));
  status.set(id, "loaded");
  loadedArgs.set(id, JSON.stringify(merged(id)));
  logEvent({ event: "load", model: id, section: merged(id) });
  writeVram();
  return true;
}

/**
 * The allocation lines a real child prints at verbosity 4, in the real
 * format (placement.ts), for the devices the preset names. A model file named
 * "Table" carries a per-layer lookup table of TABLE_MIB, read from the file on
 * demand unless `lazy-mode = off` (copied into RAM with `load-mode = none`).
 * A file named "Splitty" left on automatic GPU layers splits its graph 17
 * ways, as llama.cpp's --fit did to Qwen3.8-Flash-Next on Pheonix (#263).
 */
const TABLE_MIB = 2;
function allocationLines(spec, port) {
  const p = `[${String(port).padStart(5, " ")}] 0.01.085.178 I`;
  const devices = (spec.device ?? "FAKE0").split(",").filter((d) => d && d !== "none");
  const file = spec.model ?? "";
  const weightsMib = Math.max(MODEL_MIB, 300);
  const out = [`${p} load_tensors: offloaded 23/23 layers to GPU`, `${p} load_tensors:   CPU_Mapped model buffer size =    12.00 MiB`];
  for (const d of devices) out.push(`${p} load_tensors: ${d.padStart(12, " ")} model buffer size = ${(weightsMib / devices.length).toFixed(2)} MiB`);
  if (/table/i.test(file)) {
    const lazy = spec["lazy-mode"] !== "off";
    if (lazy) {
      out.splice(1, 0, `${p} add: tensor per_layer_token_embd.weight (size = ${String(TABLE_MIB)} MiB) lazy read enabled`);
      out.push(`${p} load_tensors:   CPU_Mapped model buffer size = ${TABLE_MIB.toFixed(2)} MiB`);
    } else {
      const buffer = spec["load-mode"] === "none" ? "CPU" : "CPU_Mapped";
      out.push(`${p} load_tensors: ${buffer.padStart(12, " ")} model buffer size = ${TABLE_MIB.toFixed(2)} MiB`);
    }
  }
  for (const d of devices) out.push(`${p} llama_kv_cache: ${d.padStart(10, " ")} KV buffer size =    16.00 MiB`);
  for (const d of devices) out.push(`${p} sched_reserve: ${d.padStart(10, " ")} compute buffer size =    40.00 MiB`);
  out.push(`${p} sched_reserve: Vulkan_Host compute buffer size =     4.00 MiB`);
  const splits = /splitty/i.test(file) && (spec["n-gpu-layers"] ?? "auto") === "auto" ? 17 : devices.length + 1;
  out.push(`${p} sched_reserve: graph: nodes = 1863, splits = ${String(splits)}, input objects = 5, input tensors = 10`);
  return out.join("\n") + "\n";
}

function reload() {
  // An unrecognised key on a live reload keeps the old list (the caller answers 500).
  // `LOXAIC_FAKE_RELOAD_FAIL` names a file whose presence refuses every reload
  // that way, read on each one, so a test can make the router refuse at will.
  const failFile = process.env.LOXAIC_FAKE_RELOAD_FAIL;
  if (failFile && existsSync(failFile)) throw new Error("option 'not-a-key' not recognized in preset");
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
      process.stderr.write(`0.00.000.300 I srv        unload: stopping model instance name=${id}\n`);
      logEvent({ event: "unload", model: id, reason: "reload" });
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
    // The real router's words, which name nothing: the reason is in the log.
    if (ok === "failed") return json(res, 500, { error: { code: 500, message: `model name=${body.model} failed to load` } });
    if (!ok) return json(res, 400, { error: { code: 400, message: `model '${body.model}' not found` } });
    // What the thinking level became on the wire, so a test can tell the level
    // picked in the composer reached the backend, in llama.cpp's own fields.
    logEvent({
      event: "chat",
      model: body.model,
      reasoning_effort: body.reasoning_effort ?? null,
      chat_template_kwargs: body.chat_template_kwargs ?? null,
      // What the request reported costing, and how it ended, so a test can see
      // every request a run made and how full each one was.
      prompt_tokens: promptSize(body),
      ctx_size: Number(merged(body.model)["ctx-size"] ?? 4096),
      last_role: (body.messages ?? []).at(-1)?.role ?? null,
      // The start of what the model was asked, so a test can tell the
      // person's own message from a nudge written in its place.
      last_user: said([...(body.messages ?? [])].reverse().find((m) => m.role === "user")).slice(0, 200),
    });
    // "overflow the provider": refused as longer than the slot, in b11342's
    // own words and shape (read from its server library), so the run's
    // classifier is tested against what the real router sends (#166).
    if (/overflow the provider/i.test(said([...(body.messages ?? [])].reverse().find((m) => m.role === "user")))) {
      const nCtx = Number(merged(body.model)["ctx-size"] ?? 4096);
      return json(res, 400, {
        error: {
          code: 400,
          message: `request (${String(nCtx + 904)} tokens) exceeds the available context size (${String(nCtx)} tokens), try increasing it`,
          type: "exceed_context_size_error",
          n_prompt_tokens: nCtx + 904,
          n_ctx: nCtx,
        },
      });
    }
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
    // A request that ends on the assistant's message is a prefill to
    // llama.cpp, which echoes that text back as content before evaluating
    // anything — as a stage switch's re-read of the conversation does.
    const lastMessage = (body.messages ?? []).at(-1);
    if (lastMessage?.role === "assistant" && typeof lastMessage.content === "string" && lastMessage.content) {
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: lastMessage.content }, finish_reason: null }] })}\n\n`);
    }
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
    // "work in steps": the turn's first request calls `todo_write` once, as
    // a model working through a task does, and the request after its result
    // answers — the in-process mock's one-call-per-turn rule. What gives a run
    // on this backend a second request, which is where a conversation that
    // filled up in the middle of a turn has to be extended or compacted.
    const messages = body.messages ?? [];
    const lastUserIndex = messages.map((m) => m.role).lastIndexOf("user");
    const toolRanThisTurn = messages.slice(lastUserIndex + 1).some((m) => m.role === "tool");
    const offersTodo = (body.tools ?? []).some((t) => t.function?.name === "todo_write");
    if (/work in steps/i.test(said(lastUser)) && offersTodo && !toolRanThisTurn && body.tool_choice !== "none") {
      const call = { index: 0, id: `call_${String(Date.now())}`, type: "function", function: { name: "todo_write", arguments: JSON.stringify({ todos: [{ id: "1", text: "step", status: "in_progress" }] }) } };
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", content: null, tool_calls: [call] }, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\n`);
    } else {
      for (const w of words) {
        if (perWordMs > 0) await new Promise((r) => setTimeout(r, perWordMs));
        if (gone) return;
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: w }, finish_reason: null }] })}\n\n`);
      }
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
    }
    // A prompt that says so reports itself as nearly filling the model's
    // context, so an e2e run can cross the 75% and 85% thresholds without
    // sending 200k real tokens: "fill the context" is 80% of `ctx-size`,
    // "overflow the context" 90%. Read from what the model was loaded with, so
    // it follows the model's context stage.
    const promptTokens = promptSize(body);
    // A model loaded with an MTP head reports what it drafted, as llama.cpp
    // does on its last chunk: 30 drafted, 20 accepted (66%).
    const speculating = merged(body.model)["spec-type"] === "draft-mtp";
    const timings = speculating
      ? {
          prompt_n: promptTokens, prompt_ms: 50.5, prompt_per_token_ms: 5.05, prompt_per_second: 198.02,
          predicted_n: 3, predicted_ms: 30.25, predicted_per_token_ms: 10.08, predicted_per_second: 99.17,
          cache_n: 0, draft_n: 30, draft_n_accepted: 20,
        }
      : undefined;
    res.write(
      `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: promptTokens, completion_tokens: 3, total_tokens: promptTokens + 3 }, ...(timings ? { timings } : {}) })}\n\n`,
    );
    res.end("data: [DONE]\n\n");
    return;
  }
  json(res, 404, { error: { message: "not found" } });
});

/** A message's text, whatever shape its content is in. */
function said(message) {
  return typeof message?.content === "string" ? message.content : JSON.stringify(message?.content ?? "");
}

/** What a request's prompt "costs": "fill the context" in the last user
 * message is 80% of the window the model was loaded with, "overflow the
 * context" 90%, "exceed the context" 99%, anything else 10 tokens. A
 * compaction in the middle of a run replaces that message with its nudge, so
 * the prompt after it is small again — as a real summary makes it. */
function promptSize(body) {
  const text = said([...(body.messages ?? [])].reverse().find((m) => m.role === "user"));
  const fill = /exceed the context/i.test(text) ? 0.99 : /overflow the context/i.test(text) ? 0.9 : /fill the context/i.test(text) ? 0.8 : 0;
  return fill > 0 ? Math.round(Number(merged(body.model)["ctx-size"] ?? 4096) * fill) : 10;
}

writeVram();
server.listen(port, "127.0.0.1", () => {
  console.error(`0.00.000.001 I srv  llama_server: listening on http://127.0.0.1:${port}`);
});
process.on("SIGTERM", () => server.close(() => process.exit(0)));
