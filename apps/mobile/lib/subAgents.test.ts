import { describe, expect, it } from 'vitest';
import type { SubAgentEvent, SubAgentLive } from '@loxaic/types';
import {
  applySubAgentEvent,
  applySubAgentSnapshot,
  childConversationIds,
  firstChildApproval,
  formatDuration,
  listedSubAgents,
  mergeListedSubAgents,
  runningCount,
  subAgentContextPercent,
  subAgentCounterSince,
  subAgentDescriptionOf,
  subAgentDurationMs,
  subAgentForCall,
  subAgentRunState,
  subAgentSpeed,
  subAgentStatusLabel,
  type SubAgentsByParent,
} from './subAgents';

const PARENT = 'parent-conv';
const NOW = 1_000_000;

const started = (id: string, over: Partial<Extract<SubAgentEvent, { kind: 'subagent.started' }>> = {}): SubAgentEvent => ({
  kind: 'subagent.started',
  message_id: 'm1',
  call_id: `call-${id}`,
  conversation_id: id,
  stream_id: `stream-${id}`,
  description: `Task ${id}`,
  model: 'model',
  started_at: 500,
  ...over,
});

const live = (id: string, over: Partial<SubAgentLive> = {}): SubAgentLive => ({
  conversation_id: id,
  stream_id: `stream-${id}`,
  message_id: 'm1',
  call_id: `call-${id}`,
  description: `Task ${id}`,
  model: 'model',
  started_at: 500,
  status: 'running',
  state: 'running',
  ...over,
});

const fold = (events: SubAgentEvent[], now = NOW, from: SubAgentsByParent = {}): SubAgentsByParent =>
  events.reduce((state, e) => applySubAgentEvent(state, PARENT, e, now), from);

describe('a parent stream\'s sub-agent events', () => {
  it('starts a child, timed from the moment this device heard of it', () => {
    const [a] = fold([started('a')])[PARENT] ?? [];
    // A live event is taken as just emitted: the server's clock (500) is not
    // this device's, and counting from it would be off by the whole skew.
    expect(a).toMatchObject({ status: 'running', state: 'queued', startedLocal: NOW });
  });

  it('keeps that start, and an approval\'s deadline, across later reports', () => {
    const approval = { stream_id: 'stream-a', call_id: 'c1', tool: 'fs_write', args: { path: 'x' }, timeout_ms: 60_000, expires_at: 9 };
    let state = fold([started('a')], NOW);
    state = applySubAgentEvent(state, PARENT, { kind: 'subagent.progress', conversation_id: 'a', state: 'awaiting_approval', pending_approval: approval }, NOW + 1_000);
    const first = state[PARENT]?.[0];
    expect(first?.approval).toMatchObject({ streamId: 'stream-a', callId: 'c1', tool: 'fs_write' });
    expect(first?.approval?.deadline?.deadlineAt).toBe(NOW + 1_000 + 60_000);
    // An unrelated report arrives two seconds on. Neither clock restarts: the
    // elapsed counter would jump and the countdown would gain two seconds.
    state = applySubAgentEvent(state, PARENT, { kind: 'subagent.progress', conversation_id: 'a', tokens_out: 9 }, NOW + 3_000);
    expect(state[PARENT]?.[0]).toMatchObject({ startedLocal: NOW, tokens_out: 9 });
    expect(state[PARENT]?.[0]?.approval?.deadline?.deadlineAt).toBe(NOW + 61_000);
    // Answered: the approval goes.
    state = applySubAgentEvent(state, PARENT, { kind: 'subagent.progress', conversation_id: 'a', state: 'running', pending_approval: null }, NOW + 4_000);
    expect(state[PARENT]?.[0]?.approval).toBeUndefined();
  });

  it('does not rebuild the state for a report about a child it never heard start', () => {
    const state: SubAgentsByParent = {};
    expect(applySubAgentEvent(state, PARENT, { kind: 'subagent.progress', conversation_id: 'ghost', state: 'running' }, NOW)).toBe(state);
  });

  it('keeps each parent\'s children apart', () => {
    let state = fold([started('a')]);
    state = applySubAgentEvent(state, 'other-parent', started('b'), NOW);
    expect(state[PARENT]?.map((s) => s.conversation_id)).toEqual(['a']);
    expect(state['other-parent']?.map((s) => s.conversation_id)).toEqual(['b']);
    expect([...childConversationIds(state)].sort()).toEqual(['a', 'b']);
  });
});

