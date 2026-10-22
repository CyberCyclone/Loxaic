import { describe, expect, it } from "vitest";
import {
  CACHE_NEUTRAL_KEYS,
  SAVED_TTL_MS,
  cacheIdentity,
  estimatedBytes,
  fdinfoPos,
  liveEntries,
  matchSlots,
  parseManifest,
  promptCacheState,
  type CacheStateInput,
  type SavedEntry,
  type SlotView,
} from "../slot-cache.ts";

const SECTION = [
  "[unsloth/Model@Q4_K_M]",
  "model = /m/a.gguf",
  "ctx-size = 262144",
  "cache-type-k = q8_0",
  "cache-type-v = q8_0",
  "temp = 0.6",
  "spec-type = draft-mtp",
  "spec-draft-n-max = 2",
];
const base = { section: SECTION, globalLines: [] as string[], build: "b11457-vulkan:abc", stage: 0 };
const id = (over: Partial<typeof base>) => cacheIdentity({ ...base, ...over });
const withLine = (key: string, value: string) => [...SECTION.filter((l) => !l.startsWith(`${key} =`)), `${key} = ${value}`];

describe("cacheIdentity", () => {
  it("is blind to every cache-neutral key, and to line order", () => {
    for (const key of CACHE_NEUTRAL_KEYS) expect(id({ section: withLine(key, "999") }), key).toBe(id({}));
    expect(id({ section: [...SECTION].reverse() })).toBe(id({}));
    // The admin's global options too, when neutral.
    expect(id({ globalLines: ["cache-ram = 32768"] })).toBe(id({}));
  });

  it("changes with what the cached keys and values were computed under", () => {
    const changed: [string, Partial<typeof base>][] = [
      ["a YaRN stage", { stage: 1 }],
      ["rope-scale", { section: withLine("rope-scale", "2") }],
      ["rope-scaling", { section: withLine("rope-scaling", "yarn") }],
      ["yarn-orig-ctx", { section: withLine("yarn-orig-ctx", "131072") }],
      ["rope-freq-base", { section: withLine("rope-freq-base", "1000000") }],
      ["the cache type", { section: withLine("cache-type-k", "f16") }],
      ["flash attention", { section: withLine("flash-attn", "off") }],
      ["the weights", { section: withLine("model", "/m/b.gguf") }],
      ["a projector", { section: withLine("mmproj", "/m/p.gguf") }],
      ["MTP on or off", { section: SECTION.filter((l) => !l.startsWith("spec-type")) }],
      ["the build", { build: "b11500-vulkan:def" }],
      ["an extra option nobody vetted", { section: [...SECTION, "override-kv = x=int:1"] }],
      ["a global extra option nobody vetted", { globalLines: ["override-kv = x=int:1"] }],
    ];
    for (const [what, over] of changed) expect(id(over), what).not.toBe(id({}));
  });

  it("lets a model's own key beat the same key in [*]", () => {
    expect(id({ globalLines: ["cache-type-k = f16"] })).toBe(id({}));
  });
});

describe("matchSlots", () => {
  const slot = (over: Partial<SlotView>): SlotView => ({ id: 0, tokens: 12, busy: false, text: null, ...over });
  const use = (conversationId: string, tokens: number) => ({ conversationId, tokens, at: 1 });

  it("matches a slot to the conversation whose turn left it at that count", () => {
    // llama.cpp keeps every token but the last one generated.
    expect(matchSlots([slot({ tokens: 4661 })], [use("a", 4662), use("b", 9000)])).toEqual(new Map([[0, "a"]]));
  });

  it("tells two same-sized turns apart by the last user message in the slot's prompt", () => {
    const slots = [slot({ id: 0, text: "<|user|>tell me about otters" }), slot({ id: 1, text: "<|user|>and beavers?" })];
    const users = new Map([["a", "and beavers?"], ["b", "tell me about otters"]]);
    expect(matchSlots(slots, [use("a", 13), use("b", 13)], users)).toEqual(new Map([[0, "b"], [1, "a"]]));
  });

  it("leaves out a slot nothing explains, one still ambiguous, a busy one and an empty one", () => {
    expect(matchSlots([slot({ tokens: 500 })], [use("a", 13)]).size).toBe(0);
    expect(matchSlots([slot({ text: "hi" })], [use("a", 13), use("b", 13)], new Map([["a", "hi"], ["b", "hi"]])).size).toBe(0);
    expect(matchSlots([slot({ busy: true })], [use("a", 13)]).size).toBe(0);
    expect(matchSlots([slot({ tokens: null })], [use("a", 13)]).size).toBe(0);
  });

  it("matches a conversation once", () => {
    expect(matchSlots([slot({ id: 0 }), slot({ id: 1 })], [use("a", 13)])).toEqual(new Map([[0, "a"]]));
  });
});

