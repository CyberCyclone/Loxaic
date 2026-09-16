/**
 * Stop has to stop the run, and has to *say* it heard you — #113.
 *
 * Reported from real use as "when a session is running, the stop button does
 * nothing". Three separate things made that true, and this covers the two a
 * user can see:
 *
 *   - a run waiting at a permission prompt (manual mode, the default) used to
 *     sit for the full five-minute approval timeout after Stop, because the
 *     approval wait ignored the abort signal;
 *   - pressing Stop changed nothing on screen, so even a stop that landed
 *     looked like a dead button.
 *
 * The third — a batch of tool calls running to completion after a stop — is
 * covered server-side in `stop-abort.test.ts`, where the timing can be made
 * deterministic.
 */
import { browser } from '@wdio/globals';
import { apiToken, uniqueCreds } from '../helpers/auth.ts';
import { shot } from '../helpers/screenshot.ts';
import { tap, waitForTextIn, waitForVisible } from '../helpers/selectors.ts';
import {
  SLOW_PROMPT,
  TOOL_PROMPT,
  getToolResults,
  goToSurface,
  listConversations,
  listSandboxes,
  selectThread,
  sendMessage,
  signUp,
  startNewAgentRun,
  waitForRunDone,
} from '../helpers/app.ts';

const SLOW_TOOL_PROMPT = 'count slowly in the sandbox';

describe('stopping an agent run', () => {
  const creds = uniqueCreds();

  before(async () => {
    await signUp(creds);
  });

  it('acknowledges the press while a slow command is being killed, and ends the run', async function () {
    this.timeout(2 * 60_000);

    // The acknowledgement — "Stopping…" and the disabled stop control — lasts
    // from the tap until the stream ends. A mid-response stop is now over in
    // milliseconds (the mock aborts the way a real backend's fetch does, see
    // #116), so the only run that holds the state long enough to assert on is
    // one whose stop has real work to do: killing a command in the sandbox,
    // which takes the TERM→KILL grace plus two engine round trips.
    await goToSurface('agent');
    await tap('agent.mode.auto');
    await sendMessage(SLOW_TOOL_PROMPT);
    await waitForTextIn('agent.run.status', 'Running');
    const [conversation] = await listConversations(creds);
    const token = await apiToken(creds);
    // The command is in flight once the sandbox row exists: the mock's reply
    // is instant, and creating the container is what takes the time.
    await browser.waitUntil(async () => (await listSandboxes(token, conversation.id)).length > 0, {
      timeout: 60_000,
      timeoutMsg: 'the sandbox never appeared',
    });

    await tap('composer.stop');
    await waitForVisible('composer.stopping');
    await waitForTextIn('agent.run.status', 'Stopping');
    await shot('agent-stop-acknowledged');

    await waitForTextIn('agent.run.status', 'Done', 30_000);
    await waitForRunDone(creds, conversation.id, 30_000);
    await shot('agent-stop-done');
  });

  it('ends a mid-response run', async function () {
    this.timeout(2 * 60_000);

    await startNewAgentRun();
    await sendMessage(SLOW_PROMPT);
    await waitForTextIn('agent.run.status', 'Running');
    await tap('composer.stop');
    await waitForTextIn('agent.run.status', 'Done', 30_000);
    const [conversation] = await listConversations(creds);
    await waitForRunDone(creds, conversation.id, 30_000);
  });

  it('stops a run that is waiting at a permission prompt', async function () {
    this.timeout(2 * 60_000);

    await startNewAgentRun();
    await tap('agent.mode.manual');
    await sendMessage(TOOL_PROMPT);
    // Parked on the approval — where Stop used to do nothing for five minutes.
    await waitForVisible('agent.permission.bar');

    await tap('composer.stop');
    await waitForTextIn('agent.run.status', 'Done', 30_000);
    await shot('agent-stop-at-approval');

    const [conversation] = await listConversations(creds);
    await waitForRunDone(creds, conversation.id, 30_000);

    // The tool never ran: stopping at the prompt is a denial, not a delayed
    // approval. No sandbox is created for a run that never executed a tool.
    const token = await apiToken(creds);
    const sandboxes = await listSandboxes(token, conversation.id);
    expect(sandboxes.length).toBe(0);
  });

  it('still shows a stopped tool call as failed once the thread is reopened', async function () {
    this.timeout(2 * 60_000);

    // A stopped call is the cheapest real failure to produce: refused at the
    // approval, so no sandbox and no Docker involved.
    await startNewAgentRun();
    await tap('agent.mode.manual');
    await sendMessage(TOOL_PROMPT);
    await waitForVisible('agent.permission.bar');
    await tap('composer.stop');
    await waitForTextIn('agent.run.status', 'Done', 30_000);

    const [conversation] = await listConversations(creds);
    await waitForRunDone(creds, conversation.id, 30_000);

    // The verdict is persisted, not merely streamed — the half that was
    // missing, and the only reason the assertion below can survive a reload.
    const results = await getToolResults(creds, conversation.id);
    expect(results).toHaveLength(1);
    expect(results[0].ok).toBe(false);

    const marker = `chat.toolCall.failed.${results[0].call_id}`;
    await waitForVisible(marker);
    await shot('agent-stop-tool-failed');

    // Leaving the surface and selecting the thread again rebuilds it from
    // REST rather than from the stream. That is exactly where the failure
    // used to disappear: the card came back looking like a success.
    await goToSurface('chat');
    await goToSurface('agent');
    await selectThread(conversation.id, 'agent');
    await waitForVisible(marker);
    await shot('agent-stop-tool-failed-after-reload');
  });
});
