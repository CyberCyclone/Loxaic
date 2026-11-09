import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_PROGRESS_CHECK_MS,
  DEFAULT_PROGRESS_CHECK_STEPS,
  MAX_PROGRESS_CHECK_MS,
  MAX_PROGRESS_REVIEW_PROMPT_CHARS,
  MIN_PROGRESS_CHECK_MS,
  MIN_PROGRESS_CHECK_STEPS,
  parseProgressNote,
  progressNoteText,
} from "@loxaic/types";
import {
  DEFAULT_REVIEW_PROMPT,
  DIGEST_STEPS,
  REVIEW_OUTPUT_CONTRACT,
  clampProgressCheckMs,
  clampProgressCheckSteps,
  clip,
  parseVerdict,
  resolveReviewPrefs,
  reviewDeadlineMs,
  reviewDigest,
  reviewDue,
  reviewMessages,
  reviewOutcome,
  serverDefaultProgressCheckMs,
  type DigestStep,
} from "../progress-review.ts";

afterEach(() => {
  delete process.env.PROGRESS_CHECK_MS;
  delete process.env.PROGRESS_CHECK_STEPS;
  delete process.env.REVIEW_DEADLINE_MS;
});

describe("reviewDue", () => {
  const every = { everyMs: 60_000, everySteps: 5 };
  it("waits until either the steps or the working time are reached", () => {
    expect(reviewDue({ stepsSinceReview: 4, workedMsSinceReview: 59_999, ...every })).toBe(false);
  });
  it("is due on steps alone", () => {
    expect(reviewDue({ stepsSinceReview: 5, workedMsSinceReview: 0, ...every })).toBe(true);
  });
  it("is due on working time alone, as for one very slow step", () => {
    expect(reviewDue({ stepsSinceReview: 1, workedMsSinceReview: 60_000, ...every })).toBe(true);
  });
});

describe("resolveReviewPrefs", () => {
  it("defaults to on, the server's cadence and the built-in instructions", () => {
    expect(resolveReviewPrefs(null)).toEqual({
      enabled: true,
      everyMs: DEFAULT_PROGRESS_CHECK_MS,
      everySteps: DEFAULT_PROGRESS_CHECK_STEPS,
      instructions: DEFAULT_REVIEW_PROMPT,
    });
  });
  it("takes the operator's default when the user chose none", () => {
    process.env.PROGRESS_CHECK_MS = "4000";
    process.env.PROGRESS_CHECK_STEPS = "2";
    expect(resolveReviewPrefs({ progressCheckMs: null, progressCheckSteps: null })).toMatchObject({ everyMs: 4000, everySteps: 2 });
  });
  it("prefers the user's own choices", () => {
    process.env.PROGRESS_CHECK_MS = "4000";
    expect(
      resolveReviewPrefs({ progressReview: false, progressCheckMs: 120_000, progressCheckSteps: 7, progressReviewPrompt: "Be strict." }),
    ).toEqual({ enabled: false, everyMs: 120_000, everySteps: 7, instructions: "Be strict." });
  });
  it("clamps stored values that never came through the route", () => {
    expect(clampProgressCheckMs(1)).toBe(MIN_PROGRESS_CHECK_MS);
    expect(clampProgressCheckMs(Number.MAX_SAFE_INTEGER)).toBe(MAX_PROGRESS_CHECK_MS);
    expect(clampProgressCheckSteps(0)).toBe(MIN_PROGRESS_CHECK_STEPS);
    expect(clampProgressCheckMs(null)).toBeNull();
  });
  it("ignores a stored prompt that is blank or too long", () => {
    expect(resolveReviewPrefs({ progressReviewPrompt: "   " }).instructions).toBe(DEFAULT_REVIEW_PROMPT);
    expect(resolveReviewPrefs({ progressReviewPrompt: "x".repeat(MAX_PROGRESS_REVIEW_PROMPT_CHARS + 1) }).instructions).toBe(DEFAULT_REVIEW_PROMPT);
  });
  it("caps the operator's default at the longest a user could choose", () => {
    process.env.PROGRESS_CHECK_MS = String(MAX_PROGRESS_CHECK_MS * 10);
    expect(serverDefaultProgressCheckMs()).toBe(MAX_PROGRESS_CHECK_MS);
  });
  it("reads the review deadline at call time, five minutes by default", () => {
    expect(reviewDeadlineMs()).toBe(5 * 60 * 1000);
    process.env.REVIEW_DEADLINE_MS = "300";
    expect(reviewDeadlineMs()).toBe(300);
  });
});

