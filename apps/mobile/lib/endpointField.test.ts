import { describe, expect, it } from 'vitest';
import { endpointField } from './endpointField';

describe('endpointField', () => {
  it('shows an address set from the sign-in screen', () => {
    // The picker writes only the override; nothing else knew about it.
    expect(
      endpointField({ override: 'https://pheonix.tail47eac7.ts.net', active: 'https://pheonix.tail47eac7.ts.net' }),
    ).toEqual({ value: 'https://pheonix.tail47eac7.ts.net', detected: null });
  });

  it('shows the override even while the app has not caught up with it', () => {
    // Saved a moment ago and still resolving, say: the field is what is
    // pinned, and nothing claims it was detected.
    expect(endpointField({ override: 'https://new.example.com', active: 'http://192.168.1.13:4100' })).toEqual({
      value: 'https://new.example.com',
      detected: null,
    });
  });

  it('ignores the copy Settings used to keep once the override is gone', () => {
    // An install whose `loxaic-settings` still holds an endpoint but whose
    // override was cleared (from the picker, or by Disconnect) is not using
    // that address. The copy is not an input, so all there is to go on is
    // the missing override: the field is empty and says what was detected.
    expect(endpointField({ override: null, active: 'http://localhost:4000' })).toEqual({
      value: '',
      detected: 'http://localhost:4000',
    });
  });

  it('says what auto-detection found, under an empty field', () => {
    expect(endpointField({ override: null, active: 'http://10.0.2.2:4000' })).toEqual({
      value: '',
      detected: 'http://10.0.2.2:4000',
    });
  });

  it('says nothing when nothing has been resolved yet', () => {
    expect(endpointField({ override: null, active: null })).toEqual({ value: '', detected: null });
  });

  it('treats a blank override as none', () => {
    expect(endpointField({ override: '  ', active: 'http://localhost:4000' })).toEqual({
      value: '',
      detected: 'http://localhost:4000',
    });
    expect(endpointField({ override: '', active: '' })).toEqual({ value: '', detected: null });
  });
});
