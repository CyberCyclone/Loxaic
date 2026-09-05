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
export function nativeAttachmentFile(uri: string, mime: string, name?: string): NativeAttachmentPart {
  return {
    uri,
    name: name ?? attachmentFileName(mime),
    type: mime,
    bytes: () => readUriBytes(uri),
  };
}

const DATA_URI = /^data:([^;,]*)(;base64)?,(.*)$/s;

/** Bytes behind a `file://` or `data:` URI. Exported for the unit tests. */
export async function readUriBytes(uri: string): Promise<Uint8Array> {
  const m = DATA_URI.exec(uri);
  if (m) {
    const [, , isBase64, payload] = m;
    if (isBase64) {
      const bin = atob(payload);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    }
    return new TextEncoder().encode(decodeURIComponent(payload));
  }
  const res = await fetch(uri);
  if (!res.ok) throw new Error(`reading ${uri}: ${String(res.status)}`);
  return new Uint8Array(await res.arrayBuffer());
}