function step(n: number, overrides: Partial<DigestStep> = {}): DigestStep {
  return {
    calls: [{ tool: "bash", args: `{"command":"cat file-${String(n)}"}`, result: `contents ${String(n)}`, ok: true }],
    ms: 90_000,
    thinkingChars: 1200,
    completionTokens: 400,
    ...overrides,
  };
}

describe("reviewDigest", () => {
  const base = {
    task: "Find out why the approval test fails",
    subagent: false,
    steps: [step(1), step(2)],
    stepsDone: 2,
    workedMs: 180_000,
    lastText: "Looking at the sheet now.",
    thinkingTail: "The footer shrinks because...",
    contextTokens: 160_000,
    previous: null,
  };

  it("says what a reviewer needs to judge progress", () => {
    const digest = reviewDigest(base);
    expect(digest).toContain("Find out why the approval test fails");
    expect(digest).toContain("2 steps, 3.0 min of working time");
    expect(digest).toContain("context: about 160000 tokens");
    expect(digest).toContain("### Step 1 (1.5 min, 1200 characters of thinking, wrote 400 tokens)");
    expect(digest).toContain('- bash {"command":"cat file-2"}');
    expect(digest).toContain("→ contents 2");
    expect(digest).toContain("Looking at the sheet now.");
    expect(digest).toContain("The footer shrinks because...");
  });

  it("names a sub-agent's task as its parent's, and the last verdict", () => {
    const digest = reviewDigest({ ...base, subagent: true, previous: { verdict: "stuck", reason: "Rereading the same file." } });
    expect(digest).toContain("handed to this agent by another agent");
    expect(digest).toContain("last review: stuck — Rereading the same file.");
  });

  it("shows only the last steps, numbered from where they really are", () => {
    const steps = Array.from({ length: 25 }, (_, i) => step(i + 1));
    const digest = reviewDigest({ ...base, steps: steps.slice(-DIGEST_STEPS), stepsDone: 25 });
    expect(digest).toContain(`Its last ${String(DIGEST_STEPS)} steps`);
    expect(digest).toContain("### Step 16 ");
    expect(digest).toContain("### Step 25 ");
    expect(digest).not.toContain("### Step 15 ");
  });

  it("stays small however much the run wrote", () => {
    const huge = "y".repeat(200_000);
    const steps = Array.from({ length: DIGEST_STEPS }, (_, i) =>
      step(i, { calls: [{ tool: "fs_write", args: huge, result: huge, ok: false }] }),
    );
    const digest = reviewDigest({ ...base, task: huge, steps, stepsDone: 90, lastText: huge, thinkingTail: huge });
    // Task, ten steps' arguments and results, text and thinking, each capped.
    expect(digest.length).toBeLessThan(20_000);
    expect(digest).toContain("✗");
  });

  it("clips from the middle so both ends survive", () => {
    expect(clip("abcdefghij", 20)).toBe("abcdefghij");
    const clipped = clip(`start${"x".repeat(100)}end`, 21);
    expect(clipped.startsWith("start")).toBe(true);
    expect(clipped.endsWith("end")).toBe(true);
    expect(clipped).toContain("[…]");
  });
});

describe("reviewMessages", () => {
  it("always ends the instructions with the fixed output contract", () => {
    const [system, user] = reviewMessages("Only say stuck if it repeats a call three times.", "digest");
    expect(system).toEqual({
      role: "system",
      content: `Only say stuck if it repeats a call three times.\n\n${REVIEW_OUTPUT_CONTRACT}`,
    });
    expect(user).toEqual({ role: "user", content: "digest" });
  });
});

