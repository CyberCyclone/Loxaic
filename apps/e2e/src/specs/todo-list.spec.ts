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
 */
import { browser } from '@wdio/globals';
import { uniqueCreds } from '../helpers/auth.ts';
import { shot } from '../helpers/screenshot.ts';
import { byTestId, platform, scrollTo, tap, waitForFreshText, waitForTextIn, waitForVisible } from '../helpers/selectors.ts';
import {
  TODO_STALE_PROMPT,
  getToolResults,
  goToSurface,
  openInspector,
  relaunchApp,
  selectThread,
  sendInNewRun,
  sendMessage,
  signUp,
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
});
