/**
 * An admin reading what a conversation's sub-agents did.
 *
 * A sub-agent's conversation is listed nowhere — not in its owner's threads,
 * not in the admin's list — and is reached only through its parent. The owner
 * has the card and the Sub-agents list; the admin screen had nothing, so the
 * transcripts holding most of what an agent run actually did could not be
 * found, least of all for a conversation kept after its owner deleted it
 * (which the unit suite covers: the same route, on a deleted row).
 */
import { browser } from '@wdio/globals';
import { provisionAdmin, uniqueCreds } from '../helpers/auth.ts';
import { shot } from '../helpers/screenshot.ts';
import { platform, scrollTo, tap, waitForAbsent, waitForTextIn, waitForVisible } from '../helpers/selectors.ts';
import {
  MOCK_SUBAGENT_NAME,
  goToSurface,
  sendInNewRun,
  signIn,
  signOut,
  signUp,
  waitForRunDone,
  waitForSubAgents,
} from '../helpers/app.ts';

describe('Admin: a conversation’s sub-agents', () => {
  const user = uniqueCreds();
  let admin: Awaited<ReturnType<typeof provisionAdmin>>;
  let convId = '';
  let childId = '';

  before(async () => {
    admin = await provisionAdmin();
    await signUp(user);
    if (platform() === 'android') await browser.updateSettings({ waitForIdleTimeout: 0 });
  });

  after(async () => {
    if (platform() === 'android') await browser.updateSettings({ waitForIdleTimeout: 10_000 });
  });

  it('lists a conversation’s sub-agents and shows one’s transcript in place of the conversation’s', async function () {
    this.timeout(4 * 60_000);

    await goToSurface('agent');
    await tap('agent.mode.auto');
    convId = await sendInNewRun(user, 'Use a sub-agent: say the audit trail works');
    const [child] = await waitForSubAgents(user, convId, 1);
    childId = child.conversation_id;
    await waitForRunDone(user, convId, 90_000);
    await signOut();

    await signIn(admin);
    await goToSurface('admin');
    await tap(`admin.conversation.${convId}`);
    // The conversation's own transcript first, as always…
    await waitForTextIn('admin.transcript', 'Use a sub-agent: say the audit trail works');
    // …and now its sub-agents, which nothing else on this screen lists.
    await scrollTo(`admin.subagent.${childId}`);
    await waitForTextIn(`admin.subagent.${childId}`, MOCK_SUBAGENT_NAME);
    await shot('admin-subagents-listed');

    await tap(`admin.subagent.${childId}`);
    await waitForTextIn('admin.transcript.subagent', MOCK_SUBAGENT_NAME);
    // The child's own messages: the task it was handed and what it replied.
    await waitForTextIn('admin.transcript', '[Mock] Echo: say the audit trail works', 20_000);
    await shot('admin-subagent-transcript');

    await scrollTo('admin.transcript.backToConversation');
    await tap('admin.transcript.backToConversation');
    await waitForAbsent('admin.transcript.subagent');
    await waitForTextIn('admin.transcript', 'Use a sub-agent: say the audit trail works', 20_000);
    await waitForVisible(`admin.subagent.${childId}`);
  });
});