describe("parseManifest", () => {
  const entry: SavedEntry = { conversationId: "c", file: "k-c.bin", tokens: 1, bytes: 2, saveMs: 3, savedAt: 4 };
  it("reads its own format and refuses anything else", () => {
    expect(parseManifest(JSON.stringify({ version: 1, model: "m", identity: "i", entries: [entry] }))?.entries).toEqual([entry]);
    expect(parseManifest("nope")).toBeNull();
    expect(parseManifest(JSON.stringify({ version: 2, model: "m", identity: "i", entries: [] }))).toBeNull();
  });

  it("drops an entry whose file name could reach outside the slot directory", () => {
    for (const file of ["../x.bin", "a/b.bin", "", "x y.bin"]) {
      expect(parseManifest(JSON.stringify({ version: 1, model: "m", identity: "i", entries: [{ ...entry, file }] }))?.entries, file).toEqual([]);
    }
  });
});

describe("liveEntries", () => {
  const entry = (conversationId: string, savedAt: number): SavedEntry => ({ conversationId, file: "f", tokens: 1, bytes: 1, saveMs: 1, savedAt });
  it("keeps entries inside the TTL for conversations that still exist", () => {
    const now = 10 * SAVED_TTL_MS;
    const kept = liveEntries([entry("a", now - 1000), entry("b", now - SAVED_TTL_MS - 1), entry("gone", now)], now, (c) => c !== "gone");
    expect(kept.map((e) => e.conversationId)).toEqual(["a"]);
  });
});

describe("restore progress", () => {
  it("reads the position out of an fdinfo text", () => {
    expect(fdinfoPos("pos:\t1048576\nflags:\t0100000\nmnt_id:\t29\n")).toBe(1048576);
    expect(fdinfoPos("flags:\t0100000\n")).toBeNull();
  });

  it("estimates from the save's time and never claims to be done", () => {
    expect(estimatedBytes(1000, 2000, 1000)).toBe(500);
    expect(estimatedBytes(1000, 2000, 10_000)).toBe(950);
    expect(estimatedBytes(0, 2000, 1000)).toBe(0);
  });
});

describe("promptCacheState", () => {
  const input = (over: Partial<CacheStateInput>): CacheStateInput => ({
    lastTurn: { model: "m", tokens: 200_000, at: 5000 },
    model: "m",
    hostModel: true,
    saved: null,
    lastReload: null,
    bootAt: 1000,
    prefillRate: 400,
    ...over,
  });

  it("says nothing for another model, a provider's model, or a conversation with no turn", () => {
    expect(promptCacheState(input({ model: "other" }))).toEqual({ state: "none" });
    expect(promptCacheState(input({ hostModel: false }))).toEqual({ state: "none" });
    expect(promptCacheState(input({ lastTurn: null }))).toEqual({ state: "none" });
  });

  it("claims nothing while the process that read it is still up", () => {
    expect(promptCacheState(input({ lastReload: { at: 4000, reason: "settings" } }))).toEqual({ state: "warm" });
  });

  it("is lost after a reload since the last turn, with why and how long the re-read takes", () => {
    expect(promptCacheState(input({ lastReload: { at: 6000, reason: "context_stage" } }))).toEqual({
      state: "lost",
      reason: "context_stage",
      tokens: 200_000,
      reread_seconds: 500,
    });
    expect(promptCacheState(input({ lastReload: { at: 6000, reason: "unload" }, prefillRate: null }))).toMatchObject({ reread_seconds: null });
  });

  it("is lost when the last turn ran before this server started", () => {
    expect(promptCacheState(input({ bootAt: 9000 }))).toMatchObject({ state: "lost", reason: "restart" });
  });

  it("is saved when a matching save exists, whatever reloaded since", () => {
    expect(promptCacheState(input({ saved: { tokens: 199_000 }, lastReload: { at: 6000, reason: "settings" } }))).toEqual({
      state: "saved",
      tokens: 199_000,
    });
  });
});
