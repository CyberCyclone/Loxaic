import { describe, expect, it } from 'vitest';
import { attachmentFileName, nativeAttachmentFile } from './attachmentUpload';

/**
 * Locks down the exact regression that shipped and broke image attachment
 * on-device: native must upload the {uri, name, type} shape RN's own
 * FormData recipe streams directly, never a Blob built via fetch(uri).blob()
 * — that path fails client-side with a generic "Network request failed",
 * with no request ever reaching the server. See useComposerAttachments.ts.
 */
describe('nativeAttachmentFile', () => {
  it('returns the {uri, name, type} shape, never a Blob', () => {
    const result = nativeAttachmentFile('file:///tmp/photo.jpg', 'image/jpeg');
    expect(result).toEqual({ uri: 'file:///tmp/photo.jpg', name: 'attachment.jpg', type: 'image/jpeg' });
    expect(result).not.toBeInstanceOf(Blob);
  });

  it('carries a data: URI through unchanged — the manipulated-image path in normalize()', () => {
    const dataUri = 'data:image/jpeg;base64,AAAA';
    expect(nativeAttachmentFile(dataUri, 'image/jpeg').uri).toBe(dataUri);
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
