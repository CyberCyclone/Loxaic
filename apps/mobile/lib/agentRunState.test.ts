import { describe, expect, it } from 'vitest';
import type { StreamEventKind, StreamSnapshot } from '@loxaic/api-client';
import {
  IDLE_RUN,
  runLevelAfterEnd,
  runLevelAfterEvent,
  runLevelAfterRewind,
  runLevelFromSnapshot,
  runLevelOf,
  withPromotedRunLevel,
  withRunLevel,
  withoutRunLevel,
  type AgentRunLevel,
  type RunLevels,
} from './agentRunState';

const NOW = 1_000_000;

const ask: StreamEventKind = { kind: 'approval.request', call_id: 'call_0', tool: 'github__merge_pull_request', args: { n: 1 }, timeout_ms: 600_000 };

/** Folds events into a conversation's state, the way the hook does. */
function fold(levels: RunLevels, convId: string, events: StreamEventKind[], streamId = 's1'): RunLevels {
  return events.reduce((acc, ev) => withRunLevel(acc, convId, (prev) => runLevelAfterEvent(prev, ev, streamId, NOW)), levels);
}

describe('per-conversation run state', () => {
  it('keeps a background thread’s approval while another thread is on screen', () => {
    // A asks, the person opens B, B runs, then they come back to A.
    let levels = fold({}, 'A', [{ kind: 'iteration', n: 3, max: 100 }, ask]);
    levels = fold(levels, 'B', [{ kind: 'iteration', n: 1, max: 100 }, { kind: 'todos', todos: [{ text: 'x', status: 'pending' }] }], 's2');
    const a = runLevelOf(levels, 'A');
    expect(a.runState).toBe('awaiting_approval');
    expect(a.pendingApproval?.callId).toBe('call_0');
    expect(a.pendingApproval?.streamId).toBe('s1');
    expect(a.iteration).toEqual({ n: 3, max: 100 });
    expect(runLevelOf(levels, 'B').pendingApproval).toBeNull();
    expect(runLevelOf(levels, 'B').todos).toHaveLength(1);
    expect(a.todos).toHaveLength(0);
  });

  it('records an approval that arrives while its thread is not on screen', () => {
    // There is no "active" input at all: the event is about its conversation.
    const levels = fold({ A: { ...IDLE_RUN, runState: 'running' } }, 'A', [ask]);
    expect(runLevelOf(levels, 'A').runState).toBe('awaiting_approval');
  });

  it('is idle for a conversation nothing has been heard about, and for none', () => {
    expect(runLevelOf({}, 'A')).toBe(IDLE_RUN);
    expect(runLevelOf({ A: { ...IDLE_RUN, runState: 'running' } }, null)).toBe(IDLE_RUN);
  });

  it('closes an approval only on the result for that call', () => {
    let levels = fold({}, 'A', [ask]);
    levels = fold(levels, 'A', [{ kind: 'tool.result', message_id: 'm', call_id: 'call_other', tool: 't', output: '', ok: true }]);
    expect(runLevelOf(levels, 'A').pendingApproval?.callId).toBe('call_0');
    levels = fold(levels, 'A', [{ kind: 'tool.result', message_id: 'm', call_id: 'call_0', tool: 't', output: '', ok: true }]);
    expect(runLevelOf(levels, 'A').pendingApproval).toBeNull();
    expect(runLevelOf(levels, 'A').runState).toBe('running');
  });

  it('leaves the queue on any event but a queue update', () => {
    let levels = fold({}, 'A', [{ kind: 'run.queued', position: 2 }]);
    expect(runLevelOf(levels, 'A')).toMatchObject({ runState: 'queued', queuePosition: 2 });
    levels = fold(levels, 'A', [{ kind: 'run.queued', position: 1 }]);
    expect(runLevelOf(levels, 'A').queuePosition).toBe(1);
    levels = fold(levels, 'A', [{ kind: 'text.delta', message_id: 'm', text: 'hi' }]);
    expect(runLevelOf(levels, 'A')).toMatchObject({ runState: 'running', queuePosition: null });
  });

  it('does not touch the state for an event that changes nothing', () => {
    const levels = fold({}, 'A', [{ kind: 'iteration', n: 1, max: 100 }]);
    const after = fold(levels, 'A', [{ kind: 'text.delta', message_id: 'm', text: 'hi' }]);
    expect(after).toBe(levels);
  });

  it('asks and clears a step check-in, keeping the step count with it', () => {
    let levels = fold({}, 'A', [{ kind: 'steps.checkin', n: 100, max: 100, reason: 'budget', timeout_ms: 1000 }]);
    expect(runLevelOf(levels, 'A')).toMatchObject({ runState: 'awaiting_checkin', iteration: { n: 100, max: 100 } });
    expect(runLevelOf(levels, 'A').pendingCheckin?.deadline?.deadlineAt).toBe(NOW + 1000);
    levels = fold(levels, 'A', [{ kind: 'steps.decision', decision: 'continue', by: 'user' }]);
    expect(runLevelOf(levels, 'A')).toMatchObject({ runState: 'running', pendingCheckin: null });
  });

  it('ends a run without losing what it did', () => {
    const levels = fold({}, 'A', [{ kind: 'todos', todos: [{ text: 'x', status: 'completed' }] }, ask]);
    const ended = runLevelAfterEnd(runLevelOf(levels, 'A'), 'complete');
    expect(ended).toMatchObject({ runState: 'done', pendingApproval: null, pendingCheckin: null, iteration: null, queuePosition: null });
    expect(ended.todos).toHaveLength(1);
    expect(runLevelAfterEnd(IDLE_RUN, 'error').runState).toBe('error');
  });

  it('reads a parked run off a snapshot, on this device’s clock', () => {
    const snapshot: StreamSnapshot = {
      messages: [],
      iteration: { n: 4, max: 100 },
      queued: { position: 1 },
      pending_approval: { call_id: 'call_0', tool: 't', args: {}, timeout_ms: 600_000, expires_at: 5_000 },
    };
    // The server's clock reads 2,000 when this device's reads NOW.
    const level = runLevelFromSnapshot(snapshot, 'active', 's1', NOW, 2_000);
    // The approval outranks the queue: it is what the person can act on.
    expect(level.runState).toBe('awaiting_approval');
    expect(level.queuePosition).toBe(1);
    expect(level.pendingApproval).toMatchObject({ callId: 'call_0', streamId: 's1' });
    expect(level.pendingApproval?.deadline?.deadlineAt).toBe(NOW + 3_000);
  });

  it('reads the other snapshot states', () => {
    const base: StreamSnapshot = { messages: [] };
    expect(runLevelFromSnapshot({ ...base, pending_checkin: { n: 1, max: 1, reason: 'budget' } }, 'active', 's', NOW).runState).toBe('awaiting_checkin');
    expect(runLevelFromSnapshot({ ...base, queued: { position: 3 } }, 'active', 's', NOW).runState).toBe('queued');
    expect(runLevelFromSnapshot(base, 'active', 's', NOW).runState).toBe('running');
    expect(runLevelFromSnapshot(base, 'cancelled', 's', NOW).runState).toBe('done');
    expect(runLevelFromSnapshot(base, 'error', 's', NOW).runState).toBe('error');
  });

  it('drops a removed run’s prompt on a rewind, and the counters only when asked', () => {
    const asking = runLevelOf(fold({}, 'A', [{ kind: 'iteration', n: 2, max: 9 }, ask]), 'A');
    expect(runLevelAfterRewind(asking, new Set(['other']), false)).toBe(asking);
    const removed = runLevelAfterRewind(asking, new Set(['s1']), false);
    expect(removed.pendingApproval).toBeNull();
    expect(removed.iteration).toEqual({ n: 2, max: 9 });
    expect(runLevelAfterRewind(asking, new Set(), true)).toMatchObject({ iteration: null, todos: [] });
  });

  it('moves a placeholder’s state to the real id, unless the real id has its own', () => {
    const local: AgentRunLevel = { ...IDLE_RUN, runState: 'queued', queuePosition: 1 };
    expect(withPromotedRunLevel({ 'pending-x': local }, 'pending-x', 'real')).toEqual({ real: local });
    const own: AgentRunLevel = { ...IDLE_RUN, runState: 'running' };
    expect(withPromotedRunLevel({ 'pending-x': local, real: own }, 'pending-x', 'real')).toEqual({ real: own });
    const unchanged = { real: own };
    expect(withPromotedRunLevel(unchanged, 'pending-x', 'real')).toBe(unchanged);
  });

  it('forgets a deleted conversation', () => {
    const levels = fold({}, 'A', [ask]);
    expect(withoutRunLevel(levels, 'A')).toEqual({});
    expect(withoutRunLevel(levels, 'B')).toBe(levels);
  });
});
