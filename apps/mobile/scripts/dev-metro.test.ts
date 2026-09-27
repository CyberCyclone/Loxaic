import { describe, expect, it } from 'vitest';
import { decide, METRO_STATUS, probePort } from './dev-metro-core.mjs';

const answer = (status: number, body: string) =>
  (() => Promise.resolve(new Response(body, { status }))) as unknown as typeof fetch;

describe('probePort', () => {
  it('recognises Metro by its own status line', async () => {
    expect(await probePort('http://x', answer(200, METRO_STATUS))).toEqual({ kind: 'metro' });
  });

  it('calls anything else on the port something else, with its status', async () => {
    expect(await probePort('http://x', answer(404, 'Not Found'))).toEqual({ kind: 'other', status: 404 });
    expect(await probePort('http://x', answer(200, '<html>'))).toEqual({ kind: 'other', status: 200 });
  });

  it('calls a port nothing answers on free', async () => {
    const refused = (() => Promise.reject(new TypeError('fetch failed'))) as unknown as typeof fetch;
    expect(await probePort('http://x', refused)).toEqual({ kind: 'free' });
  });
});

describe('decide', () => {
  it('reuses a Metro that is already running rather than fighting it for the port', () => {
    expect(decide({ kind: 'metro' }, 8081).action).toBe('reuse');
  });

  it('starts one when the port is free', () => {
    expect(decide({ kind: 'free' }, 8081).action).toBe('start');
  });

  it('refuses, and says why, when something else holds the port', () => {
    const d = decide({ kind: 'other', status: 404 }, 8081);
    expect(d.action).toBe('refuse');
    expect(d.message).toContain(':8081');
    expect(d.message).toContain('Waiting for Metro');
  });
});
