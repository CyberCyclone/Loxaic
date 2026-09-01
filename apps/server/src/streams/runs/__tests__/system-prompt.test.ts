import { describe, expect, it } from "vitest";
import { MCP_SYSTEM_ADDENDUM } from "../../../mcp/sanitize.ts";
import { DOCUMENT_SYSTEM_ADDENDUM } from "../../../files/storage.ts";
import { assembleSystemPrompt } from "../engine.ts";

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
  const BASE = "You are Shannon.";

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
