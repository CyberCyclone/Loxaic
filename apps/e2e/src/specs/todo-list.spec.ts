/**
 * The agent's todo list stays in front of the person, and in front of the
 * model.
 *
 * On the beta a model wrote its list once, item 1 in progress, then did four
 * more items without touching it. Three things were wrong and each is held
 * here:
 *
 *   - Nothing reminded the model. The server now appends a fixed reminder to a
 *     tool result once the list has gone ten tool iterations without a write,
 *     and the stored result is what proves it reached the prompt.
 *   - The reminder is for the model: the tool card must not show it.
 *   - The Inspector's list was a run's state. It went blank on the next turn
 *     that wrote no list, and after a fresh start once the run had ended.
 *
 * And the Inspector button's badge, which counted changed files in red and
 * read as tasks, now says how many of the list's items are done.
 *
 * The second case is the list that is not on the history page loaded: the
 * server is asked for it, asked again after a rewind removes the newer list,
 * and "couldn't load" is said as such while the server cannot answer, never
 * "no todos".
 */
import { browser } from '@wdio/globals';
import { apiToken, uniqueCreds } from '../helpers/auth.ts';
import { pauseServer, resumeServer } from '../helpers/server.ts';
import { BASE_URL } from '../../scripts/standup.ts';
import { shot } from '../helpers/screenshot.ts';
import {
  byTestId,
  closeKeyboard,
  isVisible,
  platform,
  scrollTo,
  tap,
  waitForAbsent,
  waitForFreshText,
  waitForTextIn,
  waitForVisible,
} from '../helpers/selectors.ts';
import {
  TODO_STALE_PROMPT,
  getToolResults,
  goToSurface,
  listConversations,
  openThreadList,
  closeInspector as closeInspectorSheet,
  openInspector,
  relaunchApp,
  selectThread,
  sendInNewRun,
  sendMessage,
  signUp,
  startNewAgentRun,
  waitForRunDone,
} from '../helpers/app.ts';

const MODEL = 'llama-3.1-8b-instruct';

/** The Inspector shows the agent's list, as written: three items. */
async function expectListInInspector(): Promise<void> {
  await openInspector();
  await waitForTextIn('agent.inspector.todo.0', 'Schema');
  await waitForTextIn('agent.inspector.todo.1', 'Routes');
  await waitForTextIn('agent.inspector.todo.2', 'Client');
}

/**
 * On an iPhone the keyboard can stay up after a send and leave the thread a
 * sliver, too little to scroll anything into view. The thread puts it away on
 * a tap that no message takes (`keyboardShouldPersistTaps`), not on the drag
 * closeKeyboard makes: the right of the sliver, beside a reply's stats line.
 */
async function putKeyboardAway(): Promise<void> {
  if (platform() === 'ios' && (await browser.isKeyboardShown().catch(() => false))) {
    const { width, height } = await browser.getWindowSize();
    await browser
      .action('pointer', { parameters: { pointerType: 'touch' } })
      .move({ x: Math.round(width * 0.85), y: Math.round(height * 0.36) })
      .down()
      .up()
      .perform();
    await browser.waitUntil(async () => !(await browser.isKeyboardShown().catch(() => false)), { timeout: 5_000 });
    await browser.pause(400);
  }
  await closeKeyboard();
}

async function closeInspector(): Promise<void> {
  await tap('agent.inspector.toggle');
}

