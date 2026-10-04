/**
 * Sub-agents: an agent hands part of its work to a child agent, and a person
 * can watch it, open it, stop it and answer it.
 *
 * What each case holds, and why it would not be noticed otherwise:
 *
 *   - The **card** shows that a sub-agent is running, on which model, how full
 *     its context is, for how long and how fast. Every one of those comes from
 *     the child's own requests, mirrored onto the parent's stream — a card that
 *     only ever said "Running" would pass a test that looked for the card.
 *   - The **panel** is the child's own transcript, streaming. It is a second
 *     message list over the parent's thread, fed by a second stream on the
 *     same socket; routed wrongly, the child's messages land in the parent's
 *     thread or nowhere.
 *   - **Stop** on a sub-agent ends that sub-agent and leaves its parent
 *     running. The opposite — the parent stopping too, or the child carrying
 *     on — is what a shared abort would do.
 *   - A sub-agent's **approval** appears where the parent's would, says which
 *     sub-agent is asking, and the answer reaches the child's run.
 *   - The **⋮ list** has the running ones first, then the finished, and a
 *     reload brings the cards and the list back from what is stored.
 */
import { browser } from '@wdio/globals';
import { apiToken, uniqueCreds, type Credentials } from '../helpers/auth.ts';
import { shot } from '../helpers/screenshot.ts';
import { platform, tap, waitForAbsent, waitForTextIn, waitForVisible } from '../helpers/selectors.ts';
import {
  APPROVAL_SUBAGENT_PROMPT,
  LONG_SUBAGENT_NAME,
  MOCK_SUBAGENT_NAME,
  QUICK_SUBAGENT_NAME,
  SLOW_SUBAGENT_NAME,
  SLOW_SUBAGENT_PROMPT,
  TWO_SUBAGENTS_PROMPT,
  createRoutine,
  getToolResults,
  goToSurface,
  listConversations,
  listSubAgents,
  openSettings,
  patchPrefs,
  runRoutine,
  sendMessage,
  signUp,
  startNewAgentRun,
  waitForRunDone,
  waitForSubAgents,
  type E2ESubAgent,
} from '../helpers/app.ts';
import { BASE_URL } from '../../scripts/standup.ts';

const MODEL_A = 'llama-3.1-8b-instruct';
const MODEL_B = 'qwen2.5-14b-instruct';

/** The run the last send opened: the newest agent conversation. */
async function newestRun(creds: Credentials): Promise<string> {
  let id = '';
  await browser.waitUntil(
    async () => {
      const first = (await listConversations(creds)).find((c) => c.kind === 'agent');
      id = first ? first.id : '';
      return id !== '';
    },
    { timeout: 20_000, timeoutMsg: 'the agent run never appeared in the conversation list' },
  );
  return id;
}

async function waitForStatus(creds: Credentials, convId: string, child: E2ESubAgent, status: E2ESubAgent['status']) {
  await browser.waitUntil(
    async () => (await listSubAgents(creds, convId)).find((s) => s.conversation_id === child.conversation_id)?.status === status,
    { timeout: 60_000, timeoutMsg: `sub-agent ${child.description} never became ${status}` },
  );
}

async function prefs(creds: Credentials): Promise<Record<string, unknown>> {
  const res = await fetch(`${BASE_URL}/v1/prefs`, { headers: { authorization: `Bearer ${await apiToken(creds)}` } });
  return (await res.json()) as Record<string, unknown>;
}

