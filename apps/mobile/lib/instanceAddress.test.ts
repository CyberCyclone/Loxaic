import { describe, expect, it } from 'vitest';
import type { InstanceState } from './endpoint';
import { desktopServerAddress } from './instanceAddress';

const base: InstanceState = {
  mode: null,
  storedMode: null,
  apiBaseUrl: null,
  needsOnboarding: false,
  defaultHostName: 'mac',
  defaultPort: 4100,
  lanAddress: null,
  instanceId: 'i',
  host: null,
  client: null,
  listenPort: null,
  effectiveAdvertiseUrl: null,
  defaultTailnetHostname: 'loxaic-mac',
  hasTailnetAuthKey: false,
  tailnet: { state: 'off', mode: null, authUrl: null, url: null, funnel: false, error: null, status: null },
};

const tsnetClient: InstanceState = {
  ...base,
  mode: 'client',
  storedMode: 'client',
  // The sidecar's loopback proxy: where requests go, not what anyone typed.
  apiBaseUrl: 'http://127.0.0.1:49216',
  client: { hostUrl: 'https://pheonix.tail47eac7.ts.net', via: 'tsnet', controlUrl: null },
};

describe('desktopServerAddress', () => {
  it('names a Tailscale client by its host, not the loopback proxy', () => {
    expect(desktopServerAddress(tsnetClient)).toBe('https://pheonix.tail47eac7.ts.net');
  });

  it('falls back to the API URL for a client with no client section', () => {
    expect(desktopServerAddress({ ...tsnetClient, client: null })).toBe('http://127.0.0.1:49216');
  });

  it('names a host by what it advertises, the tailnet address first', () => {
    const host: InstanceState = {
      ...base,
      mode: 'host',
      storedMode: 'host',
      apiBaseUrl: 'http://127.0.0.1:4100',
      host: { name: 'Studio', port: 4100, bind: 'lan', advertiseUrl: 'http://192.168.1.20:4100', db: { kind: 'embedded' }, tailnet: null },
    };
    expect(desktopServerAddress(host)).toBe('http://192.168.1.20:4100');
    expect(desktopServerAddress({ ...host, effectiveAdvertiseUrl: 'https://studio.tail1234.ts.net' })).toBe(
      'https://studio.tail1234.ts.net',
    );
  });

  it('names solo by its own address', () => {
    expect(desktopServerAddress({ ...base, mode: 'solo', storedMode: 'solo', apiBaseUrl: 'http://127.0.0.1:4100' })).toBe(
      'http://127.0.0.1:4100',
    );
  });

  it('still names the host while the stack is down', () => {
    expect(desktopServerAddress({ ...tsnetClient, mode: null })).toBe('https://pheonix.tail47eac7.ts.net');
  });

  it('is null off the desktop and before a mode is chosen', () => {
    expect(desktopServerAddress(null)).toBeNull();
    expect(desktopServerAddress(base)).toBeNull();
  });
});
