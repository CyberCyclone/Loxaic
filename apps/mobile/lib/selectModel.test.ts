import { describe, expect, it } from 'vitest';
import { pickSelectedModel } from './selectModel';

const LOCAL = 'qwen3-local';
const PAID = 'openrouter::anthropic/claude';
const known = (ref: string) => ref === LOCAL || ref === PAID;

const base = {
  prefModel: null,
  hasConversation: false,
  pendingModel: null,
  recentModels: [] as string[],
  modelsLoaded: true,
  isKnown: known,
  defaultModelId: LOCAL,
};

describe('pickSelectedModel', () => {
  it('opens a new conversation on the model last sent with', () => {
    expect(pickSelectedModel({ ...base, recentModels: [PAID, LOCAL] })).toBe(PAID);
  });

  it('never moves an existing conversation onto the last-used model', () => {
    // The review finding this function exists for. An old thread has an id and
    // no stored model — every thread from before `model_pref` was written, or
    // from another client. "Last used anywhere" would point its composer at a
    // paid provider the moment its owner tried one in a different chat, with
    // nothing on screen saying it had moved.
    expect(pickSelectedModel({ ...base, hasConversation: true, recentModels: [PAID] })).toBe(LOCAL);
  });

  it("keeps a conversation's own model ahead of everything", () => {
    expect(
      pickSelectedModel({ ...base, hasConversation: true, prefModel: PAID, recentModels: [LOCAL] }),
    ).toBe(PAID);
  });

  it('prefers a picker choice over recents for a new conversation', () => {
    expect(pickSelectedModel({ ...base, pendingModel: LOCAL, recentModels: [PAID] })).toBe(LOCAL);
  });

  it('skips a recent model that is no longer offered', () => {
    // Its provider was deleted, or an admin narrowed the allowlist.
    expect(pickSelectedModel({ ...base, recentModels: ['gone::model', PAID] })).toBe(PAID);
    expect(pickSelectedModel({ ...base, recentModels: ['gone::model'] })).toBe(LOCAL);
  });

  it('does not trust recents before the model list has loaded', () => {
    // Nothing is "known" yet, so a recent cannot be confirmed as still offered.
    expect(pickSelectedModel({ ...base, modelsLoaded: false, recentModels: [PAID] })).toBe(LOCAL);
  });

  it('keeps a stored model while the list is still loading', () => {
    // An unloaded list cannot say the model is gone.
    expect(
      pickSelectedModel({ ...base, hasConversation: true, modelsLoaded: false, prefModel: PAID, isKnown: () => false }),
    ).toBe(PAID);
  });

  it('drops a stored model the list no longer offers', () => {
    expect(
      pickSelectedModel({ ...base, hasConversation: true, prefModel: 'gone::model' }),
    ).toBe(LOCAL);
  });

  it('is empty rather than invented when there is nothing to offer', () => {
    expect(pickSelectedModel({ ...base, defaultModelId: null })).toBe('');
  });
});
