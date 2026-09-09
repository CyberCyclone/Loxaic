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

export interface ScenarioCall {
  tool: string;
  args: Record<string, unknown>;
}

/**
 * One turn of the scenario. Either a single tool call — the common case, and
 * the shape the fixtures were written in — or several in **one assistant
 * message** via `calls`, which is what a real model routinely emits (five in
 * one message was an ordinary turn in the session behind #113) and what
 * nothing else in the suite could produce.
 */
export type ScenarioStep = ScenarioCall | { calls: ScenarioCall[] };

function callsOf(step: ScenarioStep): ScenarioCall[] {
  return "calls" in step ? step.calls : [step];
}

export interface Scenario {
  /** Regex source, matched case-insensitively against the user's prompt. */
  match: string;
  steps: ScenarioStep[];
  /** Sent once every step has run, in place of the generic "[Mock] Done..."
   * wrap-up. Falls back to the generic wrap-up when absent. */
  finalText?: string;
}

/** Always a list, however the step was written — so callers have one shape to
 * handle rather than branching on the fixture's spelling. */
export type ScenarioDecision = { type: "step"; calls: ScenarioCall[] } | { type: "final"; text: string };

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
  // `stepIndex` is how many tool *messages* the turn already holds — one per
  // call, not one per step — so it is walked through the steps' call counts
  // rather than used as an index. Used directly, a two-call step advanced it
  // by two and the scenario skipped its next step (or fell straight through
  // to finalText) while looking perfectly well-formed.
  let consumed = 0;
  for (const step of scenario.steps) {
    if (consumed === stepIndex) {
      const calls = callsOf(step);
      // Every call in the step has to be offered, not just the first: a step
      // half-fired would be a batch the fixture never described.
      return calls.every((c) => toolNames.has(c.tool)) ? { type: "step", calls } : null;
    }
    consumed += callsOf(step).length;
    // Landing inside a step means a batch was only partly answered, which no
    // scenario describes; fall through to the generic mock rather than guess.
    if (consumed > stepIndex) return null;
  }
  return scenario.finalText ? { type: "final", text: scenario.finalText } : null;
}

/** Test seam: a suite that sets/unsets MOCK_SCENARIOS_FILE mid-run needs the
 * next call to actually re-read rather than serve a stale cache. */
export function __resetMockScenariosForTest(): void {
  cache = null;
}
