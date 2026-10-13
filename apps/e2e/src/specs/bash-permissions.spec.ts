/**
 * Per-command bash permissions (apps/server/src/permissions/bash): read-only
 * commands run without asking; anything else asks, offering a rule for just
 * that command; "Allow always" records the rule, the permissions screen lists
 * it and taking it back brings the question back; a deny rule refuses; and
 * planning mode runs read-only commands only.
 *
 * Each prompt here is a scenario (fixtures/scenarios.json) that makes the
 * mock run one exact command, so what is asked about is known in advance.
 */
import { provisionAdmin, provisionUser, uniqueCreds } from '../helpers/auth.ts';
import { shot } from '../helpers/screenshot.ts';
import { isVisible, scrollTo, tap, waitForAbsent, waitForFreshText, waitForTextIn, waitForVisible } from '../helpers/selectors.ts';
import {
  addCommandRuleFor,
  clearCommandRules,
  commandRules,
  getToolResults,
  goToSurface,
  openSettings,
  resetSandboxSettings,
  sendInNewRun,
  sendMessage,
  signIn,
  startNewAgentRun,
  waitForRunDone,
} from '../helpers/app.ts';

const READ_ONLY = 'list the workspace read-only';
const WRITE = 'touch a scratch note';
const COMPOUND = 'list then touch a note';
const DENIED = 'remove the old note';

describe('bash permissions', () => {
  const creds = uniqueCreds();

  before(async function () {
    this.timeout(60_000);
    await provisionAdmin();
    // A sandbox with no network: auto mode would run anything there, which
    // keeps the manual-mode cases below about the rules alone.
    await resetSandboxSettings();
    await provisionUser(creds);
    await signIn(creds);
    await goToSurface('agent');
  });

  afterEach(async () => {
    await clearCommandRules(creds);
  });

  it('runs a read-only command without asking, and says why', async function () {
    this.timeout(3 * 60_000);
    await startNewAgentRun();
    await tap('agent.mode.manual');
    const conversationId = await sendInNewRun(creds, READ_ONLY);
    await waitForRunDone(creds, conversationId);
    expect(await isVisible('agent.permission.bar')).toBe(false);
    const [result] = await getToolResults(creds, conversationId);
    expect(result).toMatchObject({ ok: true, permission: { by: 'readonly' } });
    // By the badge's own id: on a phone the keyboard can leave it off screen.
    await waitForFreshText(`chat.toolCall.permission.${result.call_id}`, 'Read-only command');
    await shot('bash-readonly-ran');
  });

  it('asks about a write with its rule, remembers "Allow always", and asks again once the rule is removed', async function () {
    this.timeout(5 * 60_000);
    await startNewAgentRun();
    await tap('agent.mode.manual');
    const conversationId = await sendInNewRun(creds, WRITE);
    await waitForVisible('agent.permission.bar');
    await waitForTextIn('agent.permission.rule', 'touch *');
    await shot('bash-write-asks-with-rule');
    await tap('agent.permission.allowAlways');
    await waitForRunDone(creds, conversationId);
    expect((await commandRules(creds)).map((r) => [r.pattern, r.action, r.source])).toEqual([['touch *', 'allow', 'prompt']]);

    // The same command again: the rule covers it.
    await sendMessage(WRITE);
    await waitForRunDone(creds, conversationId);
    expect(await isVisible('agent.permission.bar')).toBe(false);
    const latest = (await getToolResults(creds, conversationId)).at(-1);
    expect(latest).toMatchObject({ ok: true, permission: { by: 'rule', rule: 'touch *' } });
    await waitForFreshText(`chat.toolCall.permission.${latest?.call_id ?? ''}`, 'Allowed by your rule');

    // Listed on the permissions screen, and taken back there.
    await openSettings();
    await scrollTo('settings.nav.permissions');
    await tap('settings.nav.permissions');
    await waitForVisible('permissions.rule.allow.touch *');
    await shot('bash-permissions-screen');
    await tap('permissions.rule.allow.touch *.remove');
    await waitForAbsent('permissions.rule.allow.touch *');
    expect(await commandRules(creds)).toEqual([]);

    await goToSurface('agent');
    await startNewAgentRun();
    await tap('agent.mode.manual');
    await sendInNewRun(creds, WRITE);
    await waitForVisible('agent.permission.bar');
    await tap('agent.permission.deny');
  });

  it('offers a rule only for the part of a compound command that changes something', async function () {
    this.timeout(3 * 60_000);
    await startNewAgentRun();
    await tap('agent.mode.manual');
    const conversationId = await sendInNewRun(creds, COMPOUND);
    await waitForVisible('agent.permission.bar');
    // Exactly this: a proposal for the `ls` too would read "`ls *` and `touch *`".
    await waitForTextIn('agent.permission.rule', 'Always allow `touch *`');
    await tap('agent.permission.deny');
    await waitForRunDone(creds, conversationId);
  });

  it('refuses a command a deny rule covers, without asking', async function () {
    this.timeout(3 * 60_000);
    await addCommandRuleFor(creds, 'rm *', 'deny');
    await startNewAgentRun();
    await tap('agent.mode.manual');
    const conversationId = await sendInNewRun(creds, DENIED);
    await waitForRunDone(creds, conversationId);
    expect(await isVisible('agent.permission.bar')).toBe(false);
    const [result] = await getToolResults(creds, conversationId);
    expect(result).toMatchObject({ ok: false, permission: { by: 'denied', rule: 'rm *' } });
    await waitForFreshText(`chat.toolCall.permission.${result.call_id}`, 'Denied by your rule');
    await shot('bash-denied-by-rule');
  });

  // Last: planning ends each turn in a plan, and its panel opens over the thread.
  it('runs read-only commands in planning mode and refuses the rest', async function () {
    this.timeout(3 * 60_000);
    await startNewAgentRun();
    await tap('agent.mode.planning');
    const reading = await sendInNewRun(creds, READ_ONLY);
    await waitForRunDone(creds, reading);
    expect((await getToolResults(creds, reading))[0]).toMatchObject({ ok: true, permission: { by: 'readonly' } });
    // The turn ended in a plan, whose panel opens by itself.
    await waitForVisible('agent.plan.panel', 60_000);
    await tap('agent.plan.close');

    await startNewAgentRun();
    await tap('agent.mode.planning');
    const writing = await sendInNewRun(creds, WRITE);
    await waitForRunDone(creds, writing);
    expect(await isVisible('agent.permission.bar')).toBe(false);
    expect((await getToolResults(creds, writing))[0]).toMatchObject({ ok: false, permission: { by: 'refused' } });
  });
});