describe('a snapshot after a reconnect', () => {
  it('times a running child from its real start, corrected for this device\'s clock', () => {
    // The server says: it is now 10_000 and the child began at 4_000 — six
    // seconds ago, whatever this device's clock reads.
    const state = applySubAgentSnapshot({}, PARENT, [live('a', { started_at: 4_000 })], NOW, 10_000);
    expect(state[PARENT]?.[0].startedLocal).toBe(NOW - 6_000);
  });

  it('converts a pending approval\'s deadline with the server\'s clock', () => {
    const state = applySubAgentSnapshot(
      {},
      PARENT,
      [live('a', { state: 'awaiting_approval', pending_approval: { stream_id: 'stream-a', call_id: 'c1', tool: 'bash', args: {}, timeout_ms: 600_000, expires_at: 70_000 } })],
      NOW,
      10_000,
    );
    // 60 s left on the server's clock is 60 s left on this one.
    expect(state[PARENT]?.[0].approval?.deadline?.deadlineAt).toBe(NOW + 60_000);
  });

  it('never brings back to running a child this device has already seen end', () => {
    const ended = fold([started('a'), { kind: 'subagent.ended', conversation_id: 'a', status: 'complete', ended_at: 900 }]);
    // A snapshot read a moment before the end, delivered a moment after it.
    const state = applySubAgentSnapshot(ended, PARENT, [live('a')], NOW, NOW);
    expect(state[PARENT]?.[0].status).toBe('complete');
  });

  it('replaces the children it names and leaves the thread\'s others alone', () => {
    const before = fold([started('a'), started('b')]);
    const state = applySubAgentSnapshot(before, PARENT, [live('a', { status: 'complete', state: undefined, ended_at: 800, tokens_out: 12 })], NOW, NOW);
    expect(state[PARENT]?.find((s) => s.conversation_id === 'a')).toMatchObject({ status: 'complete', tokens_out: 12, startedLocal: NOW });
    expect(state[PARENT]?.find((s) => s.conversation_id === 'b')?.status).toBe('running');
  });

  it('changes nothing for a run that spawned none', () => {
    const state = fold([started('a')]);
    expect(applySubAgentSnapshot(state, PARENT, undefined, NOW)).toBe(state);
    expect(applySubAgentSnapshot(state, PARENT, [], NOW)).toBe(state);
  });
});

