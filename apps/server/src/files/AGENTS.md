# apps/server/src/files

Uploaded attachments: storage, byte verification, document extraction in a sandbox, prompt wrapping, and the orphan reaper. The serve and upload routes are `routes/files.ts`. Uploads are untrusted bytes served same-origin with the web app.

## Storage

- Bytes live on disk under `UPLOADS_DIR`; only metadata is in Postgres (`attachments`). Unset, it falls back to `<cwd>/uploads` (`apps/server/uploads` in a checkout), which must stay gitignored.
- A document's extracted text is cached beside the original as `<ref>.txt`.
- `isValidRef` takes `unknown` and type-guards — `RegExp.test` stringifies, so `["<uuid>"]` passes a string-typed check.
- Sanitize filenames once at upload (`sanitizeFilename`) and read them back from the DB row for the prompt, the UI chip and `Content-Disposition`; never trust the client's copy.

## Serving (same-origin XSS boundary)

- Never serve with a caller-influenced content type: allowlist the mime (`IMAGE_MIMES`/`TEXT_MIMES`/`DOCUMENT_MIMES`, `resolveAttachmentMime` for an empty browser mime), then confirm it with `verifyStoredBytes` (magic bytes via `sniffMime` for images/PDF; streamed fatal-mode UTF-8 with no NUL byte for text).
- The serve route always sends `nosniff` and `Content-Security-Policy: default-src 'none'; sandbox`.
- **Only images get `Content-Disposition: inline`; everything else is `attachment`.** `text/html` or `text/xml` inline would be same-origin stored XSS.
- Never add SVG to any attachment mime list.
- An attachment is readable when it appears in a conversation the caller can access; `/v1/files/:ref` keeps its `c.deleted_at IS NULL` condition.

## Extraction

- Never parse a document in the server process. `TEXT_MIMES` are decoded in-process as UTF-8 (must keep working with `SANDBOX_MODE=off`); every `DOCUMENT_MIMES` format is parsed by `extract.ts` in a pooled per-user sandbox.
- Document uploads require `mode === "container" && available` — host mode does not count. Otherwise reject with 415 `code: "sandbox_required"`; never store a file nothing can read.
- Extraction reads and never executes (no macros, embedded scripts or PDF JavaScript).
- Name the sandbox copy with the extension from our mime table (`<uuid>.xlsx`), never the user's filename — openpyxl and others dispatch on extension.
- An extractor writes to a file that is read back in base64 chunks, never off stdout — `exec` caps output at `MAX_OUTPUT_BYTES` (256 KB) and a chunk can split a UTF-8 sequence.
- Put scratch files under `handle.root`, never an absolute `/tmp` — on the host provider that is the shared host `/tmp`.
- Keep `MAX_CACHED_EXTRACTION_BYTES` (4 MB sidecar cap) and `MAX_EXTRACTED_BYTES` (256 KB prompt cap) separate — sandbox paging reads past the prompt cap.
- Extraction-pool sandboxes destroy on idle, unlike conversation sandboxes: rowless and keyed by user, nothing could resume them. A sandbox-settings change must stop them (`stopAllExtractionSandboxes`) before `resetEngineCache()`, or they are stranded on the old engine.

## Prompt

- Wrap document text in `<attached-file>` markers (`wrapDocument` in `storage.ts`), neutralise a literal closing marker with a zero-width space, and keep the untrusted-content system-prompt addendum — even for the user's own uploads.
- `selectAffordableAttachments` spends a current-turn reserve plus a history pool oldest-first, so an older turn's verdict never depends on a newer one; never switch to recency-first (it rewrites the cached prefix).

## Reaper

- `reaper.ts` is the only reclaim path (no DELETE route, no cascade): it collects uploads no message references after a grace period and removes the `<ref>.txt` sidecar with them. Deleting a conversation needs no upload step.
- The reaper's SQL and the serve route's access check both key on `block->>'kind' = 'attachment'`; a new block kind carrying refs must be taught to both, or its files are deleted.
