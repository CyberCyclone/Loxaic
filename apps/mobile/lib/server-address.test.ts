import { describe, expect, it } from 'vitest';
import { normalizeUrl } from './server-address';

describe('normalizeUrl', () => {
  it('accepts a bare hostname, because that is what people paste', () => {
    // A tailnet address copied off the host's own status card carries no
    // scheme. Refusing it would be pedantry rather than safety.
    expect(normalizeUrl('box.tail1234.ts.net')).toBe('https://box.tail1234.ts.net');
  });

  it('keeps an explicit scheme, including plain http for a LAN address', () => {
    expect(normalizeUrl('http://192.168.1.20:4100')).toBe('http://192.168.1.20:4100');
    expect(normalizeUrl('https://box.tail1234.ts.net')).toBe('https://box.tail1234.ts.net');
  });

  it('strips trailing slashes, since every caller appends its own path', () => {
    // `${url}/health` against "https://host/" asks for "//health", which some
    // servers answer and others do not.
    expect(normalizeUrl('https://box.ts.net/')).toBe('https://box.ts.net');
    expect(normalizeUrl('https://box.ts.net///')).toBe('https://box.ts.net');
  });

  it('keeps a real path, for a host behind a reverse proxy subpath', () => {
    expect(normalizeUrl('https://example.com/loxaic/')).toBe('https://example.com/loxaic');
  });

  it('trims surrounding whitespace, which a paste from anywhere carries', () => {
    expect(normalizeUrl('  box.ts.net  ')).toBe('https://box.ts.net');
  });

  it('reports empty as cleared, not as an error', () => {
    // The caller drops the override and goes back to auto-detection; treating
    // it as invalid would leave someone unable to undo a wrong address.
    expect(normalizeUrl('')).toBe(null);
    expect(normalizeUrl('   ')).toBe(null);
  });

  it('refuses something that is not an address', () => {
    expect(normalizeUrl('http://')).toBeInstanceOf(Error);
    expect(normalizeUrl('::::')).toBeInstanceOf(Error);
  });
});
