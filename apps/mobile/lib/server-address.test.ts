import { describe, expect, it } from 'vitest';
import { normalizeUrl, tailnetHint } from './server-address';

describe('tailnetHint', () => {
  it('reminds you to connect Tailscale for a MagicDNS name', () => {
    // Testing a tailnet address with Tailscale off on the phone gave the same
    // bare "Could not reach it." as a typo, when the address was fine.
    expect(tailnetHint('http://pheonix.tail47eac7.ts.net:4100')).toMatch(/Tailscale is connected/);
    expect(tailnetHint('https://BOX.tail1234.TS.NET')).not.toBeNull();
    expect(tailnetHint('https://box.tail1234.ts.net./')).not.toBeNull();
  });

  it('recognises a Tailscale IP, which is only 100.64.0.0/10', () => {
    expect(tailnetHint('http://100.101.102.103:4100')).not.toBeNull();
    expect(tailnetHint('http://100.64.0.1')).not.toBeNull();
    expect(tailnetHint('http://100.127.255.254')).not.toBeNull();
    // The rest of 100.0.0.0/8 is ordinary public address space.
    expect(tailnetHint('http://100.63.255.255')).toBeNull();
    expect(tailnetHint('http://100.128.0.1')).toBeNull();
  });

  it('says nothing for any other address', () => {
    expect(tailnetHint('http://192.168.1.13:4100')).toBeNull();
    expect(tailnetHint('https://example.com')).toBeNull();
    // Containing "ts.net" is not being under it.
    expect(tailnetHint('https://ts.net.example.com')).toBeNull();
    expect(tailnetHint('https://notts.net')).toBeNull();
    expect(tailnetHint(null)).toBeNull();
    expect(tailnetHint('not a url')).toBeNull();
  });
});

describe('normalizeUrl', () => {
  it('accepts a bare hostname, because that is what people paste', () => {
    // A tailnet address copied off the host's own status card carries no
    // scheme. Refusing it would be pedantry rather than safety.
    expect(normalizeUrl('box.tail1234.ts.net')).toBe('https://box.tail1234.ts.net');
  });

  it('assumes plain http for an address on your own network', () => {
    // The self-contained server listens on plain HTTP, and the picker's help
    // text advertises "its address on your network". Defaulting these to
    // https produced a bare "Could not reach it." with no hint that the
    // scheme had been guessed — and Save does not test.
    expect(normalizeUrl('192.168.1.20:4100')).toBe('http://192.168.1.20:4100');
    expect(normalizeUrl('localhost:4000')).toBe('http://localhost:4000');
    expect(normalizeUrl('box:4100')).toBe('http://box:4100');
    expect(normalizeUrl('[::1]:4000')).toBe('http://[::1]:4000');
    // A typed scheme is never second-guessed.
    expect(normalizeUrl('https://192.168.1.20:4100')).toBe('https://192.168.1.20:4100');
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
