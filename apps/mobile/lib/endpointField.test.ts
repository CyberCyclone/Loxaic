import { describe, expect, it } from 'vitest';
import { endpointFieldValue, endpointInUse, withoutStaleEndpoint } from './endpointField';

describe('endpointFieldValue', () => {
  it('shows an address set from the sign-in screen', () => {
    // The picker writes only the override; nothing else knew about it.
    expect(endpointFieldValue('https://pheonix.tail47eac7.ts.net')).toBe('https://pheonix.tail47eac7.ts.net');
  });

  it('is empty with no override, whatever Settings used to keep', () => {
    // An install whose `loxaic-settings` still holds an endpoint but whose
    // override was cleared (from the picker, or by Disconnect) is not using
    // that address. The copy is not an input: all there is to go on is the
    // missing override.
    expect(endpointFieldValue(null)).toBe('');
  });

  it('treats a blank override as none', () => {
    expect(endpointFieldValue('  ')).toBe('');
  });
});

describe('endpointInUse', () => {
  const none = { saved: '', draft: '', desktop: false };

  it('names what auto-detection found, under an empty field', () => {
    expect(endpointInUse({ ...none, active: 'http://10.0.2.2:4000' })).toEqual({
      url: 'http://10.0.2.2:4000',
      source: 'detected',
    });
  });

  it('says nothing beside a pinned address, even before the app has caught up with it', () => {
    // The field names the server; a second, different name under it (still
    // resolving, say) would contradict it.
    expect(
      endpointInUse({ ...none, saved: 'https://new.example.com', draft: 'https://new.example.com', active: 'http://192.168.1.13:4100' }),
    ).toBeNull();
  });

  it('says nothing under an address being typed', () => {
    expect(endpointInUse({ ...none, draft: 'https://new.example.com', active: 'http://localhost:4000' })).toBeNull();
  });

  it('says nothing when nothing has been resolved yet', () => {
    expect(endpointInUse({ ...none, active: null })).toBeNull();
    expect(endpointInUse({ ...none, active: ' ' })).toBeNull();
  });

  it('treats a blank saved or typed address as none', () => {
    expect(endpointInUse({ ...none, saved: ' ', draft: ' ', active: 'http://localhost:4000' })).toEqual({
      url: 'http://localhost:4000',
      source: 'detected',
    });
  });

  it('does not call the desktop’s address detected: onboarding set it up', () => {
    // A Tailscale client's host, typed in onboarding, or a Solo/Host's own
    // server — never something this app went looking for.
    expect(endpointInUse({ ...none, desktop: true, active: 'https://host.tail1234.ts.net' })).toEqual({
      url: 'https://host.tail1234.ts.net',
      source: 'setup',
    });
  });
});

describe('withoutStaleEndpoint', () => {
  it('drops the endpoint copy older builds saved, and keeps the rest', () => {
    const stored = { name: 'Casey', defaultMode: 'manual', endpoint: 'https://old-host' };
    expect(withoutStaleEndpoint(stored)).toEqual({ name: 'Casey', defaultMode: 'manual' });
  });

  it('leaves settings without one as they are', () => {
    expect(withoutStaleEndpoint({ name: 'Casey' })).toEqual({ name: 'Casey' });
  });
});
