/**
 * Auto mode's permission check (apps/server/src/permissions/check.ts): where
 * a sandbox has the network, a command that is not read-only and that no rule
 * covers is checked by the model before it runs. The mock answers ALLOW unless
 * the command names `classifier-ask` (ASK) or `classifier-slow` (no answer in
 * time), so each case below picks the answer with its scenario's command.
 *
 * With the network off the sandbox contains the command, and auto mode runs
 * it without a check, as it always has.
 */
import { provisionAdmin, provisionUser, uniqueCreds } from '../helpers/auth.ts';
import { shot } from '../helpers/screenshot.ts';
import { isVisible, tap, waitForFreshText, waitForTextIn, waitForVisible } from '../helpers/selectors.ts';
import {
  getToolResults,
  goToSurface,
  patchInferenceSettings,
  patchSandboxSettings,
  resetSandboxSettings,
  sendInNewRun,
  signIn,
  startNewAgentRun,
  waitForRunDone,
  requiresContainerEngine,
} from '../helpers/app.ts';

const ALLOWED = 'make a checked note';
const ASKED = 'make a classifier-ask note';
const SLOW = 'make a classifier-slow note';

describe('the auto-mode permission check', () => {
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
    await patchInferenceSettings({ permissionCheckTimeoutMs: 90_000 });
  });

  async function autoRun(prompt: string): Promise<string> {
    await startNewAgentRun();
    await tap('agent.mode.auto');
    return sendInNewRun(creds, prompt);
  }

  it('runs a command the check allows, and says the check allowed it', async function () {
    this.timeout(3 * 60_000);
    const conversationId = await autoRun(ALLOWED);
    await waitForRunDone(creds, conversationId);
    expect(await isVisible('agent.permission.bar')).toBe(false);
    const [result] = await getToolResults(creds, conversationId);
    expect(result).toMatchObject({ ok: true, permission: { by: 'classifier' } });
    // By the badge's own id: on a phone the keyboard can leave it off screen.
    await waitForFreshText(`chat.toolCall.permission.${result.call_id}`, 'Allowed by the permission check');
    await shot('classifier-allowed');
  });

  it('asks the person when the check says ASK, with its reason and the rule', async function () {
    this.timeout(3 * 60_000);
    const conversationId = await autoRun(ASKED);
    await waitForVisible('agent.permission.bar');
    await waitForTextIn('agent.permission.checkNote', 'The mock was told to ask about this one.');
    await waitForTextIn('agent.permission.rule', 'touch *');
    await shot('classifier-asked');
    await tap('agent.permission.deny');
    await waitForRunDone(creds, conversationId);
  });

  it('asks the person when the check takes too long', async function () {
    this.timeout(3 * 60_000);
    await patchInferenceSettings({ permissionCheckTimeoutMs: 5_000 });
    const conversationId = await autoRun(SLOW);
    await waitForVisible('agent.permission.bar', 60_000);
    await waitForTextIn('agent.permission.checkNote', 'took too long');
    await tap('agent.permission.deny');
    await waitForRunDone(creds, conversationId);
    await patchInferenceSettings({ permissionCheckTimeoutMs: 90_000 });
  });

  it('runs without a check where the sandbox has no network', async function () {
    requiresContainerEngine(this, 'a host-mode sandbox always has the network');
    this.timeout(3 * 60_000);
    await resetSandboxSettings();
    const conversationId = await autoRun(ASKED);
    await waitForRunDone(creds, conversationId);
    expect(await isVisible('agent.permission.bar')).toBe(false);
    const [result] = await getToolResults(creds, conversationId);
    expect(result).toMatchObject({ ok: true, permission: { by: 'isolated' } });
    await waitForFreshText(`chat.toolCall.permission.${result.call_id}`, 'sandbox has no network');
  });
});
