import { describe, expect, it } from "vitest";
import { extractFetchText, htmlToText } from "../executor.ts";

/**
 * Regression cover for the fetch that cost 109 seconds of prompt evaluation.
 *
 * A news page's inline <style> block ran past the byte cap, the body was
 * truncated *before* htmlToText saw it, and the non-greedy `<style>…</style>`
 * pattern — which needs a closing tag — matched nothing at all. 100 KB of raw
 * CSS went into the prompt, and the backend had ~58k new tokens to evaluate.
 * Both halves are pinned here: strip before truncate, and cope with a block
 * the truncation cut in half.
 */
describe("web_fetch text extraction", () => {
  it("strips a <style> block that has no closing tag", () => {
    const cut = `<html><body><p>Top story</p><style>${"body,html{height:100%;overflow:hidden}".repeat(50)}`;
    const text = htmlToText(cut);
    expect(text).toBe("Top story");
    expect(text).not.toMatch(/overflow:hidden/);
  });

  it("strips an unterminated <script> the same way", () => {
    const cut = `<html><body><p>Headline</p><script>${"var a=1;window.x=function(){};".repeat(50)}`;
    expect(htmlToText(cut)).toBe("Headline");
  });

  it("still strips normal, properly closed blocks", () => {
    const html = "<html><head><style>.a{color:red}</style><script>var a=1;</script></head><body><p>Body text</p></body></html>";
    expect(htmlToText(html)).toBe("Body text");
  });

  it("leaves a bare < in prose alone", () => {
    expect(htmlToText("<p>2 &lt; 3 and a &lt; b</p>")).toBe("2 < 3 and a < b");
  });

  it("truncates the extracted text, not the source — markup never eats the budget", () => {
    // 400 KB of source that reduces to a single short sentence. Truncating
    // the source first would have spent the whole budget before reaching it.
    const prose = "The council approved the measure on Tuesday.";
    const html = `<html><head><style>${"a{b:c}".repeat(80_000)}</style></head><body><p>${prose}</p></body></html>`;
    expect(html.length).toBeGreaterThan(400_000);

    const out = extractFetchText(html, "text/html; charset=utf-8", false);
    expect(out).toBe(prose);
    expect(out).not.toContain("truncated");
  });

  it("truncates and says so when the extracted text really is that long", () => {
    const prose = "word ".repeat(40_000); // ~200 KB of actual text
    const out = extractFetchText(`<html><body><p>${prose}</p></body></html>`, "text/html", false);
    expect(out).toContain("[truncated at");
    expect(out).toContain("characters of extracted text");
  });

  it("reports an unread tail when the body hit the raw cap but the text fits", () => {
    const out = extractFetchText("<p>Short enough</p>", "text/html", true);
    expect(out).toBe("Short enough\n… [page was larger than 2097152 bytes; the rest was not read]");
  });

  it("passes non-HTML content through untouched", () => {
    const json = '{"a":1,"b":"<not-a-tag>"}';
    expect(extractFetchText(json, "application/json", false)).toBe(json);
  });
});
