import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { classifyFetchBody, executeTool, type DocumentReader, type PageRenderer } from "../executor.ts";
import { MAX_DOCUMENT_BYTES } from "@loxaic/types";

/** web_fetch never hands the model a file's raw bytes: a document is read in
 * the sandbox, anything else binary is refused, and the run carries on. */
describe("classifyFetchBody", () => {
  it.each([
    ["application/pdf", "document"],
    ["APPLICATION/PDF; name=a.pdf", "document"],
    ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "document"],
    ["application/epub+zip", "document"],
    ["text/rtf", "document"],
    ["", "unlabelled"],
    ["application/octet-stream", "unlabelled"],
    ["binary/octet-stream", "unlabelled"],
    ["image/png", "binary"],
    ["video/mp4", "binary"],
    ["audio/mpeg", "binary"],
    ["font/woff2", "binary"],
    ["application/zip", "binary"],
    ["application/gzip", "binary"],
    ["application/msword", "binary"],
    ["text/html; charset=utf-8", "text"],
    ["text/plain", "text"],
    ["application/json", "text"],
    ["application/xhtml+xml", "text"],
    ["image/svg+xml", "text"],
    ["application/ld+json", "text"],
    ["application/x-yaml", "text"],
  ])("reads %j as %s", (contentType, expected) => {
    expect(classifyFetchBody(contentType)).toBe(expected);
  });
});

