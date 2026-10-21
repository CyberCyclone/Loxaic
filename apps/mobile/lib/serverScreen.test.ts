import { describe, expect, it } from 'vitest';
import { serverScreenView } from './serverScreen';

describe('serverScreenView', () => {
  it('tells a non-admin the settings are an administrator’s, whatever else is true', () => {
    expect(serverScreenView({ isAdmin: false, hasSettings: false, loadError: null })).toBe('readOnly');
    expect(serverScreenView({ isAdmin: false, hasSettings: true, loadError: 'x' })).toBe('readOnly');
  });

  it('spins only while the first request is on its way', () => {
    expect(serverScreenView({ isAdmin: true, hasSettings: false, loadError: null })).toBe('loading');
  });

  it('says a failed load failed, rather than spinning forever', () => {
    expect(serverScreenView({ isAdmin: true, hasSettings: false, loadError: "Can't reach your server" })).toBe('loadFailed');
  });

  it('keeps showing loaded settings when a later refresh fails', () => {
    expect(serverScreenView({ isAdmin: true, hasSettings: true, loadError: "Can't reach your server" })).toBe('settings');
  });
});