describe("parseVerdict", () => {
  it("reads a bare object", () => {
    expect(parseVerdict('{"verdict": "stuck", "reason": "It keeps rereading engine.ts."}')).toEqual({
      verdict: "stuck",
      reason: "It keeps rereading engine.ts.",
    });
  });
  it("reads a fenced object, in any case, even after a stray brace", () => {
    expect(parseVerdict('I weighed {the steps}:\n```json\n{"verdict": "Finished", "reason": "It has the fix."}\n```')).toEqual({
      verdict: "finished",
      reason: "It has the fix.",
    });
  });
  it("reads an object among other words", () => {
    expect(parseVerdict('I think {"verdict":"progressing"} fits.')).toEqual({ verdict: "progressing", reason: "" });
  });
  it("is no verdict for anything else", () => {
    expect(parseVerdict("It looks stuck to me.")).toBeNull();
    expect(parseVerdict('{"verdict": "maybe"}')).toBeNull();
    expect(parseVerdict("{not json}")).toBeNull();
    expect(parseVerdict("")).toBeNull();
  });
  it("keeps a reason to one bounded line", () => {
    const parsed = parseVerdict(JSON.stringify({ verdict: "stuck", reason: `a\n\nb ${"c".repeat(1000)}` }));
    expect(parsed?.reason.startsWith("a b ")).toBe(true);
    expect(parsed?.reason.length).toBe(500);
  });
});

describe("reviewOutcome", () => {
  const clean = { stuck: false, missed: false };
  const afterStuck = { stuck: true, missed: false };
  const afterMiss = { stuck: false, missed: true };

  it("leaves a progressing run alone, and clears both streaks", () => {
    for (const subagent of [false, true]) {
      expect(reviewOutcome({ subagent, verdict: "progressing", streak: afterStuck })).toEqual({ action: "none", streak: clean });
    }
  });

  it("tells a sub-agent to answer on anything else", () => {
    expect(reviewOutcome({ subagent: true, verdict: "stuck", streak: clean }).action).toBe("answer");
    expect(reviewOutcome({ subagent: true, verdict: "finished", streak: clean }).action).toBe("answer");
    expect(reviewOutcome({ subagent: true, verdict: null, streak: clean }).action).toBe("answer");
  });

  it("steers a person's run the first time it is stuck, and has it answer the second", () => {
    const first = reviewOutcome({ subagent: false, verdict: "stuck", streak: clean });
    expect(first).toEqual({ action: "steer", streak: afterStuck });
    expect(reviewOutcome({ subagent: false, verdict: "stuck", streak: first.streak }).action).toBe("answer");
  });

  it("has a person's run answer at once when it already has its answer", () => {
    expect(reviewOutcome({ subagent: false, verdict: "finished", streak: clean }).action).toBe("answer");
  });

  it("leaves a person's run alone on one missing verdict, and has it answer on two", () => {
    const first = reviewOutcome({ subagent: false, verdict: null, streak: clean });
    expect(first).toEqual({ action: "none", streak: afterMiss });
    expect(reviewOutcome({ subagent: false, verdict: null, streak: first.streak }).action).toBe("answer");
  });

  it("does not count a stuck verdict before a progressing one", () => {
    const back = reviewOutcome({ subagent: false, verdict: "progressing", streak: afterStuck });
    expect(reviewOutcome({ subagent: false, verdict: "stuck", streak: back.streak }).action).toBe("steer");
  });
});

describe("progress notes", () => {
  it("read back what they say", () => {
    const steer = progressNoteText("steer", "  It keeps\nrereading engine.ts. ");
    expect(parseProgressNote(steer)).toEqual({ action: "steer", reason: "It keeps rereading engine.ts." });
    expect(parseProgressNote(progressNoteText("answer", "It has the fix."))).toEqual({ action: "answer", reason: "It has the fix." });
  });
  it("say something even when the reviewer gave no reason", () => {
    expect(parseProgressNote(progressNoteText("answer", ""))?.reason).toMatch(/does not look like/);
  });
  it("are not mistaken for what a person types", () => {
    expect(parseProgressNote("Progress check: how is it going?")).toBeNull();
    expect(parseProgressNote("[Progress check] my own words")).toBeNull();
  });
  it("leave the built-in instructions naming all three verdicts", () => {
    for (const word of ["progressing", "stuck", "finished"]) expect(DEFAULT_REVIEW_PROMPT).toContain(`${word}:`);
  });
});
