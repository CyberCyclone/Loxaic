/**
 * A scripted sequence of tool calls the mock inference engine plays back for
 * one matched prompt, so an e2e spec can drive a multi-step "fix the bug,
 * rerun the tests" agent turn without a real model in the loop.
 *
 * Loaded from MOCK_SCENARIOS_FILE (a JSON file, read at call time like every
 * other env-derived seam in this module — a harness sets it per lane, not at
 * process start). A scenario's step advances once per tool message already in
 * the current turn — the same accounting mockStream uses for its own
 * single-call rule — so this has to be handed that count, not maintain its
 * own; the two must never disagree about which step an iteration is on.
 *
 * A scenario step takes priority over, and is exempt from, MOCK_TOOL_TRIGGERS'
 * single-call-per-turn rule: a scenario is *defined* by needing more than one
 * tool call in a turn. A step only fires when its tool is actually offered,
 * matching the ordinary trigger rule, so a scenario written against a tool the
 * caller disabled just falls through to generic mock behavior instead of
 * silently calling a tool nothing asked for.
 */
import { readFileSync } from "node:fs";

export interface ScenarioStep {
  tool: string;
  args: Record<string, unknown>;
}

export interface Scenario {
  /** Regex source, matched case-insensitively against the user's prompt. */
  match: string;
  steps: ScenarioStep[];
  /** Sent once every step has run, in place of the generic "[Mock] Done..."
   * wrap-up. Falls back to the generic wrap-up when absent. */
  finalText?: string;
}

export type ScenarioDecision = { type: "step"; step: ScenarioStep } | { type: "final"; text: string };

let cache: { path: string; scenarios: Scenario[] } | null = null;

function loadScenarios(): Scenario[] {
  const path = process.env.MOCK_SCENARIOS_FILE;
  if (!path) return [];
  if (cache?.path === path) return cache.scenarios;
  const scenarios = JSON.parse(readFileSync(path, "utf8")) as Scenario[];
  cache = { path, scenarios };
  return scenarios;
}

/**
 * `stepIndex` is how many tool messages the current turn already holds.
 * Passed in rather than recomputed here so mockStream's own bookkeeping and
 * this can never drift apart.
 */
export function scenarioDecisionFor(
  prompt: string,
  toolNames: Set<string>,
  stepIndex: number,
): ScenarioDecision | null {
  const scenario = loadScenarios().find((s) => new RegExp(s.match, "i").test(prompt));
  if (!scenario) return null;
  if (stepIndex < scenario.steps.length) {
    const step = scenario.steps[stepIndex];
    return toolNames.has(step.tool) ? { type: "step", step } : null;
  }
  return scenario.finalText ? { type: "final", text: scenario.finalText } : null;
}

/** Test seam: a suite that sets/unsets MOCK_SCENARIOS_FILE mid-run needs the
 * next call to actually re-read rather than serve a stale cache. */
export function __resetMockScenariosForTest(): void {
  cache = null;
}
