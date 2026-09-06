/**
 * The platform decision behind uploading a picked image — kept dependency-free
 * (no react-native, no expo-image-picker) so it's unit-testable without a
 * device, a real picker, or a React render context. `useComposerAttachments.ts`
 * is the only caller.
 */

/** Extension for the multipart filename, from the resolved mime — matches
 * exactly the mimes `normalize()` in useComposerAttachments.ts ever produces
 * (the server's accepted set), so this is total for real inputs. */
export function attachmentFileName(mime: string): string {
  const ext =
    mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : mime === 'image/gif' ? 'gif' : 'jpg';
  return `attachment.${ext}`;
}

/**
 * A multipart part `expo/fetch` can serialise. Since SDK 56 `expo/fetch` *is*
 * `globalThis.fetch` on native, and its FormData encoder accepts exactly three
 * kinds of part: a string, a `Blob`, or an object exposing `bytes()` (it reads
 * `name` and `type` off the same object for the part headers). React Native's
 * old `{uri, name, type}` recipe is not one of them — it throws
 * "Unsupported FormDataPart implementation" before any request is made.
 */
export interface NativeAttachmentPart {
  /** Kept for callers and tests; `expo/fetch` itself never reads it. */
  uri: string;
  name: string;
  type: string;
  bytes(): Promise<Uint8Array>;
}

/**
 * What gets handed to `uploadAttachment` on native: a `bytes()`-bearing part.
 *
 * `file://` URIs (camera, library, document picker) are read through
 * `fetch(uri)` — `expo/fetch` supports the file scheme on both platforms
 * (ExpoFetch's `NativeResponse.swift` and `OkHttpFileUrlInterceptor.kt`).
 * `data:` URIs — what the manipulated-image path in `normalize()` produces —
 * are decoded here rather than fetched, because the native module has no
 * data-URL handler. Reading happens lazily, inside the encoder, so a part is
 * cheap to build and nothing is loaded into memory until the upload runs.
 *
 * Deliberately NOT a `Blob`: React Native's `Blob` cannot be constructed from
 * bytes, and `expo/fetch` would only hand it back to the encoder anyway.
 *
 * `name`, when given, is a real picked filename (e.g. a document from
 * `expo-document-picker`) and is used verbatim. Camera/library image picks
 * have no real filename to offer, so omitting it keeps the mime-based
 * `attachment.<ext>` fallback.
 */
export function nativeAttachmentFile(
  uri: string,
  mime: string,
  name?: string,
  maxBytes?: number,
): NativeAttachmentPart {
  return {
    uri,
    name: name ?? attachmentFileName(mime),
    type: mime,
    bytes: () => readUriBytes(uri, maxBytes),
  };
}

// `data:[<mediatype>][;base64],<data>` — the media type may carry parameters
// (`image/jpeg;charset=utf-8;base64,…` is legal), so match everything up to the
// comma and only peel `;base64` off its end.
const DATA_URI = /^data:([^,]*?)(;base64)?,(.*)$/s;

/**
 * Byte length a `data:` URI decodes to, without decoding it — what the
 * pre-upload size check uses for the manipulated-image path, where no picker
 * ever reported a size. `undefined` for anything that is not a data URI.
 */
export function dataUriByteLength(uri: string): number | undefined {
  const m = DATA_URI.exec(uri);
  if (!m) return undefined;
  const [, , isBase64, payload] = m;
  if (isBase64) {
    const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0;
    return Math.floor((payload.length * 3) / 4) - padding;
  }
  return percentDecodeBytes(payload).length;
}

/** Percent-decoding straight to bytes: `%FF` is the byte 0xFF, not a UTF-8
 * round-trip through a JS string (which would throw or re-encode it). */
function percentDecodeBytes(text: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    if (ch === 0x25 /* % */ && i + 2 < text.length && /^[0-9a-fA-F]{2}$/.test(text.slice(i + 1, i + 3))) {
      out.push(parseInt(text.slice(i + 1, i + 3), 16));
      i += 2;
    } else if (ch < 0x80) {
      out.push(ch);
    } else {
      // A non-ASCII character that was never percent-encoded: encode it as
      // UTF-8, which is the only sensible reading of a JS string here.
      out.push(...new TextEncoder().encode(text[i]));
    }
  }
  return new Uint8Array(out);
}

/**
 * Bytes behind a `file://` or `data:` URI. Exported for the unit tests.
 *
 * `maxBytes`, when given, is a hard ceiling checked *after* the read — the
 * caller's pre-read check (picker-reported size, `dataUriByteLength`) is what
 * keeps an oversized pick out of memory in the first place; this is the
 * backstop for a `file://` whose size nothing reported, so an oversized file
 * fails with a reason instead of being shipped for the server to reject.
 */
export async function readUriBytes(uri: string, maxBytes?: number): Promise<Uint8Array> {
  const m = DATA_URI.exec(uri);
  let bytes: Uint8Array;
  if (m) {
    const [, , isBase64, payload] = m;
    if (isBase64) {
      const bin = atob(payload);
      bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    } else {
      bytes = percentDecodeBytes(payload);
    }
  } else {
    const res = await fetch(uri);
    if (!res.ok) throw new Error(`reading ${uri}: ${String(res.status)}`);
    bytes = new Uint8Array(await res.arrayBuffer());
  }
  if (maxBytes !== undefined && bytes.byteLength > maxBytes) {
    throw new Error(`file is ${String(bytes.byteLength)} bytes, over the ${String(maxBytes)} byte limit`);
  }
  return bytes;
}