describe('the stored listing after a reload', () => {
  const finished = (id: string, over: Partial<SubAgentLive> = {}) =>
    live(id, { status: 'complete', state: undefined, ended_at: 2_500, context_used: 700, window_tokens: 8_192, last_gen_tps: 40, last_prompt_tps: null, tokens_out: 70, ...over });

  it('adds children this device has never heard of', () => {
    const state = mergeListedSubAgents({}, PARENT, [finished('a')], NOW);
    expect(state[PARENT]?.[0]).toMatchObject({ conversation_id: 'a', status: 'complete', context_used: 700 });
  });

  it('times a running child from its real start, not from when the listing arrived', () => {
    // Started six minutes ago on the server's clock, which runs 40 s ahead of
    // this device's. The listing lands before any snapshot does, and the
    // start worked out here is the one the counter keeps.
    const serverNow = 5_000_000;
    const row = live('a', { started_at: serverNow - 360_000 });
    const merged = mergeListedSubAgents({}, PARENT, [row], NOW, serverNow);
    expect(merged[PARENT]?.[0].startedLocal).toBe(NOW - 360_000);
    // A later snapshot does not move it.
    const after = applySubAgentSnapshot(merged, PARENT, [row], NOW + 50, serverNow + 50);
    expect(after[PARENT]?.[0].startedLocal).toBe(NOW - 360_000);
  });

  it('ends a child whose end was missed, keeping what it measured live', () => {
    let state = fold([started('a')]);
    state = applySubAgentEvent(state, PARENT, { kind: 'subagent.progress', conversation_id: 'a', state: 'awaiting_approval', context_used: 999, pending_approval: { stream_id: 'stream-a', call_id: 'c', tool: 'bash', args: {} } }, NOW);
    state = mergeListedSubAgents(state, PARENT, [finished('a', { status: 'cancelled', context_used: 5 })], NOW);
    const a = state[PARENT]?.[0];
    expect(a).toMatchObject({ status: 'cancelled', ended_at: 2_500, context_used: 999 });
    // No question is waiting on a child that has ended.
    expect(a?.approval).toBeUndefined();
    expect(a?.pending_approval).toBeUndefined();
    expect(a?.state).toBeUndefined();
  });

  it('never overwrites a running child\'s live figures with the stored ones', () => {
    let state = fold([started('a')]);
    state = applySubAgentEvent(state, PARENT, { kind: 'subagent.progress', conversation_id: 'a', state: 'running', context_used: 999 }, NOW);
    const merged = mergeListedSubAgents(state, PARENT, [live('a', { context_used: 5 })], NOW);
    expect(merged).toBe(state);
  });

  it('never brings an ended child back to running', () => {
    const state = fold([started('a'), { kind: 'subagent.ended', conversation_id: 'a', status: 'complete', ended_at: 900 }]);
    expect(mergeListedSubAgents(state, PARENT, [live('a')], NOW)[PARENT]?.[0].status).toBe('complete');
  });

  it('fills in only the figures a finished child is missing', () => {
    const state = fold([started('a'), { kind: 'subagent.ended', conversation_id: 'a', status: 'complete', ended_at: 900 }]);
    const merged = mergeListedSubAgents(state, PARENT, [finished('a')], NOW);
    expect(merged[PARENT]?.[0]).toMatchObject({ ended_at: 900, context_used: 700, last_gen_tps: 40, tokens_out: 70 });
    // "Not reported" stays null: never turned into a 0 that would read as a rate.
    expect(merged[PARENT]?.[0].last_prompt_tps).toBeNull();
  });
});

describe('finding a call\'s sub-agent', () => {
  const list = (fold([
    started('a', { message_id: 'm1', call_id: 'call_0' }),
    started('b', { message_id: 'm2', call_id: 'call_0' }),
    started('c', { message_id: 'm2', call_id: 'call_1' }),
  ])[PARENT]) ?? [];

  it('uses the message and the call id together, since a model\'s call ids repeat', () => {
    expect(subAgentForCall(list, 'call_0', 'm1')?.conversation_id).toBe('a');
    expect(subAgentForCall(list, 'call_0', 'm2')?.conversation_id).toBe('b');
  });

  it('never binds a known message\'s call to another message\'s child', () => {
    // Turn 3 reuses `call_1`, which so far only message m2's child has. Its
    // card has its message id in hand: it has no child yet (or never will,
    // when the call was refused) — it is not child c.
    expect(subAgentForCall(list, 'call_1', 'm3')).toBeUndefined();
    expect(subAgentForCall(list, 'call_0', 'm3')).toBeUndefined();
  });

  it('falls back to the call id only when it names one child', () => {
    expect(subAgentForCall(list, 'call_1', undefined)?.conversation_id).toBe('c');
    expect(subAgentForCall(list, 'call_0', undefined)).toBeUndefined();
    expect(subAgentForCall(list, undefined, 'm1')).toBeUndefined();
    expect(subAgentForCall(undefined, 'call_0', 'm1')).toBeUndefined();
  });
});

describe('a call\'s label before its child is known', () => {
  it('cuts an unlabelled task by character, as the server does', () => {
    const label = subAgentDescriptionOf('subagent', { prompt: `${'x'.repeat(78)}😀 and then more` });
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(label ?? '')).toBe(false);
    expect(label?.endsWith('😀…')).toBe(true);
  });
});

