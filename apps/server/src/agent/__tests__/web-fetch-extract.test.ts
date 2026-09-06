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
  it("strips a <style> block that has no closing tag, when the body was truncated", () => {
    const cut = `<html><body><p>Top story</p><style>${"body,html{height:100%;overflow:hidden}".repeat(50)}`;
    const text = htmlToText(cut, true);
    expect(text).toBe("Top story");
    expect(text).not.toMatch(/overflow:hidden/);
  });

  it("strips an unterminated <script> the same way", () => {
    const cut = `<html><body><p>Headline</p><script>${"var a=1;window.x=function(){};".repeat(50)}`;
    expect(htmlToText(cut, true)).toBe("Headline");
  });

  it("does NOT eat the rest of a complete page that merely looks unterminated", () => {
    // The cleanup above is only sound for a body cut mid-block. On a whole
    // page an opener without a close is malformed, not severed, and eating to
    // end-of-input silently reduces the page to "" — a wrong answer with no
    // sign anything went wrong.
    const page = '<html><body><p>Real content</p><div title="<style"></div></body></html>';
    expect(htmlToText(page, false)).toContain("Real content");
  });

  it("accepts whitespace before the > in a closing tag", () => {
    // `</script >` and `</SCRIPT\n>` are valid HTML5. Requiring the exact
    // bytes `</script>` made a complete page look unterminated, which then
    // handed the whole document to the truncation cleanup.
    const page = '<html><body><script>var a=1;</script >\n<p>Body text</p></body></html>';
    expect(htmlToText(page, true)).toBe("Body text");
    const upper = '<html><body><SCRIPT>var a=1;</SCRIPT\n>\n<p>Body text</p></body></html>';
    expect(htmlToText(upper, true)).toBe("Body text");
  });

  it("strips unclosed-script input in linear time, not quadratically", () => {
    // Regression guard for a remote event-loop stall. The paired
    // `/<script[\s\S]*?<\/script>/g` form this replaced backtracks O(bytes ×
    // openers): measured 66 ms at 50 KB, 254 ms at 100 KB, 1.0 s at 200 KB,
    // 4.0 s at 400 KB — and WEB_FETCH_MAX_RAW_BYTES is 2 MB, which
    // extrapolates to ~100 s of synchronous stall on a model-chosen URL.
    const hostile = "<script".repeat(Math.floor((2 * 1024 * 1024) / 7));
    const started = Date.now();
    htmlToText(hostile, true);
    // Generous on purpose — the point is orders of magnitude, not a stopwatch.
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("still strips normal, properly closed blocks", () => {
    const html = "<html><head><style>.a{color:red}</style><script>var a=1;</script></head><body><p>Body text</p></body></html>";
    expect(htmlToText(html)).toBe("Body text");
  });

  it("strips several blocks in one pass, keeping the text between them", () => {
    const html = "<p>one</p><script>a</script><p>two</p><style>b</style><p>three</p>";
    expect(htmlToText(html)).toBe("one two three");
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
