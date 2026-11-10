/**
 * A run's waiting prompt survives a switch to another thread and back.
 *
 * The agent screen kept one run's state — its status, a pending approval, the
 * step counter, the to-do list — as a single value for "the
 * thread on screen". Opening another thread cleared it, events for a thread
 * in the background were dropped, and coming back asked for no snapshot (the
 * socket had subscribed to that conversation already). On the beta, a run
 * asking to use an MCP tool came back as "Done" with no prompt, parked on the
 * server waiting for an answer nobody could give.
 *
 * Each case is checked both ways: the prompt is back on its own thread, and
 * it is not shown on the other one.
 */
import { browser, expect } from '@wdio/globals';
import { apiToken, uniqueCreds } from '../helpers/auth.ts';
import { BASE_URL } from '../../scripts/standup.ts';
import { shot } from '../helpers/screenshot.ts';
import { isVisible, tap, waitForAbsent, waitForFreshText, waitForTextIn, waitForVisible } from '../helpers/selectors.ts';
import {
  REVIEW_LINGER_DONE,
  REVIEW_LINGER_PROMPT,
  MOCK_TOOL_DONE,
  TOOL_PROMPT,
  getMessageTexts,
  goToSurface,
  listConversations,
  patchPrefs,
  selectThread,
  sendMessage,
  signUp,
  startNewAgentRun,
  waitForRunDone,
} from '../helpers/app.ts';

/** The mock waits eight seconds, then asks for fs_write: long enough to be
 * on another thread when the question arrives. */
const SLOW_TOOL_PROMPT = `take your time and ${TOOL_PROMPT}`;

describe('switching agent threads while a run is waiting', () => {
  const creds = uniqueCreds();
  /** A finished run to switch to. */
  let other = '';

  async function messagesJson(id: string): Promise<string> {
    const res = await fetch(`${BASE_URL}/v1/conversations/${id}/messages`, {
      headers: { authorization: `Bearer ${await apiToken(creds)}` },
    });
    if (!res.ok) throw new Error(`[e2e] GET messages failed (${String(res.status)})`);
    return JSON.stringify(await res.json());
  }

  /** Starts a run and returns its conversation id once the server has one. */
  async function startRun(mode: 'manual' | 'auto', prompt: string): Promise<string> {
    const before = new Set((await listConversations(creds)).map((c) => c.id));
    await startNewAgentRun();
    await tap(`agent.mode.${mode}`);
    await sendMessage(prompt);
    let id: string | undefined;
    await browser.waitUntil(
      async () => {
        id = (await listConversations(creds)).find((c) => !before.has(c.id))?.id;
        return id !== undefined;
      },
      { timeout: 30_000, timeoutMsg: '[e2e] the new run never appeared' },
    );
    if (!id) throw new Error('[e2e] no new run');
    return id;
  }

  before(async () => {
    await signUp(creds);
    await goToSurface('agent');
    other = await startRun('manual', 'hello there');
    await waitForRunDone(creds, other, 60_000);
  });

  after(async () => {
    await patchPrefs(creds, { progressCheckSteps: null });
  });

  it('brings an approval back to its thread, and keeps it off the other one', async function () {
    this.timeout(4 * 60_000);
    const asking = await startRun('manual', TOOL_PROMPT);
    await waitForVisible('agent.permission.bar');
    await waitForTextIn('agent.run.status', 'Awaiting approval');

    await selectThread(other, 'agent');
    // Another thread's prompt is not this one's.
    await waitForAbsent('agent.permission.bar');
    await waitForTextIn('agent.run.status', 'Done');
    await shot('agent-switch-other-thread');

    await selectThread(asking, 'agent');
    await waitForVisible('agent.permission.bar');
    await waitForTextIn('agent.run.status', 'Awaiting approval');
    await shot('agent-switch-approval-back');

    // And it still answers the run that asked.
    await tap('agent.permission.allow');
    await waitForTextIn('chat.messageList', MOCK_TOOL_DONE);
    await waitForAbsent('agent.permission.bar');
    await waitForRunDone(creds, asking, 60_000);
  });

  it('shows an approval that was asked while its thread was in the background', async function () {
    this.timeout(4 * 60_000);
    const asking = await startRun('manual', SLOW_TOOL_PROMPT);
    // Away before the question is asked.
    await selectThread(other, 'agent');

    // The tool call is stored just before the approval is asked.
    await browser.waitUntil(async () => (await messagesJson(asking)).includes('"fs_write"'), {
      timeout: 60_000,
      timeoutMsg: '[e2e] the run never asked for fs_write',
    });
    await browser.pause(1_000);
    expect(await isVisible('agent.permission.bar')).toBe(false);

    await selectThread(asking, 'agent');
    await waitForVisible('agent.permission.bar');
    await waitForTextIn('agent.run.status', 'Awaiting approval');
    await shot('agent-switch-approval-asked-away');

    await tap('agent.permission.deny');
    await waitForAbsent('agent.permission.bar');
    await waitForRunDone(creds, asking, 60_000);
  });

  it("brings a progress review's status back to its thread, and keeps it off the other one", async function () {
    this.timeout(4 * 60_000);
    // Reviewed after three steps; the mock's reviewer takes twelve seconds.
    await patchPrefs(creds, { progressCheckSteps: 3 });
    const reviewing = await startRun('auto', REVIEW_LINGER_PROMPT);
    await waitForFreshText('run.review.status', 'Paused to check progress', 90_000);

    await selectThread(other, 'agent');
    await waitForAbsent('run.review.status');

    await selectThread(reviewing, 'agent');
    await waitForFreshText('run.review.status', 'Paused to check progress');
    await shot('agent-switch-review-back');

    await waitForRunDone(creds, reviewing, 90_000);
    await waitForAbsent('run.review.status');
    if (!(await getMessageTexts(creds, reviewing)).some((t) => t.includes(REVIEW_LINGER_DONE))) {
      throw new Error('the run did not finish its drill after the review');
    }
  });
});
