import { describe, expect, it } from 'vitest';
import {
  PLAN_ACCEPTED_MESSAGE,
  PLAN_REJECTED_MESSAGE,
  acceptMode,
  isOpen,
  latestPlan,
  planOf,
  planStatus,
  planTitle,
  plansIn,
} from './plan';
import { reconstructMessages } from './streamMessages';
import type { Message } from './types';

/** `ok: 'unsent'` is a call whose result has not arrived — no `ok` at all. */
const planMsg = (callId: string, plan: string, ok: boolean | 'unsent' = true): Message => ({
  role: 'assistant',
  text: '',
  tools: [{ tool: 'propose_plan', summary: planTitle(plan), result: '', callId, plan, ...(ok === 'unsent' ? {} : { ok }) }],
});
const user = (text: string): Message => ({ role: 'user', text });

describe('planTitle', () => {
  it('takes the first line, without Markdown markers', () => {
    expect(planTitle('## Fix the login bug\n\n1. Read it')).toBe('Fix the login bug');
    expect(planTitle('\n\n1. **Read** the file')).toBe('Read the file');
    expect(planTitle('   ')).toBe('Plan');
  });

  it('caps a long first line', () => {
    expect(planTitle('x'.repeat(200))).toHaveLength(80);
  });
});

describe('planOf', () => {
  it('reads a plan only from a propose_plan call with one', () => {
    expect(planOf('propose_plan', { plan: '1. Go' })).toBe('1. Go');
    expect(planOf('propose_plan', { plan: '  ' })).toBeUndefined();
    expect(planOf('propose_plan', {})).toBeUndefined();
    expect(planOf('todo_write', { plan: '1. Go' })).toBeUndefined();
  });
});

describe('plansIn / latestPlan', () => {
  it('counts only a call the server accepted', () => {
    const msgs = [user('plan it'), planMsg('refused', '1. Go', false), planMsg('waiting', '1. Go', 'unsent'), planMsg('ok', '1. Go')];
    expect(plansIn(msgs).map((p) => p.callId)).toEqual(['ok']);
  });

  it('opens the newest of several', () => {
    const msgs = [user('plan'), planMsg('a', '# One'), user('more tests please'), planMsg('b', '# Two')];
    expect(latestPlan(msgs)).toEqual({ callId: 'b', text: '# Two', title: 'Two' });
  });

  it('is null in a thread with no plan', () => {
    expect(latestPlan([user('hello'), { role: 'assistant', text: 'hi' }])).toBeNull();
  });
});

describe('planStatus', () => {
  const base = [user('plan'), planMsg('a', '1. Go')];

  it('is pending until anyone says anything', () => {
    expect(planStatus(base, 'a')).toBe('pending');
  });

  it('reads a decision from the reply', () => {
    expect(planStatus([...base, user(PLAN_ACCEPTED_MESSAGE)], 'a')).toBe('accepted');
    expect(planStatus([...base, user(PLAN_REJECTED_MESSAGE)], 'a')).toBe('rejected');
  });

  it('is changes when something else was said and no new plan has come of it', () => {
    expect(planStatus([...base, user('Add a test step')], 'a')).toBe('changes');
  });

  it('is superseded once a newer plan exists, and the newer one is judged on its own', () => {
    const msgs = [...base, user('more tests'), planMsg('b', '# Two'), user(PLAN_ACCEPTED_MESSAGE)];
    expect(planStatus(msgs, 'a')).toBe('superseded');
    expect(planStatus(msgs, 'b')).toBe('accepted');
  });

  it('is null for a call that is not a plan', () => {
    expect(planStatus(base, 'nope')).toBeNull();
  });

  it('calls pending and changes open, and nothing else', () => {
    expect(['pending', 'changes', 'accepted', 'rejected', 'superseded', null].map((s) => isOpen(s as never))).toEqual([
      true, true, false, false, false, false,
    ]);
  });
});

describe('acceptMode', () => {
  it('runs in the default mode from Settings, and never in planning', () => {
    expect(acceptMode('auto')).toBe('auto');
    expect(acceptMode('manual')).toBe('manual');
    expect(acceptMode('planning')).toBe('manual');
  });
});

describe('a plan survives a reload', () => {
  it('is rebuilt from stored rows with its full text and status', () => {
    const plan = '## Plan\n\n1. Read\n2. Edit';
    const msgs = reconstructMessages([
      { id: 'u', conversationId: 'c', parentId: null, authorType: 'user', authorUserId: 'me', lamport: 1, content: [{ kind: 'text', text: 'plan it' }], status: 'complete' },
      { id: 'a', conversationId: 'c', parentId: 'u', authorType: 'assistant', lamport: 2, content: [{ kind: 'tool_call', call_id: 'k', tool: 'propose_plan', args: { plan } }], status: 'complete' },
      { id: 't', conversationId: 'c', parentId: 'a', authorType: 'tool', lamport: 3, content: [{ kind: 'tool_result', call_id: 'k', output: 'shown', ok: true }], status: 'complete' },
    ] as unknown as Parameters<typeof reconstructMessages>[0]);
    expect(latestPlan(msgs)).toEqual({ callId: 'k', text: plan, title: 'Plan' });
    expect(planStatus(msgs, 'k')).toBe('pending');
  });
});
