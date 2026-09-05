import { afterEach, describe, expect, it, vi } from 'vitest';
import { attachmentFileName, nativeAttachmentFile, readUriBytes } from './attachmentUpload';

/**
 * Locks down the exact regression that shipped and broke image attachment
 * on-device: native must upload the {uri, name, type} shape RN's own
 * FormData recipe streams directly, never a Blob built via fetch(uri).blob()
 * — that path fails client-side with a generic "Network request failed",
 * with no request ever reaching the server. See useComposerAttachments.ts.
 */
describe('nativeAttachmentFile', () => {
  it('returns a {uri, name, type, bytes()} part — never a Blob, never a bare RN {uri} object', () => {
    const result = nativeAttachmentFile('file:///tmp/photo.jpg', 'image/jpeg');
    expect(result).toMatchObject({ uri: 'file:///tmp/photo.jpg', name: 'attachment.jpg', type: 'image/jpeg' });
    // expo/fetch's encoder dispatches on `'bytes' in part`; without it the
    // upload dies with "Unsupported FormDataPart implementation".
    expect(typeof result.bytes).toBe('function');
    expect(result).not.toBeInstanceOf(Blob);
  });

  it('carries a data: URI through unchanged — the manipulated-image path in normalize()', () => {
    const dataUri = 'data:image/jpeg;base64,AAAA';
    expect(nativeAttachmentFile(dataUri, 'image/jpeg').uri).toBe(dataUri);
  });

  it('uses a supplied name verbatim, overriding the mime-based default', () => {
    const result = nativeAttachmentFile('file:///tmp/doc.csv', 'text/csv', 'budget.csv');
    expect(result).toMatchObject({ uri: 'file:///tmp/doc.csv', name: 'budget.csv', type: 'text/csv' });
  });
});

describe('attachmentFileName', () => {
  it.each([
    ['image/jpeg', 'attachment.jpg'],
    ['image/png', 'attachment.png'],
    ['image/webp', 'attachment.webp'],
    ['image/gif', 'attachment.gif'],
  ])('maps %s to %s', (mime, expected) => {
    expect(attachmentFileName(mime)).toBe(expected);
  });
});

describe('readUriBytes — what expo/fetch will call through bytes()', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('decodes a base64 data: URI in-process, never touching fetch', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const bytes = await readUriBytes('data:image/jpeg;base64,' + btoa('hello'));
    expect(Array.from(bytes)).toEqual(Array.from(new TextEncoder().encode('hello')));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('reads a file: URI through fetch(uri).arrayBuffer() — the expo/fetch file-scheme path', async () => {
    const payload = new Uint8Array([1, 2, 3, 4]);
    const fetchSpy = vi.fn(async () => ({ ok: true, arrayBuffer: async () => payload.buffer }));
    vi.stubGlobal('fetch', fetchSpy);
    const bytes = await readUriBytes('file:///tmp/photo.jpg');
    expect(Array.from(bytes)).toEqual([1, 2, 3, 4]);
    expect(fetchSpy).toHaveBeenCalledWith('file:///tmp/photo.jpg');
  });

  it('is lazy: building the part reads nothing until bytes() runs', async () => {
    const fetchSpy = vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(0) }));
    vi.stubGlobal('fetch', fetchSpy);
    const part = nativeAttachmentFile('file:///tmp/photo.jpg', 'image/jpeg');
    expect(fetchSpy).not.toHaveBeenCalled();
    await part.bytes();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