describe('what the parent\'s screen shows', () => {
  it('asks about the child that has been waiting longest, one at a time', () => {
    const approval = (id: string) => ({ stream_id: `stream-${id}`, call_id: 'c', tool: 'bash', args: {} });
    let state = fold([started('late', { started_at: 900 }), started('early', { started_at: 100 }), started('quiet')]);
    for (const id of ['late', 'early']) {
      state = applySubAgentEvent(state, PARENT, { kind: 'subagent.progress', conversation_id: id, state: 'awaiting_approval', pending_approval: approval(id) }, NOW);
    }
    expect(firstChildApproval(state[PARENT])?.conversation_id).toBe('early');
    expect(firstChildApproval(fold([started('quiet')])[PARENT])).toBeUndefined();
    expect(firstChildApproval(undefined)).toBeUndefined();
  });

  it('lists running children first, then finished', () => {
    const state = fold([
      started('done', { started_at: 900 }),
      started('going', { started_at: 100 }),
      { kind: 'subagent.ended', conversation_id: 'done', status: 'error', ended_at: 950 },
    ]);
    expect(listedSubAgents(state[PARENT]).map((s) => s.conversation_id)).toEqual(['going', 'done']);
    expect(runningCount(state[PARENT])).toBe(1);
    expect(runningCount(undefined)).toBe(0);
  });
});

describe('what a card says', () => {
  it('names the state in one line', () => {
    expect(subAgentStatusLabel({ status: 'running', state: 'running' })).toBe('Running');
    expect(subAgentStatusLabel({ status: 'running', state: 'queued', queue_position: 2 })).toBe('Queued · #2');
    expect(subAgentStatusLabel({ status: 'running', state: 'queued' })).toBe('Queued');
    expect(subAgentStatusLabel({ status: 'running', state: 'awaiting_approval' })).toBe('Waiting for approval');
    expect(subAgentStatusLabel({ status: 'complete' })).toBe('Finished');
    expect(subAgentStatusLabel({ status: 'cancelled' })).toBe('Stopped');
    expect(subAgentStatusLabel({ status: 'error' })).toBe('Failed');
    expect(subAgentRunState({ status: 'cancelled' })).toBe('stopped');
    expect(subAgentRunState({ status: 'running' })).toBe('running');
  });

  it('shows the context only when both figures are known', () => {
    expect(subAgentContextPercent({ context_used: 2_048, window_tokens: 8_192 })).toBe(25);
    expect(subAgentContextPercent({ context_used: 9_000, window_tokens: 8_192 })).toBe(100);
    expect(subAgentContextPercent({ context_used: null, window_tokens: 8_192 })).toBeNull();
    expect(subAgentContextPercent({ context_used: 100, window_tokens: null })).toBeNull();
    expect(subAgentContextPercent({})).toBeNull();
  });

  it('shows a speed only when the backend reported one — never a derived or zero rate', () => {
    expect(subAgentSpeed({ last_gen_tps: 31.44, last_prompt_tps: 250 })).toBe('31.4 tok/s · 250 tok/s prompt');
    expect(subAgentSpeed({ last_gen_tps: 31.44, last_prompt_tps: null })).toBe('31.4 tok/s');
    expect(subAgentSpeed({ last_gen_tps: null, last_prompt_tps: null })).toBeNull();
    expect(subAgentSpeed({ last_gen_tps: 0 })).toBeNull();
    expect(subAgentSpeed({})).toBeNull();
  });

  it('gives a finished child\'s length from its own start and end', () => {
    expect(subAgentDurationMs({ started_at: 1_000, ended_at: 13_300 })).toBe(12_300);
    expect(subAgentDurationMs({ started_at: 1_000 })).toBeNull();
    expect(formatDuration(12_300)).toBe('12.3s');
    expect(formatDuration(245_000)).toBe('4m 05s');
  });

  it('labels a call by its description, or by its task when it has none', () => {
    expect(subAgentDescriptionOf('subagent', { description: ' Find the bug ', prompt: 'p' })).toBe('Find the bug');
    expect(subAgentDescriptionOf('subagent', { prompt: 'Read\nthe docs' })).toBe('Read the docs');
    expect(subAgentDescriptionOf('subagent', {})).toBe('Sub-agent');
    expect(subAgentDescriptionOf('bash', { description: 'x' })).toBeUndefined();
  });
});

