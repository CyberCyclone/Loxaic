import { afterEach, describe, expect, it, vi } from 'vitest';
import { attachmentFileName, dataUriByteLength, nativeAttachmentFile, readUriBytes } from './attachmentUpload';

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
    const fetchSpy = vi.fn(() => Promise.resolve({ ok: true, arrayBuffer: () => Promise.resolve(payload.buffer) }));
    vi.stubGlobal('fetch', fetchSpy);
    const bytes = await readUriBytes('file:///tmp/photo.jpg');
    expect(Array.from(bytes)).toEqual([1, 2, 3, 4]);
    expect(fetchSpy).toHaveBeenCalledWith('file:///tmp/photo.jpg');
  });

  it('is lazy: building the part reads nothing until bytes() runs', async () => {
    const fetchSpy = vi.fn(() => Promise.resolve({ ok: true, arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)) }));
    vi.stubGlobal('fetch', fetchSpy);
    const part = nativeAttachmentFile('file:///tmp/photo.jpg', 'image/jpeg');
    expect(fetchSpy).not.toHaveBeenCalled();
    await part.bytes();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe('readUriBytes — data: URI edge cases (review findings on #90)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('accepts a media type carrying parameters instead of falling through to fetch', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const bytes = await readUriBytes('data:image/jpeg;charset=utf-8;base64,' + btoa('hi'));
    expect(Array.from(bytes)).toEqual([0x68, 0x69]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('percent-decodes a non-base64 payload byte-wise — %FF is the byte 0xFF, not a URIError', async () => {
    const bytes = await readUriBytes('data:application/octet-stream,a%FF%00b');
    expect(Array.from(bytes)).toEqual([0x61, 0xff, 0x00, 0x62]);
  });

  it('enforces maxBytes after the read, with a message that names the sizes', async () => {
    await expect(readUriBytes('data:text/plain;base64,' + btoa('hello'), 4)).rejects.toThrow(/5 bytes, over the 4 byte limit/);
    await expect(readUriBytes('data:text/plain;base64,' + btoa('hello'), 5)).resolves.toHaveLength(5);
  });
});

describe('dataUriByteLength — the pre-read size check for the manipulated-image path', () => {
  it('sizes a base64 payload without decoding it, padding included', () => {
    expect(dataUriByteLength('data:image/jpeg;base64,' + btoa('hello'))).toBe(5);     // one '=' of padding
    expect(dataUriByteLength('data:image/jpeg;base64,' + btoa('hell'))).toBe(4);      // two
    expect(dataUriByteLength('data:image/jpeg;base64,' + btoa('hel'))).toBe(3);       // none
  });

  it('sizes a percent-encoded payload by its decoded bytes', () => {
    expect(dataUriByteLength('data:text/plain,a%FFb')).toBe(3);
  });

  it('is undefined for anything that is not a data: URI, so a file:// read stays lazy', () => {
    expect(dataUriByteLength('file:///tmp/photo.jpg')).toBeUndefined();
  });
});
