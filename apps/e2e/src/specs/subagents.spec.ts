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
import { byTestId, isVisible, platform, scrollTo, tap, waitForAbsent, waitForFreshText, waitForTextIn, waitForVisible } from '../helpers/selectors.ts';
import {
  APPROVAL_SUBAGENT_PROMPT,
  LONG_SUBAGENT_NAME,
  MOCK_SUBAGENT_NAME,
  QUICK_SUBAGENT_NAME,
  SLOW_SUBAGENT_NAME,
  SLOW_SUBAGENT_PROMPT,
  TWO_SUBAGENTS_PROMPT,
  createRoutine,
  elapsedSeconds,
  getToolResults,
  goToSurface,
  listSubAgents,
  openSettings,
  patchPrefs,
  runRoutine,
  sendInNewRun,
  signUp,
  startNewAgentRun,
  waitForRunDone,
  waitForSubAgents,
  type E2ESubAgent,
} from '../helpers/app.ts';
import { BASE_URL } from '../../scripts/standup.ts';

const MODEL_A = 'llama-3.1-8b-instruct';
const MODEL_B = 'qwen2.5-14b-instruct';

/**
 * What an elapsed label reads, in seconds, queried afresh each time: the
 * running counter re-renders ten times a second, and a finished child's label
 * replaces it.
 */
async function readElapsed(id: string): Promise<number> {
  let seconds = Number.NaN;
  await browser.waitUntil(
    async () => {
      seconds = elapsedSeconds(await byTestId(id).getText().catch(() => ''));
      return !Number.isNaN(seconds);
    },
    { timeout: 15_000, timeoutMsg: `${id} never showed a duration` },
  );
  return seconds;
}

/**
 * Opens the Sub-agents list from the agent screen's ⋮ menu.
 *
 * Tried twice. On an iPhone with the keyboard up, presenting the menu is what
 * dismisses the keyboard, and a tap on the item made while that is still
 * animating lands nowhere — the menu stays open with nothing chosen.
 */
