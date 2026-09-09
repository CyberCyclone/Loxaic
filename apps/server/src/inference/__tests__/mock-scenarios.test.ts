import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __resetMockScenariosForTest, scenarioDecisionFor } from "../mock-scenarios.ts";

describe("scenarioDecisionFor", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "mock-scenarios-unit-"));
  });

  afterEach(() => {
    delete process.env.MOCK_SCENARIOS_FILE;
    __resetMockScenariosForTest();
    rmSync(dir, { recursive: true, force: true });
  });

  function withScenarios(scenarios: unknown, filename = "scenarios.json"): void {
    const file = path.join(dir, filename);
    writeFileSync(file, JSON.stringify(scenarios));
    process.env.MOCK_SCENARIOS_FILE = file;
    __resetMockScenariosForTest();
  }

  it("returns null when no MOCK_SCENARIOS_FILE is set", () => {
    expect(scenarioDecisionFor("fix the bug", new Set(["bash"]), 0)).toBeNull();
  });

  it("returns null when the prompt matches no scenario", () => {
    withScenarios([{ match: "fix the bug", steps: [{ tool: "bash", args: {} }] }]);
    expect(scenarioDecisionFor("something unrelated", new Set(["bash"]), 0)).toBeNull();
  });

  it("returns the step at the given index for a matching prompt", () => {
    withScenarios([
      {
        match: "fix the bug",
        steps: [
          { tool: "bash", args: { command: "node --test" } },
          { tool: "fs_edit", args: { path: "a.js" } },
        ],
      },
    ]);
    expect(scenarioDecisionFor("please fix the bug", new Set(["bash", "fs_edit"]), 0)).toEqual({
      type: "step",
      calls: [{ tool: "bash", args: { command: "node --test" } }],
    });
    expect(scenarioDecisionFor("please fix the bug", new Set(["bash", "fs_edit"]), 1)).toEqual({
      type: "step",
      calls: [{ tool: "fs_edit", args: { path: "a.js" } }],
    });
  });

  it("returns every call of a multi-call step, as one assistant message would", () => {
    // What a real model does routinely and no other mock path can produce —
    // the tool loop's per-call abort check is untestable without it (#113).
    withScenarios([
      {
        match: "scaffold it",
        steps: [
          {
            calls: [
              { tool: "fs_write", args: { path: "a.js", content: "a" } },
              { tool: "fs_write", args: { path: "b.js", content: "b" } },
              { tool: "bash", args: { command: "node --test" } },
            ],
          },
        ],
      },
    ]);
    const decision = scenarioDecisionFor("scaffold it", new Set(["fs_write", "bash"]), 0);
    expect(decision).toEqual({
      type: "step",
      calls: [
        { tool: "fs_write", args: { path: "a.js", content: "a" } },
        { tool: "fs_write", args: { path: "b.js", content: "b" } },
        { tool: "bash", args: { command: "node --test" } },
      ],
    });
  });

  it("counts a multi-call step as one tool message per call when choosing the next step", () => {
    // `stepIndex` is the number of tool messages the turn holds, one per
    // call. Indexing steps by it directly made a two-call step advance it by
    // two, so the step after it was skipped (or the scenario fell straight
    // through to finalText) while the fixture read perfectly well.
    withScenarios([
      {
        match: "scaffold then test",
        steps: [
          { calls: [{ tool: "fs_write", args: { path: "a" } }, { tool: "fs_write", args: { path: "b" } }] },
          { tool: "bash", args: { command: "node --test" } },
        ],
        finalText: "[Mock] done.\n",
      },
    ]);
    const tools = new Set(["fs_write", "bash"]);
    expect(scenarioDecisionFor("scaffold then test", tools, 0)?.type).toBe("step");
    // Two tool messages later, the *second* step fires — not finalText.
    expect(scenarioDecisionFor("scaffold then test", tools, 2)).toEqual({
      type: "step",
      calls: [{ tool: "bash", args: { command: "node --test" } }],
    });
    expect(scenarioDecisionFor("scaffold then test", tools, 3)).toEqual({ type: "final", text: "[Mock] done.\n" });
    // Inside a batch is a state no scenario describes.
    expect(scenarioDecisionFor("scaffold then test", tools, 1)).toBeNull();
  });

  it("does not half-fire a multi-call step when one of its tools is missing", () => {
    withScenarios([
      {
        match: "scaffold it",
        steps: [{ calls: [{ tool: "fs_write", args: {} }, { tool: "bash", args: {} }] }],
      },
    ]);
    expect(scenarioDecisionFor("scaffold it", new Set(["fs_write"]), 0)).toBeNull();
  });

  it("falls through to null when the step's tool isn't offered, rather than firing anyway", () => {
    withScenarios([{ match: "fix the bug", steps: [{ tool: "bash", args: {} }] }]);
    expect(scenarioDecisionFor("please fix the bug", new Set(["fs_edit"]), 0)).toBeNull();
  });

  it("returns finalText once every step has run", () => {
    withScenarios([
      { match: "fix the bug", steps: [{ tool: "bash", args: {} }], finalText: "[Mock] done.\n" },
    ]);
    expect(scenarioDecisionFor("please fix the bug", new Set(["bash"]), 1)).toEqual({
      type: "final",
      text: "[Mock] done.\n",
    });
    // Past the step count by more than one, still the final text — a scenario
    // does not become invalid just because the loop keeps iterating.
    expect(scenarioDecisionFor("please fix the bug", new Set(["bash"]), 5)).toEqual({
      type: "final",
      text: "[Mock] done.\n",
    });
  });

  it("returns null once exhausted when the scenario has no finalText", () => {
    withScenarios([{ match: "fix the bug", steps: [{ tool: "bash", args: {} }] }]);
    expect(scenarioDecisionFor("please fix the bug", new Set(["bash"]), 1)).toBeNull();
  });

  it("picks up a new file automatically when MOCK_SCENARIOS_FILE points elsewhere", () => {
    // Two distinct paths, and no explicit reset between them: the cache must
    // key on the path itself, not just be stale until told otherwise — a
    // harness switching scenario files between spec runs relies on this.
    withScenarios([{ match: "alpha", steps: [{ tool: "bash", args: {} }] }], "a.json");
    expect(scenarioDecisionFor("run alpha", new Set(["bash"]), 0)).not.toBeNull();

    const bFile = path.join(dir, "b.json");
    writeFileSync(bFile, JSON.stringify([{ match: "bravo", steps: [{ tool: "bash", args: {} }] }]));
    process.env.MOCK_SCENARIOS_FILE = bFile;

    expect(scenarioDecisionFor("run alpha", new Set(["bash"]), 0)).toBeNull();
    expect(scenarioDecisionFor("run bravo", new Set(["bash"]), 0)).not.toBeNull();
  });
});
