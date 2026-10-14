import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NESTED_WINDOW_SHARE, chooseMode, instructionBudget, instructionTokens } from "../instructions.ts";

/**
 * This repository's own instruction files, held to the budgets that make them
 * useful: the root goes in whole even on a 32k model, and each directory's
 * file goes in whole on a 64k one when an agent reads a file there. Measured
 * with the same functions that decide it at run time, so the budget cannot
 * drift from what an agent is actually given.
 */
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");
const ROOT_WINDOW = 32_768;
const NESTED_WINDOW = 65_536;
const ROOT_SHARE = 0.15;

/** Directories never searched: dependencies, build output, test fixtures that
 * exist to be other projects, and the historical design prototype. */
const SKIP = new Set(["node_modules", ".git", "dist", "build", "ios", "android", ".expo", "artifacts", ".turbo"]);
const SKIP_PATHS = new Set(["apps/e2e/fixtures", "design"]);

function find(name: string, dir = REPO, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(REPO, full);
    if (entry.isDirectory()) {
      if (SKIP.has(entry.name) || SKIP_PATHS.has(rel)) continue;
      find(name, full, out);
    } else if (entry.name === name) {
      out.push(rel);
    }
  }
  return out;
}

const nested = find("AGENTS.md").filter((f) => f !== "AGENTS.md");

describe("this repository's instruction files", () => {
  it("has a root AGENTS.md that goes in whole on a 32k model", () => {
    const tokens = instructionTokens(readFileSync(path.join(REPO, "AGENTS.md"), "utf8"));
    const budget = instructionBudget(ROOT_WINDOW, ROOT_SHARE);
    expect(chooseMode(tokens, ROOT_WINDOW, ROOT_SHARE), `AGENTS.md is ${String(tokens)} tokens; the budget is ${String(budget)}`).toBe("full");
  });

  it.each(nested)("%s goes in whole on a 64k model", (file) => {
    const tokens = instructionTokens(readFileSync(path.join(REPO, file), "utf8"));
    const budget = instructionBudget(NESTED_WINDOW, NESTED_WINDOW_SHARE);
    expect(chooseMode(tokens, NESTED_WINDOW, NESTED_WINDOW_SHARE), `${file} is ${String(tokens)} tokens; the budget is ${String(budget)}`).toBe("full");
  });

  it("has no CLAUDE.md, which would stop Claude Code reading the AGENTS.md files", () => {
    // Claude Code reads AGENTS.md natively, but only where no CLAUDE.md exists
    // in that directory or above it.
    expect(existsSync(path.join(REPO, "CLAUDE.md"))).toBe(false);
    expect(find("CLAUDE.md")).toEqual([]);
  });
});