async function openSubAgentsList(): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!(await isVisible('agent.header.subAgents').catch(() => false))) await tap('agent.header.menu');
    await browser.pause(platform() === 'ios' ? 1_000 : 0);
    await tap('agent.header.subAgents');
    const open = await byTestId('subagent.list.panel').waitForDisplayed({ timeout: 5_000 }).then(() => true, () => false);
    if (open) return;
  }
  await waitForVisible('subagent.list.panel');
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
  /** The two-sub-agent run, which the reload case looks at again. */
  let twoRun = '';

  before(async () => {
    await signUp(creds);
    // UiAutomator2 waits for the UI to go idle before every query, and a
    // running sub-agent's card never lets it: its elapsed counter ticks ten
    // times a second. Each lookup then takes ~10 s — longer than the things
    // being looked for last. Same setting, for the same reason, as
    // compaction-live.spec.ts.
    if (platform() === 'android') await browser.updateSettings({ waitForIdleTimeout: 0 });
  });

  afterEach(async () => {
    // A case that failed with a sheet open must not take the rest with it.
    for (const close of ['subagent.close', 'subagent.list.close']) {
      // Tolerant: a sheet that is already on its way out is still "visible"
      // for a frame, and gone by the time the tap arrives.
      if (await isVisible(close).catch(() => false)) await byTestId(close).click().catch(() => undefined);
    }
  });

  after(async () => {
    if (platform() === 'android') await browser.updateSettings({ waitForIdleTimeout: 10_000 });
    await patchPrefs(creds, { subagentModelMode: 'choose', subagentModel: null }).catch(() => undefined);
  });

  it('shows a running sub-agent on its card, and its transcript in the panel; Stop ends it and not its parent', async function () {
    this.timeout(3 * 60_000);

    await goToSurface('agent');
    await tap('agent.mode.auto');
    // The model list has loaded: a send before it names no model, and the
    // sub-agent's card would then have none to show.
    await waitForTextIn('composer.model', MODEL_A, 30_000);
    const convId = await sendInNewRun(creds, SLOW_SUBAGENT_PROMPT);
    const [child] = await waitForSubAgents(creds, convId, 1);
    const card = `subagent.card.${child.call_id}`;

    // Running, named, and on a model — at once, before it has measured anything.
    await waitForFreshText(`${card}.status`, 'Running');
    await waitForFreshText(`${card}.name`, SLOW_SUBAGENT_NAME);
    await waitForFreshText(`${card}.model`, MODEL_A);
    await waitForFreshText(`${card}.elapsed`, 's');

    // Its context and speed, once its first request has finished (the mock's
    // eight seconds). Both are the child's own figures, mirrored onto the
    // parent's stream: the parent is doing nothing but waiting.
    await waitForFreshText(`${card}.context`, '% context', 40_000);
    await waitForFreshText(`${card}.speed`, 'tok/s', 10_000);
    // Counted from its real start: by the time its first request has
    // finished it has been running for the mock's eight seconds. ("Contains
    // an s" passed for a counter stuck at 0.0s.)
    const sinceStart = (Date.now() - child.started_at) / 1000;
    const shown = await readElapsed(`${card}.elapsed`);
    expect(shown).toBeGreaterThanOrEqual(7);
    expect(Math.abs(shown - sinceStart)).toBeLessThan(5);
    // The parent is still running: its own header says so.
    await waitForTextIn('agent.run.status', 'Running');
    await shot('subagent-card-running');

    // The panel: the child's own transcript, in the same message list.
    // By its chevron, a leaf control: XCUITest does not expose the card's main
    // press target, whose children are the texts it is made of.
    await tap(`${card}.chevron`);
    await waitForVisible('subagent.panel');
    await waitForFreshText('subagent.panel.status', 'Running');
    // The task it was handed, and the tool call it has made since.
    await waitForTextIn('subagent.panel.messageList', 'take your time and survey in passes');
    // Marked as the agent's: nobody typed a sub-agent's task.
    await waitForVisible('chat.message.fromAgent');
    await waitForTextIn('subagent.panel.messageList', 'todo_write', 20_000);
    await waitForFreshText('subagent.panel.context', '% context');
    await shot('subagent-panel-running');

    // Stop, from the panel. The child ends; the parent is told and carries on.
    await tap('subagent.panel.stop');
    await waitForFreshText('subagent.panel.status', 'Stopped', 30_000);
    await shot('subagent-panel-stopped');
    await waitForStatus(creds, convId, child, 'cancelled');
    await tap('subagent.close');
    await waitForAbsent('subagent.panel.stop');

    await waitForRunDone(creds, convId, 60_000);
    await waitForTextIn('agent.run.status', 'Done', 30_000);
    await waitForFreshText(`${card}.status`, 'Stopped');
    // The parent was told its sub-agent was stopped, and answered anyway.
    const [result] = await getToolResults(creds, convId);
    expect(result.ok).toBe(false);
    expect(result.output).toContain('This sub-agent was stopped before it finished.');
    await waitForTextIn('chat.messageList', '[Mock] The sub-agent has reported back.');
    // None of the child's transcript is in the parent's thread.
    if (platform() === 'web' || platform() === 'electron') {
      const parent = await browser.$('[data-testid="chat.messageList"]').getText();
      expect(parent).not.toContain('take your time and survey in passes');
    }
    await shot('subagent-card-stopped');
  });

  it('lists the thread’s sub-agents from the ⋮ menu, running first, and stops one from its card', async function () {
    this.timeout(3 * 60_000);

    await startNewAgentRun();
    await tap('agent.mode.auto');
    const convId = await sendInNewRun(creds, TWO_SUBAGENTS_PROMPT);
    twoRun = convId;
    const [quick, long] = await waitForSubAgents(creds, convId, 2);
    expect(quick.description).toBe(QUICK_SUBAGENT_NAME);
    expect(long.description).toBe(LONG_SUBAGENT_NAME);
    // The quick one finishes while the long one is still going. On one
    // inference slot they run one after the other, in whichever order the
    // queue admits them — either way there is a moment with one of each.
    await waitForStatus(creds, convId, quick, 'complete');
    await waitForFreshText(`subagent.card.${quick.call_id}.status`, 'Finished');
    await waitForFreshText(`subagent.card.${long.call_id}.status`, 'Running', 30_000);

    await tap('agent.header.menu');
    // The count beside the item. Not on iOS, where XCUITest can tap a menu
    // item but does not report one as displayed.
    if (platform() !== 'ios') await waitForTextIn('agent.header.subAgents', '1 running');
    await tap('agent.header.subAgents');
    await waitForVisible('subagent.list.panel');
    await waitForFreshText(`subagent.list.${long.conversation_id}.status`, 'Running');
    await waitForFreshText(`subagent.list.${quick.conversation_id}.status`, 'Finished');
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
    await waitForFreshText('subagent.panel.status', 'Finished');
    await waitForTextIn('subagent.panel.messageList', '[Mock] Echo: say the quick lookup is done');
    // A finished sub-agent offers no Stop.
    await waitForAbsent('subagent.panel.stop');
    await shot('subagent-panel-finished');
    await tap('subagent.close');
    await waitForAbsent('subagent.panel.messageList');

    // Stop, from the card this time.
    await tap(`subagent.card.${long.call_id}.stop`);
    await waitForFreshText(`subagent.card.${long.call_id}.status`, 'Stopped', 30_000);
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

    const [quick, long] = await waitForSubAgents(creds, twoRun, 2);
    await browser.refresh();
    await waitForVisible('composer.input', 30_000);
    await goToSurface('agent');
    // Nothing is streaming any more: this is the stored record alone.
    await waitForFreshText(`subagent.card.${quick.call_id}.status`, 'Finished', 30_000);
    await waitForFreshText(`subagent.card.${long.call_id}.status`, 'Stopped');
    await waitForFreshText(`subagent.card.${quick.call_id}.model`, MODEL_A);
    await waitForFreshText(`subagent.card.${quick.call_id}.context`, '% context');
    // A finished sub-agent's time is its own start to its own end, as stored.
    const stored = ((quick.ended_at ?? Number.NaN) - quick.started_at) / 1000;
    expect(Math.abs((await readElapsed(`subagent.card.${quick.call_id}.elapsed`)) - stored)).toBeLessThan(0.2);
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

  it('says when the earlier sub-agents could not be loaded, and loads them on Try again', async function () {
    // Cutting one request from inside the page is a web thing (see
    // server-unreachable.spec.ts); the rule itself is unit-tested.
    if (platform() !== 'web' && platform() !== 'electron') this.skip();
    this.timeout(2 * 60_000);

    await browser.refresh();
    await waitForVisible('composer.input', 30_000);
    // The listing answers 503 — a server that is up and having a bad moment.
    // Installed before the agent screen mounts, which is what asks for it.
    await browser.execute(() => {
      const w = window as unknown as { __failSubAgents?: boolean };
      w.__failSubAgents = true;
      const real = window.fetch.bind(window);
      window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (w.__failSubAgents && /\/subagents(\?|$)/.test(url)) {
          return Promise.resolve(new Response('{"error":"unavailable"}', { status: 503 }));
        }
        return real(input, init);
      };
    });
    await goToSurface('agent');
    await tap('agent.header.menu');
    await tap('agent.header.subAgents');
    // "Could not ask" — never "No sub-agents yet", which is a claim.
    await waitForVisible('subagent.list.unavailable');
    expect(await isVisible('subagent.list.empty')).toBe(false);
    await shot('subagent-list-unavailable');

    await browser.execute(() => {
      (window as unknown as { __failSubAgents?: boolean }).__failSubAgents = false;
    });
    await tap('subagent.list.retry');
    await waitForTextIn('subagent.list.finished', QUICK_SUBAGENT_NAME, 20_000);
    await waitForAbsent('subagent.list.unavailable');
    await tap('subagent.list.close');
    await waitForAbsent('subagent.list.finished');
  });

  it('times a sub-agent that was already running at a reload from its real start', async function () {
    if (platform() !== 'web' && platform() !== 'electron') this.skip();
    this.timeout(3 * 60_000);

    await startNewAgentRun();
    await tap('agent.mode.auto');
    const convId = await sendInNewRun(creds, SLOW_SUBAGENT_PROMPT);
    const [child] = await waitForSubAgents(creds, convId, 1);
    const card = `subagent.card.${child.call_id}`;
    await waitForFreshText(`${card}.status`, 'Running');
    // Long enough in that "counting from when the page loaded" and "counting
    // from when it started" cannot be mistaken for each other.
    await browser.pause(10_000);

    await browser.refresh();
    await waitForVisible('composer.input', 30_000);
    await goToSurface('agent');
    await waitForFreshText(`${card}.status`, 'Running', 30_000);
    const shown = await readElapsed(`${card}.elapsed`);
    const sinceStart = (Date.now() - child.started_at) / 1000;
    // The stored listing reaches the page before any snapshot does, and the
    // start it works out is the one the counter keeps: without the server's
    // clock on that listing, this read a second or two.
    expect(shown).toBeGreaterThanOrEqual(10);
    expect(Math.abs(shown - sinceStart)).toBeLessThan(5);
    await shot('subagent-card-running-after-reload');

    await tap(`${card}.stop`);
    await waitForFreshText(`${card}.status`, 'Stopped', 30_000);
    await waitForRunDone(creds, convId, 60_000);
  });

  it('keeps the plan from opening over a sub-agent’s panel, and opens it when the panel closes', async function () {
    this.timeout(3 * 60_000);

    await startNewAgentRun();
    await tap('agent.mode.planning');
    // A planning run that hands off an investigation and then plans. The
    // child takes the mock's eight seconds, which is the time to open it in.
    const convId = await sendInNewRun(creds, 'Use a sub-agent: take your time and say the survey is done');
    const [child] = await waitForSubAgents(creds, convId, 1);
    if (platform() === 'ios') {
      await openSubAgentsList();
      await tap(`subagent.list.${child.conversation_id}`);
    } else {
      await tap(`subagent.card.${child.call_id}.chevron`);
    }
    await waitForVisible('subagent.panel');

    // The parent finishes — in a plan, as planning always does — with the
    // sub-agent's panel still open.
    await waitForRunDone(creds, convId, 90_000);
    await waitForFreshText('subagent.panel.status', 'Finished', 30_000);
    // Long enough for the plan's sheet to have opened, had it been going to.
    await browser.pause(2_000);
    expect(await isVisible('agent.plan.panel').catch(() => false)).toBe(false);
    await waitForVisible('subagent.panel');
    await shot('subagent-panel-open-while-plan-waits');

    // Held back, not skipped: it opens once the other sheet has gone.
    await tap('subagent.close');
    await waitForVisible('agent.plan.panel', 20_000);
    await shot('plan-opens-after-subagent-panel');
    await tap('agent.plan.close');
    await waitForAbsent('agent.plan.panel');
  });

  it('names its own run when answering an approval, so no other run holding that call id is answered', async function () {
    // What goes out on the socket can only be read from inside a page.
    if (platform() !== 'web' && platform() !== 'electron') this.skip();
    this.timeout(2 * 60_000);

    await startNewAgentRun();
    await tap('agent.mode.manual');
    const convId = await sendInNewRun(creds, 'Please write a file called notes.txt');
    await waitForVisible('agent.permission.bar');
    await browser.execute(() => {
      const w = window as unknown as { __sentFrames?: string[] };
      w.__sentFrames = [];
      // eslint-disable-next-line @typescript-eslint/unbound-method -- re-bound with `call` below
      const send = WebSocket.prototype.send;
      WebSocket.prototype.send = function (data) {
        if (typeof data === 'string') w.__sentFrames?.push(data);
        send.call(this, data);
      };
    });
    await tap('agent.permission.deny');
    await waitForAbsent('agent.permission.bar');
    await waitForRunDone(creds, convId, 60_000);
    const frames = await browser.execute(() => (window as unknown as { __sentFrames?: string[] }).__sentFrames ?? []);
    const answer = frames.map((f) => JSON.parse(f) as { type?: string; stream_id?: string }).find((f) => f.type === 'agent.deny');
    // A call id is the model's and repeats; an answer with no run named is
    // given to whichever of this person's runs holds that id — another
    // thread's, or a sub-agent's nobody was shown.
    expect(answer?.stream_id).toMatch(/^[0-9a-f-]{36}$/);
    const [denied] = await getToolResults(creds, convId);
    expect(denied).toMatchObject({ ok: false, output: 'User denied this tool call.' });
  });

  it('asks for a sub-agent’s approval where the parent’s would be, naming it; denying reaches the child', async function () {
    this.timeout(3 * 60_000);

    await startNewAgentRun();
    await tap('agent.mode.manual');
    const convId = await sendInNewRun(creds, APPROVAL_SUBAGENT_PROMPT);
    const [child] = await waitForSubAgents(creds, convId, 1);
    const card = `subagent.card.${child.call_id}`;

    // The same bar the run's own approval uses, saying who is asking.
    await waitForVisible('agent.permission.bar');
    await waitForFreshText('agent.permission.source', MOCK_SUBAGENT_NAME);
    await waitForTextIn('agent.permission.bar', 'fs_write');
    await waitForTextIn('agent.permission.deadline', "this call won't run");
    await shot('subagent-approval-on-parent');

    // In its panel the question is in the footer, and the thread behind it
    // does not show the same question a second time.
    if (platform() === 'ios') {
      // An iPhone's keyboard is still up from the send, and with the approval
      // bar above it the thread has no room left: the card is not on screen
      // (WebDriverAgent cannot close this keyboard, and there is no list to
      // tap). The ⋮ menu's list is the other way to the same panel.
      await openSubAgentsList();
      await waitForFreshText(`subagent.list.${child.conversation_id}.status`, 'Waiting for approval');
      await tap(`subagent.list.${child.conversation_id}`);
    } else {
      await waitForFreshText(`${card}.status`, 'Waiting for approval');
      await tap(`${card}.chevron`);
    }
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
    await waitForFreshText(`${card}.status`, 'Finished');
  });

  it('allows a sub-agent’s tool from the parent’s bar, and the tool runs', async function () {
    this.timeout(4 * 60_000);

    await startNewAgentRun();
    await tap('agent.mode.manual');
    const convId = await sendInNewRun(creds, APPROVAL_SUBAGENT_PROMPT);
    const [child] = await waitForSubAgents(creds, convId, 1);

    await waitForFreshText('agent.permission.source', MOCK_SUBAGENT_NAME);
    await tap('agent.permission.allow');
    // The bar goes once the answer is on the wire.
    await waitForAbsent('agent.permission.bar');
    await waitForRunDone(creds, convId, 3 * 60_000);
    // The child's write ran — in the parent's own workspace.
    const [written] = await getToolResults(creds, child.conversation_id);
    expect(written.ok).toBe(true);
    await waitForFreshText(`subagent.card.${child.call_id}.status`, 'Finished');
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

    // This screen did not start the run: it learns of the sub-agent, and of
    // what it is waiting on, from the snapshot it gets on opening the chat.
    await waitForVisible('chat.approval.dialog', 30_000);
    await waitForFreshText('chat.approval.source', MOCK_SUBAGENT_NAME);
    await waitForTextIn('chat.approval.dialog', 'fs_write');
    await shot('subagent-approval-routine');
    await tap('chat.approval.reject');
    // A control inside it, not the dialog: on Android a closed modal's root
    // goes on reporting `displayed`.
    await waitForAbsent('chat.approval.reject');

    await waitForRunDone(creds, run.conversationId, 60_000);
    const [denied] = await getToolResults(creds, child.conversation_id);
    expect(denied).toMatchObject({ ok: false, output: 'User denied this tool call.' });
    await waitForFreshText(`subagent.card.${child.call_id}.status`, 'Finished', 30_000);

    // The routine's chat has the ⋮ item too.
    await tap('routineChat.header.menu');
    await tap('routineChat.header.subAgents');
    await waitForFreshText(`subagent.list.${child.conversation_id}.status`, 'Finished');
    await shot('subagent-list-routine');
    await tap('subagent.list.close');
    await waitForAbsent(`subagent.list.${child.conversation_id}`);
    // Back to the routines list: on a phone this screen has Back where the
    // sidebar's menu button is, and the next case starts from the sidebar.
    await tap('routineChat.back');
    await waitForVisible('routines.new');
  });

  it('lets the model for sub-agents be chosen in settings, and a sub-agent then runs on it', async function () {
    // The model list is a Modal, which XCUITest cannot reach into; the setting
    // itself is covered there through the API below.
    this.timeout(3 * 60_000);

    await openSettings();
    // Both the settings row and the Sub-agents section are below the fold on
    // a phone; on a desktop these scrolls find them already in view.
    const native = platform() === 'ios' || platform() === 'android';
    if (native) await scrollTo('settings.nav.checkins');
    await tap('settings.nav.checkins');
    await waitForVisible('checkins.scroll');
    if (native) await scrollTo('checkins.subagentModel.fixed');
    await waitForVisible('checkins.subagentModel.fixed');
    if (native) await scrollTo('checkins.subagentModel.help');
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
    const convId = await sendInNewRun(creds, 'Use a sub-agent: say which model you are');
    const [child] = await waitForSubAgents(creds, convId, 1);
    expect(child.model).toBe(MODEL_B);
    await waitForFreshText(`subagent.card.${child.call_id}.model`, MODEL_B);
    await waitForRunDone(creds, convId, 60_000);
  });
});