describe('sub-agents', () => {
  const creds = uniqueCreds();

  before(async () => {
    await signUp(creds);
  });

  after(async () => {
    await patchPrefs(creds, { subagentModelMode: 'choose', subagentModel: null }).catch(() => undefined);
  });

  it('shows a running sub-agent on its card, and its transcript in the panel; Stop ends it and not its parent', async function () {
    this.timeout(3 * 60_000);

    await goToSurface('agent');
    await tap('agent.mode.auto');
    // The model list has loaded: a send before it names no model, and the
    // sub-agent's card would then have none to show.
    await waitForTextIn('composer.model', MODEL_A, 30_000);
    await sendMessage(SLOW_SUBAGENT_PROMPT);
    const convId = await newestRun(creds);
    const [child] = await waitForSubAgents(creds, convId, 1);
    const card = `subagent.card.${child.call_id}`;

    // Running, named, and on a model — at once, before it has measured anything.
    await waitForVisible(card);
    await waitForTextIn(`${card}.status`, 'Running');
    await waitForTextIn(card, SLOW_SUBAGENT_NAME);
    await waitForTextIn(`${card}.model`, MODEL_A);
    await waitForVisible(`${card}.elapsed`);

    // Its context and speed, once its first request has finished (the mock's
    // eight seconds). Both are the child's own figures, mirrored onto the
    // parent's stream: the parent is doing nothing but waiting.
    await waitForTextIn(`${card}.context`, '% context', 40_000);
    await waitForTextIn(`${card}.speed`, 'tok/s', 10_000);
    // The parent is still running: its own header says so.
    await waitForTextIn('agent.run.status', 'Running');
    await shot('subagent-card-running');

    // The panel: the child's own transcript, in the same message list.
    await tap(`${card}.open`);
    await waitForVisible('subagent.panel');
    await waitForTextIn('subagent.panel.status', 'Running');
    // The task it was handed, and the tool call it has made since.
    await waitForTextIn('subagent.panel.messageList', 'take your time and make a todo plan');
    // Marked as the agent's: nobody typed a sub-agent's task.
    await waitForVisible('chat.message.fromAgent');
    await waitForTextIn('subagent.panel.messageList', 'todo_write', 20_000);
    await waitForTextIn('subagent.panel.context', '% context');
    await shot('subagent-panel-running');

    // Stop, from the panel. The child ends; the parent is told and carries on.
    await tap('subagent.panel.stop');
    await waitForTextIn('subagent.panel.status', 'Stopped', 30_000);
    await shot('subagent-panel-stopped');
    await waitForStatus(creds, convId, child, 'cancelled');
    await tap('subagent.close');
    await waitForAbsent('subagent.panel.stop');

    await waitForRunDone(creds, convId, 60_000);
    await waitForTextIn('agent.run.status', 'Done', 30_000);
    await waitForTextIn(`${card}.status`, 'Stopped');
    // The parent was told its sub-agent was stopped, and answered anyway.
    const [result] = await getToolResults(creds, convId);
    expect(result.ok).toBe(false);
    expect(result.output).toContain('This sub-agent was stopped before it finished.');
    await waitForTextIn('chat.messageList', '[Mock] The sub-agent has reported back.');
    // None of the child's transcript is in the parent's thread.
    if (platform() === 'web' || platform() === 'electron') {
      const parent = await browser.$('[data-testid="chat.messageList"]').getText();
      expect(parent).not.toContain('take your time and make a todo plan');
    }
    await shot('subagent-card-stopped');
  });

  it('lists the thread’s sub-agents from the ⋮ menu, running first, and stops one from its card', async function () {
    this.timeout(3 * 60_000);

    await startNewAgentRun();
    await tap('agent.mode.auto');
    await sendMessage(TWO_SUBAGENTS_PROMPT);
    const convId = await newestRun(creds);
    const [quick, long] = await waitForSubAgents(creds, convId, 2);
    expect(quick.description).toBe(QUICK_SUBAGENT_NAME);
    expect(long.description).toBe(LONG_SUBAGENT_NAME);
    // The quick one finishes while the long one is still going. On one
    // inference slot they run one after the other, in whichever order the
    // queue admits them — either way there is a moment with one of each.
    await waitForStatus(creds, convId, quick, 'complete');
    await waitForTextIn(`subagent.card.${quick.call_id}.status`, 'Finished');
    await waitForTextIn(`subagent.card.${long.call_id}.status`, 'Running', 30_000);

    await tap('agent.header.menu');
    await waitForTextIn('agent.header.subAgents', '1 running');
    await tap('agent.header.subAgents');
    await waitForVisible('subagent.list.panel');
    await waitForTextIn(`subagent.list.${long.conversation_id}.status`, 'Running');
    await waitForTextIn(`subagent.list.${quick.conversation_id}.status`, 'Finished');
    if (platform() !== 'ios') {
      // Running first, then finished. (XCUITest does not expose a plain
      // container view's testID, so the sections are checked off iOS.)
      await waitForTextIn('subagent.list.running', LONG_SUBAGENT_NAME);
      await waitForTextIn('subagent.list.finished', QUICK_SUBAGENT_NAME);
    }
    await shot('subagent-list');

    // Choosing one opens the same panel its card does — here, a finished one:
    // its whole transcript, read back from what is stored.
    await tap(`subagent.list.${quick.conversation_id}`);
    await waitForVisible('subagent.panel');
    await waitForTextIn('subagent.panel.status', 'Finished');
    await waitForTextIn('subagent.panel.messageList', '[Mock] Echo: say the quick lookup is done');
    // A finished sub-agent offers no Stop.
    await waitForAbsent('subagent.panel.stop');
    await shot('subagent-panel-finished');
    await tap('subagent.close');
    await waitForAbsent('subagent.panel.messageList');

    // Stop, from the card this time.
    await tap(`subagent.card.${long.call_id}.stop`);
    await waitForTextIn(`subagent.card.${long.call_id}.status`, 'Stopped', 30_000);
    await waitForRunDone(creds, convId, 60_000);
    await waitForTextIn('chat.messageList', '[Mock] Both sub-agents have reported back.');
    const results = await getToolResults(creds, convId);
    // In call order, each with what its own child did.
    expect(results.map((r) => r.ok)).toEqual([true, false]);
    expect(results[0].output).toContain('[Mock] Echo: say the quick lookup is done');
  });

  it('brings the cards and the list back after a reload', async function () {
    // A page reload is a web thing; on a device the stored listing is read at
    // every cold start, which native/connection-lifecycle covers for threads.
    if (platform() !== 'web' && platform() !== 'electron') this.skip();
    this.timeout(2 * 60_000);

    const convId = await newestRun(creds);
    const [quick, long] = await waitForSubAgents(creds, convId, 2);
    await browser.refresh();
    await waitForVisible('composer.input', 30_000);
    await goToSurface('agent');
    // Nothing is streaming any more: this is the stored record alone.
    await waitForTextIn(`subagent.card.${quick.call_id}.status`, 'Finished', 30_000);
    await waitForTextIn(`subagent.card.${long.call_id}.status`, 'Stopped');
    await waitForTextIn(`subagent.card.${quick.call_id}.model`, MODEL_A);
    await waitForTextIn(`subagent.card.${quick.call_id}.context`, '% context');
    await waitForVisible(`subagent.card.${quick.call_id}.elapsed`);
    await tap('agent.header.menu');
    // None running now, so the item says nothing about a count.
    await waitForTextIn('agent.header.subAgents', 'Sub-agents');
    await tap('agent.header.subAgents');
    await waitForTextIn('subagent.list.finished', QUICK_SUBAGENT_NAME);
    await waitForTextIn('subagent.list.finished', LONG_SUBAGENT_NAME);
    await shot('subagent-list-after-reload');
    await tap('subagent.list.close');
    await waitForAbsent('subagent.list.finished');
  });

  it('asks for a sub-agent’s approval where the parent’s would be, naming it; denying reaches the child', async function () {
    this.timeout(3 * 60_000);

    await startNewAgentRun();
    await tap('agent.mode.manual');
    await sendMessage(APPROVAL_SUBAGENT_PROMPT);
    const convId = await newestRun(creds);
    const [child] = await waitForSubAgents(creds, convId, 1);
    const card = `subagent.card.${child.call_id}`;

    // The same bar the run's own approval uses, saying who is asking.
    await waitForVisible('agent.permission.bar');
    await waitForTextIn('agent.permission.source', MOCK_SUBAGENT_NAME);
    await waitForTextIn('agent.permission.bar', 'fs_write');
    await waitForTextIn('agent.permission.deadline', "this call won't run");
    await waitForTextIn(`${card}.status`, 'Waiting for approval');
    await shot('subagent-approval-on-parent');

    // In its panel the question is in the footer, and the thread behind it
    // does not show the same question a second time.
    await tap(`${card}.open`);
    await waitForVisible('subagent.permission.bar');
    await waitForTextIn('subagent.permission.bar', 'fs_write');
    await waitForAbsent('agent.permission.bar');
    await shot('subagent-approval-in-panel');

    await tap('subagent.permission.deny');
    await waitForAbsent('subagent.permission.bar');
    // The child was told, and said so in its own transcript.
    await waitForTextIn('subagent.panel.messageList', 'User denied this tool call', 30_000);
    await tap('subagent.close');
    await waitForRunDone(creds, convId, 60_000);
    const [denied] = await getToolResults(creds, child.conversation_id);
    expect(denied).toMatchObject({ ok: false, output: 'User denied this tool call.' });
    await waitForAbsent('agent.permission.bar');
    await waitForTextIn(`${card}.status`, 'Finished');
  });

  it('allows a sub-agent’s tool from the parent’s bar, and the tool runs', async function () {
    this.timeout(4 * 60_000);

    await startNewAgentRun();
    await tap('agent.mode.manual');
    await sendMessage(APPROVAL_SUBAGENT_PROMPT);
    const convId = await newestRun(creds);
    const [child] = await waitForSubAgents(creds, convId, 1);

    await waitForTextIn('agent.permission.source', MOCK_SUBAGENT_NAME);
    await tap('agent.permission.allow');
    // The bar goes once the answer is on the wire.
    await waitForAbsent('agent.permission.bar');
    await waitForRunDone(creds, convId, 3 * 60_000);
    // The child's write ran — in the parent's own workspace.
    const [written] = await getToolResults(creds, child.conversation_id);
    expect(written.ok).toBe(true);
    await waitForTextIn(`subagent.card.${child.call_id}.status`, 'Finished');
    await shot('subagent-approval-allowed');
  });

  it('shows a routine’s sub-agent, and its approval, on the routine’s chat', async function () {
    this.timeout(3 * 60_000);

    // A routine's run is manual-mode chat, so its sub-agent asks before it
    // writes — in the dialog chat uses, which is what "the same way as the
    // parent's" means on this surface.
    const routine = await createRoutine(creds, {
      name: `Delegating ${String(Date.now())}`,
      prompt: APPROVAL_SUBAGENT_PROMPT,
      model: MODEL_A,
    });
    const run = await runRoutine(creds, routine.id);
    const [child] = await waitForSubAgents(creds, run.conversationId, 1);

    await goToSurface('routines');
    await waitForVisible(`routines.open.${routine.id}`);
    await tap(`routines.open.${routine.id}`);
    await waitForVisible('routineChat.back');

    // This screen did not start the run: it learns of the sub-agent, and of
    // what it is waiting on, from the snapshot it gets on opening the chat.
    await waitForVisible('chat.approval.dialog', 30_000);
    await waitForTextIn('chat.approval.source', MOCK_SUBAGENT_NAME);
    await waitForTextIn('chat.approval.dialog', 'fs_write');
    await shot('subagent-approval-routine');
    await tap('chat.approval.reject');
    await waitForAbsent('chat.approval.dialog');

    await waitForRunDone(creds, run.conversationId, 60_000);
    const [denied] = await getToolResults(creds, child.conversation_id);
    expect(denied).toMatchObject({ ok: false, output: 'User denied this tool call.' });
    await waitForTextIn(`subagent.card.${child.call_id}.status`, 'Finished', 30_000);

    // The routine's chat has the ⋮ item too.
    await tap('routineChat.header.menu');
    await tap('routineChat.header.subAgents');
    await waitForTextIn(`subagent.list.${child.conversation_id}.status`, 'Finished');
    await shot('subagent-list-routine');
    await tap('subagent.list.close');
    await waitForAbsent(`subagent.list.${child.conversation_id}`);
  });

  it('lets the model for sub-agents be chosen in settings, and a sub-agent then runs on it', async function () {
    // The model list is a Modal, which XCUITest cannot reach into; the setting
    // itself is covered there through the API below.
    this.timeout(3 * 60_000);

    await openSettings();
    await tap('settings.nav.checkins');
    await waitForVisible('checkins.subagents');
    await waitForTextIn('checkins.subagentModel.help', 'unless the agent picks another');

    await tap('checkins.subagentModel.parent');
    await browser.waitUntil(async () => (await prefs(creds)).subagentModelMode === 'parent', {
      timeoutMsg: 'the "always the agent’s model" choice was not saved',
    });
    await waitForTextIn('checkins.subagentModel.help', 'always runs on the model the agent itself is using');

    if (platform() === 'ios') {
      await patchPrefs(creds, { subagentModelMode: 'fixed', subagentModel: MODEL_B });
    } else {
      // "One model I choose" with none chosen opens the list rather than
      // saving something the server would refuse.
      await tap('checkins.subagentModel.fixed');
      await waitForVisible(`models.row.${MODEL_B}`);
      await shot('subagent-model-picker');
      await tap(`models.row.${MODEL_B}`);
      await waitForTextIn('checkins.subagentModel.current', MODEL_B, 20_000);
      await shot('subagent-model-setting');
    }
    await browser.waitUntil(
      async () => {
        const p = await prefs(creds);
        return p.subagentModelMode === 'fixed' && p.subagentModel === MODEL_B;
      },
      { timeoutMsg: 'the fixed sub-agent model was not saved' },
    );

    // And it is what a sub-agent then runs on, whatever its parent is on.
    await goToSurface('agent');
    await startNewAgentRun();
    await tap('agent.mode.auto');
    await sendMessage('Use a sub-agent: say which model you are');
    const convId = await newestRun(creds);
    const [child] = await waitForSubAgents(creds, convId, 1);
    expect(child.model).toBe(MODEL_B);
    await waitForTextIn(`subagent.card.${child.call_id}.model`, MODEL_B);
    await waitForRunDone(creds, convId, 60_000);
  });
});
