/**
 * #193: the context meter has something to show as soon as a request has
 * finished — not only once the whole turn has.
 *
 * Usage used to reach the client only on a turn's final `message.end`, and a
 * tool-calling message's `message.end` waits for its tools. So a conversation's
 * first turn showed an empty meter for as long as the turn lasted, and in
 * manual mode that is as long as nobody answers the approval.
 *
 * This parks the first turn of a new agent run at an approval and opens the
 * meter's breakdown there. Its "Last turn" rows render only from a message
 * that carries usage, so before the fix they were absent for this entire wait.
 * The ring's own percentage cannot carry the assertion: the mock reports ten
 * prompt tokens, which rounds to 0% against any window.
 */
import { browser } from '@wdio/globals';
import { uniqueCreds } from '../helpers/auth.ts';
import { shot } from '../helpers/screenshot.ts';
import { byTestId, platform, tap, waitForGone, waitForVisible } from '../helpers/selectors.ts';
import { TOOL_PROMPT, goToSurface, sendMessage, signUp, startNewAgentRun } from '../helpers/app.ts';

describe('the context meter during a turn', () => {
  const creds = uniqueCreds();

  before(async () => {
    await signUp(creds);
  });

  it('reports the request that is waiting on an approval', async function () {
    this.timeout(2 * 60_000);
    // Overlay testIDs are not visible to the iOS driver (a known harness
    // limit), and the breakdown is a popover.
    if (platform() === 'ios') this.skip();

    await goToSurface('agent');
    await startNewAgentRun();
    await tap('agent.mode.manual');
    await sendMessage(TOOL_PROMPT);
    // Parked: the request has finished and its tool call is unanswered, so
    // this message's message.end has not been sent.
    await waitForVisible('agent.permission.bar', 60_000);

    await tap('composer.context');
    await waitForVisible('context.lastTurn.tokensIn');
    expect(await byTestId('context.lastTurn.tokensIn').getText()).toMatch(/\d/);
    await shot('context-live-while-approval-pending');

    // Close the popover before answering, so the tap lands on the bar.
    if (platform() === 'web' || platform() === 'electron') await browser.keys('Escape');
    else await tap('composer.context');
    await waitForGone('context.lastTurn.tokensIn');
    await tap('agent.permission.deny');
    await waitForGone('agent.permission.bar');
  });
});