describe("web_fetch on a file", () => {
  let server: Server;
  let base: string;
  const PDF = Buffer.concat([Buffer.from("%PDF-1.6\n"), Buffer.from([0, 1, 2, 255]), Buffer.from("rest")]);
  const reader = vi.fn<DocumentReader>();

  /** Routes keyed by path; each writes its own response. */
  const routes: Record<string, (res: ServerResponse) => void> = {
    "/manual.pdf": (res) => { res.setHeader("content-type", "application/pdf"); res.end(PDF); },
    "/labelless.pdf": (res) => { res.setHeader("content-type", "application/octet-stream"); res.end(PDF); },
    "/blob.bin": (res) => { res.setHeader("content-type", "application/octet-stream"); res.end(Buffer.from([1, 0, 2])); },
    "/notes": (res) => { res.setHeader("content-type", "application/octet-stream"); res.end("plain words"); },
    // No NUL: only its type can give this one away.
    "/photo.png": (res) => { res.setHeader("content-type", "image/png"); res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47])); },
    "/mislabelled.txt": (res) => { res.setHeader("content-type", "text/plain"); res.end(Buffer.from("text\0then not")); },
    "/huge.pdf": (res) => {
      res.setHeader("content-type", "application/pdf");
      res.setHeader("content-length", String(MAX_DOCUMENT_BYTES + 1));
      res.write("%PDF-");
    },
    "/lying.pdf": (res) => {
      res.setHeader("content-type", "application/pdf");
      const chunk = Buffer.alloc(1024 * 1024);
      for (let i = 0; i <= MAX_DOCUMENT_BYTES / chunk.length; i++) res.write(chunk);
      res.end();
    },
    "/slow.pdf": (res) => { res.setHeader("content-type", "application/pdf"); res.write("%PDF-"); },
  };

  beforeAll(async () => {
    server = createServer((req, res) => { (routes[req.url ?? ""] ?? ((r) => { r.statusCode = 404; r.end(); }))(res); });
    await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", resolve); });
    const { port } = server.address() as AddressInfo;
    base = `http://127.0.0.1:${String(port)}`;
    process.env.MOCK_INFERENCE = "true";
    process.env.LOXAIC_E2E_FETCH_ALLOW = `127.0.0.1:${String(port)}`;
  });

  afterAll(async () => {
    delete process.env.LOXAIC_E2E_FETCH_ALLOW;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  beforeEach(() => {
    reader.mockReset();
    reader.mockResolvedValue({ ok: true, text: "Page one of the manual." });
  });

  const fetchUrl = (path: string, signal?: AbortSignal, renderer?: PageRenderer) =>
    executeTool(null, "web_fetch", { url: `${base}${path}` }, signal, undefined, { readDocument: reader, renderer: renderer ?? null });

  it("reads a PDF through the document reader, whole and unaltered", async () => {
    const result = await fetchUrl("/manual.pdf");
    expect(result).toMatchObject({ ok: true, output: "Page one of the manual." });
    const [bytes, mime] = reader.mock.calls[0];
    expect(mime).toBe("application/pdf");
    expect(Buffer.compare(bytes, PDF)).toBe(0);
  });

  it("recognises a PDF served as octet-stream by its bytes", async () => {
    expect(await fetchUrl("/labelless.pdf")).toMatchObject({ ok: true, output: "Page one of the manual." });
    expect(reader.mock.calls[0][1]).toBe("application/pdf");
  });

  it("caps what the reader returns like any other page, and says so", async () => {
    reader.mockResolvedValue({ ok: true, text: "x".repeat(200 * 1024) });
    const { output } = await fetchUrl("/manual.pdf");
    expect(output).toContain("[truncated at 102400 characters of extracted text]");
    expect(output.length).toBeLessThan(103_000);
  });

  it("puts the reader's reason on the failed call", async () => {
    reader.mockResolvedValue({ ok: false, reason: "this document has no readable text; it may be a scan." });
    const result = await fetchUrl("/manual.pdf");
    expect(result.ok).toBe(false);
    expect(result.output).toBe(`${base}/manual.pdf: this document has no readable text; it may be a scan.`);
  });

  it("says so when nothing can read documents", async () => {
    const result = await executeTool(null, "web_fetch", { url: `${base}/manual.pdf` });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("Documents can't be read here");
  });

  it.each([
    ["/photo.png", "a binary file (image/png)"],
    ["/mislabelled.txt", "a binary file (text/plain)"],
    ["/blob.bin", "a binary file"],
  ])("refuses %s, and never reaches the reader", async (path, says) => {
    const result = await fetchUrl(path);
    expect(result.ok).toBe(false);
    expect(result.output).toBe(`${base}${path} is ${says}. web_fetch reads text, web pages and documents.`);
    expect(result.output).not.toContain("\u0000");
    expect(reader).not.toHaveBeenCalled();
  });

  it("reads an unlabelled body as text when that is what it is", async () => {
    expect(await fetchUrl("/notes")).toEqual({ ok: true, output: "plain words" });
  });

  it("refuses a declared size over the limit before reading it", async () => {
    const result = await fetchUrl("/huge.pdf");
    expect(result.ok).toBe(false);
    expect(result.output).toBe(`${base}/huge.pdf is 25.0 MB, over the 25 MB web_fetch can read.`);
    expect(reader).not.toHaveBeenCalled();
  });

  it("stops reading a body that runs past the limit, whatever it declared", async () => {
    const result = await fetchUrl("/lying.pdf");
    expect(result.ok).toBe(false);
    expect(result.output).toBe(`${base}/lying.pdf is larger than the 25 MB web_fetch can read.`);
    expect(reader).not.toHaveBeenCalled();
  });

  it("lets Stop reach a download in progress", async () => {
    const stop = new AbortController();
    const result = fetchUrl("/slow.pdf", stop.signal);
    setTimeout(() => { stop.abort(); }, 100);
    expect(await result).toEqual({ ok: false, output: "Fetch failed: Stopped by the user." });
  });

  it("never falls back to the browser for any of these", async () => {
    const renderer = vi.fn<PageRenderer>();
    await fetchUrl("/photo.png", undefined, renderer);
    await fetchUrl("/mislabelled.txt", undefined, renderer);
    await fetchUrl("/huge.pdf", undefined, renderer);
    expect(renderer).not.toHaveBeenCalled();
  });
});