describe('queue wait, then running time', () => {
  const queued = (id: string): SubAgentEvent => ({ kind: 'subagent.progress', conversation_id: id, state: 'queued', queue_position: 1 });
  const admitted = (id: string, at: number): SubAgentEvent => ({ kind: 'subagent.progress', conversation_id: id, state: 'running', iteration: 1, admitted_at: at });

  it('counts the wait from creation while a child is queued', () => {
    const state = fold([started('b'), queued('b')], NOW);
    const b = state[PARENT]?.[0];
    expect(b).toMatchObject({ state: 'queued', queue_position: 1 });
    expect(b && subAgentCounterSince(b)).toBe(NOW);
  });

  it('starts again from its admission, not from its creation 100 s earlier', () => {
    let state = fold([started('b'), queued('b')], NOW);
    state = applySubAgentEvent(state, PARENT, admitted('b', 600), NOW + 100_000);
    const b = state[PARENT]?.[0];
    expect(b).toMatchObject({ state: 'running', admitted_at: 600, startedLocal: NOW, runningLocal: NOW + 100_000 });
    expect(b && subAgentCounterSince(b)).toBe(NOW + 100_000);
  });

  it('keeps counting its running time when it goes back in line after running', () => {
    let state = fold([started('b')], NOW);
    state = applySubAgentEvent(state, PARENT, admitted('b', 600), NOW + 1_000);
    state = applySubAgentEvent(state, PARENT, queued('b'), NOW + 20_000);
    expect(subAgentCounterSince((state[PARENT] ?? [])[0])).toBe(NOW + 1_000);
  });

  it('converts the admission with the server\'s clock after a reconnect', () => {
    // Admitted 30 s before the server sent the snapshot.
    const state = applySubAgentSnapshot({}, PARENT, [live('b', { started_at: 4_000, admitted_at: 70_000 })], NOW, 100_000);
    expect(state[PARENT]?.[0]).toMatchObject({ startedLocal: NOW - 96_000, runningLocal: NOW - 30_000 });
  });

  it('converts it from the listing too, and a queued child stays queued', () => {
    const state = mergeListedSubAgents(
      {},
      PARENT,
      [live('a', { started_at: 4_000, admitted_at: 70_000 }), live('b', { started_at: 90_000, state: 'queued' })],
      NOW,
      100_000,
    );
    const [a, b] = state[PARENT] ?? [];
    expect(subAgentCounterSince(a)).toBe(NOW - 30_000);
    expect(b).toMatchObject({ state: 'queued' });
    expect(subAgentCounterSince(b)).toBe(NOW - 10_000);
  });

  it('takes the admission from the listing for a child whose end it missed', () => {
    let state = fold([started('a')]);
    state = mergeListedSubAgents(state, PARENT, [live('a', { status: 'complete', state: undefined, admitted_at: 700, ended_at: 2_500 })], NOW);
    expect(subAgentDurationMs((state[PARENT] ?? [])[0])).toBe(1_800);
  });

  it('counts from creation for an older server, which reports no admission', () => {
    const state = fold([started('b'), { kind: 'subagent.progress', conversation_id: 'b', state: 'running', iteration: 1 }], NOW);
    expect(subAgentCounterSince((state[PARENT] ?? [])[0])).toBe(NOW);
  });

  it('reports running time as a finished child\'s length, not its wait', () => {
    expect(subAgentDurationMs({ started_at: 1_000, admitted_at: 101_000, ended_at: 113_300 })).toBe(12_300);
    // Never admitted (stopped while queued): from creation.
    expect(subAgentDurationMs({ started_at: 1_000, ended_at: 5_000 })).toBe(4_000);
  });
});
