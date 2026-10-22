/**
 * The mode selector means what it says for the run already going (#311).
 *
 * Picking Auto while a Manual run waits at a prompt decides that call again,
 * as Auto would have: the permission check where the sandbox has the network
 * (the mock answers ALLOW unless the command names `classifier-ask`), or
 * straight to run where it has none. Planning, in or out, waits for the next
 * message, and the bar says the run is still in its own mode. After a fresh
 * start the selector shows what the thread is doing, never a fixed Manual.
 */
import { provisionAdmin, provisionUser, uniqueCreds } from '../helpers/auth.ts';
import { shot } from '../helpers/screenshot.ts';
import {
  isSelected,
  isVisible,
  tap,
  waitForAbsent,
  waitForFreshText,
  waitForSelected,
  waitForVisible,
} from '../helpers/selectors.ts';
import {
  getConversation,
  getToolResults,
  goToSurface,
  patchSandboxSettings,
  relaunchApp,
  resetSandboxSettings,
  selectThread,
  sendInNewRun,
  signIn,
  startNewAgentRun,
  waitForRunDone,
} from '../helpers/app.ts';

const ALLOWED = 'make a checked note';
const ASKED = 'make a classifier-ask note';

describe('switching the agent mode while a run works', () => {
  const creds = uniqueCreds();

  before(async function () {
    this.timeout(60_000);
    await provisionAdmin();
    await resetSandboxSettings();
    await patchSandboxSettings({ allowNetwork: true });
    await provisionUser(creds);
    await signIn(creds);
    await goToSurface('agent');
  });

  after(async () => {
    await resetSandboxSettings();
  });

  /** A new run in `mode`, parked on its first approval. */
  async function askingRun(mode: 'manual' | 'auto', prompt: string): Promise<string> {
    await startNewAgentRun();
    await tap(`agent.mode.${mode}`);
    const conversationId = await sendInNewRun(creds, prompt);
    await waitForVisible('agent.permission.bar', 60_000);
    return conversationId;
  }

  it('checks a waiting command once the run goes to Auto, and asks nobody', async function () {
    this.timeout(3 * 60_000);
    const conversationId = await askingRun('manual', ALLOWED);
    // A Manual run's question: no permission-check line.
    expect(await isVisible('agent.permission.checkNote')).toBe(false);
    await shot('live-mode-manual-asking');

    await tap('agent.mode.auto');
    await waitForRunDone(creds, conversationId);
    await waitForAbsent('agent.permission.bar');
    const [result] = await getToolResults(creds, conversationId);
    expect(result).toMatchObject({ ok: true, permission: { by: 'classifier' } });
    await waitForFreshText(`chat.toolCall.permission.${result.call_id}`, 'Allowed by the permission check');
    expect((await getConversation(creds, conversationId)).permissionMode).toBe('auto');
    await shot('live-mode-auto-checked');
  });

  it('asks again in Auto, with the check line, and says Auto after a fresh start', async function () {
    this.timeout(4 * 60_000);
    const conversationId = await askingRun('manual', ASKED);
    expect(await isVisible('agent.permission.checkNote')).toBe(false);

    await tap('agent.mode.auto');
    // The same call, decided again: the check said ASK, so the bar is back
    // with its reason.
    await waitForFreshText('agent.permission.checkNote', 'The mock was told to ask about this one.', 60_000);

    // A fresh start mid-run: the thread comes back from the run's snapshot,
    // question and mode both.
    await relaunchApp();
    await waitForVisible('composer.input', 60_000);
    await goToSurface('agent');
    await selectThread(conversationId, 'agent');
    await waitForSelected('agent.mode.auto');
    expect(await isSelected('agent.mode.manual')).toBe(false);
    await waitForFreshText('agent.permission.checkNote', 'The mock was told to ask about this one.', 60_000);
    await shot('live-mode-auto-after-relaunch');

    await tap('agent.permission.deny');
    await waitForRunDone(creds, conversationId);
  });

  it('keeps the run in its mode on a Planning pick, and says so on the bar', async function () {
    this.timeout(3 * 60_000);
    const conversationId = await askingRun('manual', ALLOWED);
    expect(await isVisible('agent.permission.mode')).toBe(false);

    await tap('agent.mode.planning');
    await waitForFreshText('agent.permission.mode', 'This run is in Manual mode. Planning applies from your next message.');
    // Still asking: the pick did not decide the call.
    expect(await isVisible('agent.permission.bar')).toBe(true);
    expect((await getConversation(creds, conversationId)).permissionMode).toBe('planning');
    await shot('live-mode-planning-pick');

    await tap('agent.permission.deny');
    await waitForRunDone(creds, conversationId);
    // The next message goes out in Planning.
    await waitForSelected('agent.mode.planning');
  });

  it('opens a thread with nothing running in the mode it was last used in', async function () {
    this.timeout(3 * 60_000);
    await startNewAgentRun();
    await tap('agent.mode.auto');
    const conversationId = await sendInNewRun(creds, ALLOWED);
    await waitForRunDone(creds, conversationId);

    await relaunchApp();
    await waitForVisible('composer.input', 60_000);
    await goToSurface('agent');
    await selectThread(conversationId, 'agent');
    await waitForSelected('agent.mode.auto');
    expect(await isSelected('agent.mode.manual')).toBe(false);
    await shot('live-mode-idle-after-relaunch');
  });

  it('runs a waiting command straight away where the sandbox has no network', async function () {
    this.timeout(3 * 60_000);
    await resetSandboxSettings();
    const conversationId = await askingRun('manual', ASKED);
    await tap('agent.mode.auto');
    await waitForRunDone(creds, conversationId);
    await waitForAbsent('agent.permission.bar');
    const [result] = await getToolResults(creds, conversationId);
    expect(result).toMatchObject({ ok: true, permission: { by: 'isolated' } });
    await waitForFreshText(`chat.toolCall.permission.${result.call_id}`, 'sandbox has no network');
  });
});
