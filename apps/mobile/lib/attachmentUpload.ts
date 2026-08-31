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
 * What gets handed to `uploadAttachment` on native: RN's own documented
 * FormData recipe — `{uri, name, type}` — which RN's networking module
 * streams directly (it also decodes a `data:` URI directly, which is what
 * the manipulated-image path in `normalize()` produces).
 *
 * Deliberately NOT a `Blob`: building one via `fetch(uri).blob()` and
 * uploading *that* is the well-known unreliable path on React Native — it
 * fails client-side with a generic "Network request failed", no request
 * ever reaching the server. That was a real, shipped bug here (see the
 * accompanying test) until this function replaced the inline Blob-building
 * on the native branch of `upload()`.
 */
export function nativeAttachmentFile(uri: string, mime: string): { uri: string; name: string; type: string } {
  return { uri, name: attachmentFileName(mime), type: mime };
}