describe('the todo list', () => {
  const creds = uniqueCreds();

  before(async () => {
    await signUp(creds);
    // The run's counters tick ten times a second while it works, and
    // UiAutomator2 waits for the UI to go idle before every query.
    if (platform() === 'android') await browser.updateSettings({ waitForIdleTimeout: 0 });
  });

  after(async () => {
    if (platform() === 'android') await browser.updateSettings({ waitForIdleTimeout: 10_000 });
  });

  // A case that fails while the server is frozen must not take the rest down.
  afterEach(() => {
    resumeServer();
  });

  it('reminds the model of a stale list, keeps the reminder out of the card, and keeps the list and its count', async function () {
    this.timeout(4 * 60_000);

    await goToSurface('agent');
    await tap('agent.mode.auto');
    await waitForTextIn('composer.model', MODEL, 30_000);
    const convId = await sendInNewRun(creds, TODO_STALE_PROMPT);
    await waitForRunDone(creds, convId);

    // The model got the reminder once, on the eleventh result after the write.
    const results = await getToolResults(creds, convId);
    const reminded = results.filter((r) => r.output.includes('<todo-reminder>'));
    expect(reminded).toHaveLength(1);
    expect(results.indexOf(reminded[0])).toBe(11);

    // The person does not see it: the card shows the tool's own result.
    const failed = `chat.toolCall.failed.${reminded[0].call_id}`;
    await putKeyboardAway();
    await scrollTo(failed);
    await tap(failed);
    const card = byTestId(`chat.toolCall.resultText.${reminded[0].call_id}`);
    await card.waitForExist({ timeout: 10_000 });
    const shown = await card.getText();
    expect(shown.length).toBeGreaterThan(0);
    expect(shown).not.toContain('todo-reminder');
    expect(shown).not.toContain('todo list has not changed');
    await shot('todo-reminder-hidden-in-card');

    // The badge counts the list: one of three done, not eleven changed files.
    await waitForFreshText('agent.inspector.toggle.progress', '1/3');
    await expectListInInspector();
    await shot('todo-list-inspector');
    await closeInspector();

    // A turn that writes no list used to blank it.
    await sendMessage('Thanks, that is all for now.');
    await waitForRunDone(creds, convId);
    await waitForFreshText('agent.inspector.toggle.progress', '1/3');
    await expectListInInspector();
    await closeInspector();

    // And so did a fresh start once nothing was running.
    await relaunchApp();
    await waitForVisible('composer.input', 60_000);
    await goToSurface('agent');
    await selectThread(convId, 'agent');
    await waitForFreshText('agent.inspector.toggle.progress', '1/3', 30_000);
    await expectListInInspector();
    await shot('todo-list-after-relaunch');
    await closeInspector();
  });

  it('asks the server for a list on an older page, again after a rewind, and says when it cannot', async function () {
    this.timeout(6 * 60_000);

    /** The conversation's stored rows on its newest page, oldest first. */
    const rows = async (convId: string) => {
      const token = await apiToken(creds);
      const res = await fetch(`${BASE_URL}/v1/conversations/${convId}/messages`, { headers: { authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error(`[e2e] reading messages failed (${String(res.status)})`);
      return ((await res.json()) as { messages: { id: string; authorType: string; content: { kind: string; text?: string }[] }[] }).messages;
    };
    const turn = async (convId: string, text: string) => {
      const before = (await rows(convId)).length;
      await sendMessage(text);
      await browser.waitUntil(async () => (await rows(convId)).length > before, { timeout: 30_000 });
      await waitForRunDone(creds, convId);
    };
    // On web and Electron the Inspector is a side panel that stays open, and
    // its toggle would close it again.
    const showInspector = async () => {
      if (!(await isVisible('agent.inspector.panel'))) await openInspector();
    };
    const expectList = async (items: string[]) => {
      await showInspector();
      for (const [i, text] of items.entries()) await waitForFreshText(`agent.inspector.todo.${String(i)}`, text, 30_000);
      expect(await isVisible(`agent.inspector.todo.${String(items.length)}`)).toBe(false);
    };

    // The first list, then two turns of sixty tool calls each: 244 rows,
    // past the 200-row page, so a fresh open loads them and not the list.
    await goToSurface('agent');
    await startNewAgentRun();
    await tap('agent.mode.auto');
    await waitForTextIn('composer.model', MODEL, 30_000);
    const convId = await sendInNewRun(creds, 'Please pin the first todo list.');
    await waitForRunDone(creds, convId);
    await turn(convId, 'Now run sixty quick lookups.');
    await turn(convId, 'And run sixty quick lookups again.');

    await relaunchApp();
    await waitForVisible('composer.input', 60_000);
    await goToSurface('agent');
    await selectThread(convId, 'agent');
    await waitForFreshText('agent.inspector.toggle.progress', '0/2', 30_000);
    await expectList(['Alpha', 'Beta']);
    await shot('todo-list-from-older-page');
    await closeInspectorSheet();

    // A newer list, then rewound away: what is left is the first one, which
    // the server has to be asked for again. Kept from before the rewind, the
    // answer was the removed list.
    await turn(convId, 'Please pin the second todo list.');
    await waitForFreshText('agent.inspector.toggle.progress', '0/1', 30_000);
    const second = (await rows(convId)).find((r) => r.authorType === 'user' && r.content.some((b) => b.text === 'Please pin the second todo list.'));
    if (!second) throw new Error('the second list\'s message was not stored');
    await putKeyboardAway();
    await scrollTo(`chat.message.rewind.${second.id}`);
    await tap(`chat.message.rewind.${second.id}`);
    await waitForVisible('chat.rewind.confirm');
    await tap('chat.rewind.confirm');
    await waitForAbsent('chat.rewind.cancel');
    // The rewound message goes back into the composer, which raises it again.
    await closeKeyboard();
    await waitForFreshText('agent.inspector.toggle.progress', '0/2', 30_000);
    await expectList(['Alpha', 'Beta']);
    await closeInspectorSheet();

    // Opened while the server cannot answer: not "No todos yet", which would
    // say the agent has no list, and no badge. The screen opens the newest
    // thread on load, so another one is made newest first; otherwise the
    // relaunch reopens this one and asks while the server is still up.
    const other = (await listConversations(creds)).find((c) => c.kind === 'agent' && c.id !== convId);
    if (!other) throw new Error('the first case\'s run is missing');
    await selectThread(other.id, 'agent');
    await turn(other.id, 'Thanks, nothing more.');
    await relaunchApp();
    await waitForVisible('composer.input', 60_000);
    await goToSurface('agent');
    await openThreadList('agent');
    pauseServer();
    await tap(`threadList.item.${convId}`);
    await showInspector();
    await waitForVisible('agent.inspector.todos.failed', 60_000);
    expect(await isVisible('agent.inspector.todos.empty')).toBe(false);
    expect(await isVisible('agent.inspector.toggle.progress')).toBe(false);
    await shot('todo-list-could-not-load');

    // And asked again once the server is back.
    resumeServer();
    await waitForFreshText('agent.inspector.todo.0', 'Alpha', 60_000);
    await waitForFreshText('agent.inspector.toggle.progress', '0/2', 30_000);
    await closeInspectorSheet();
  });
});
