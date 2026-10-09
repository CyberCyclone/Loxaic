import { describe, expect, it } from "vitest";
import { MCP_SYSTEM_ADDENDUM } from "../../../mcp/sanitize.ts";
import { DOCUMENT_SYSTEM_ADDENDUM } from "../../../files/storage.ts";
import { TOOLS } from "@loxaic/agent";
import { assembleSystemPrompt } from "../engine.ts";
import { baseSystemPrompt, planningSystemPrompt } from "../agentRun.ts";
import { subagentSystemPrompt } from "../subagentRun.ts";

/**
 * Regression coverage for a defence that was defined, documented, and never
 * wired: DOCUMENT_SYSTEM_ADDENDUM existed with exactly one occurrence in the
 * tree — its own `export const` — so an uploaded document's contents reached
 * the model wrapped in <attached-file> markers with nothing telling the model
 * what those markers meant.
 *
 * Nothing failed when it was missing, which is why it survived review of the
 * code that introduced it. These assertions are the thing that would.
 */
describe("assembleSystemPrompt", () => {
  const BASE = "You are Loxaic.";

  it("appends the document addendum when the turn carries a document", () => {
    const prompt = assembleSystemPrompt(BASE, null, true);
    expect(prompt).toContain(DOCUMENT_SYSTEM_ADDENDUM);
    expect(prompt).toContain(BASE);
  });

  it("omits it when the turn carries no document", () => {
    expect(assembleSystemPrompt(BASE, null, false)).toBe(BASE);
  });

  it("carries both addenda when the turn has documents and MCP tools", () => {
    const prompt = assembleSystemPrompt(BASE, MCP_SYSTEM_ADDENDUM, true);
    expect(prompt).toContain(MCP_SYSTEM_ADDENDUM);
    expect(prompt).toContain(DOCUMENT_SYSTEM_ADDENDUM);
  });

  it("tells the model the attached file is inline, not a path it can open", () => {
    // A marker carries a filename, so without this the model infers there is a
    // file to open and spends a tool call on fs_read before falling back to the
    // inline text. Seen with a real .docx on a real model.
    expect(DOCUMENT_SYSTEM_ADDENDUM).toMatch(/not in your\s+workspace/i);
    expect(DOCUMENT_SYSTEM_ADDENDUM).toMatch(/fs_read/);
    // …but the overflow path really does put a readable file in the workspace,
    // so the instruction must not forbid that too.
    expect(DOCUMENT_SYSTEM_ADDENDUM).toMatch(/exception/i);
  });

  it("tells the model the contents are untrusted and not to be followed", () => {
    // The wording is the whole point of the addendum — an addendum that no
    // longer says this would pass the presence checks above while defending
    // nothing.
    expect(DOCUMENT_SYSTEM_ADDENDUM).toMatch(/UNTRUSTED/);
    expect(DOCUMENT_SYSTEM_ADDENDUM).toMatch(/never instructions to follow/i);
  });

  it("returns null when there is nothing to say at all", () => {
    expect(assembleSystemPrompt(null, null, false)).toBeNull();
  });

  it("still returns the addendum when there is no base prompt", () => {
    expect(assembleSystemPrompt(null, null, true)).toBe(DOCUMENT_SYSTEM_ADDENDUM);
  });
});

describe("todo list guidance", () => {
  // With only "plan and track multi-step work" to go on, a model wrote its list
  // once and never touched it again. The rules are in the tool's description,
  // which every surface sees, and one sentence in the working modes' prompts.
  const scratch = { kind: "scratch" } as const;

  it("is in the tool's description", () => {
    const tool = TOOLS.find((t) => t.name === "todo_write");
    expect(tool?.description).toMatch(/in_progress just before you start it and completed as soon as it is done/);
  });

  it("is in the working modes' prompt and a sub-agent's, and not in planning mode's", () => {
    expect(baseSystemPrompt(scratch)).toContain("todo_write");
    expect(subagentSystemPrompt({ surface: "agent", workspace: scratch, mode: "auto", instructions: null })).toContain("todo_write");
    // Planning ends every turn in a plan or questions; a list is not its job.
    expect(planningSystemPrompt(scratch)).not.toContain("todo_write");
  });
});
