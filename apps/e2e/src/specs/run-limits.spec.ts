/**
 * A conversation's own step limit and loop check: two switches in the
 * composer's `+` menu that stop one kind of check-in each, for that chat alone,
 * and can be flipped either way at any point, in the middle of a run included.
 *
 * Each budget case sets a step limit of 1 against a scenario of two steps, so a
 * run that does not pause is the switch working and nothing else.
 */
import { browser } from '@wdio/globals';
import { BASE_URL } from '../../scripts/standup.ts';
import { apiToken, uniqueCreds } from '../helpers/auth.ts';
import { shot } from '../helpers/screenshot.ts';
import { byTestId, isVisible, platform, tap, waitForGone, waitForSwitch, waitForTextIn, waitForVisible } from '../helpers/selectors.ts';
import {
  CHECKIN_SCENARIO_DONE,
  CHECKIN_SCENARIO_PROMPT,
  LOOP_SCENARIO_PROMPT,
  chooseScratchWorkspace,
  closePlusMenu,
  getToolResults,
  goToSurface,
  listConversations,
  openPlusMenu,
  patchPrefs,
  selectThread,
  sendMessage,
  signUp,
  startNewAgentRun,
  startNewThread,
  waitForComposerReady,
  waitForRunDone,
} from '../helpers/app.ts';

const WRITE_TWO_FILES = 'Write two files, asking each time.';
const STEP_LIMIT = 'composer.plus.stepLimit';
const LOOP_CHECK = 'composer.plus.loopCheck';

type Surface = 'chat' | 'agent';

async function newThread(surface: Surface, mode: 'auto' | 'manual' = 'auto'): Promise<void> {
  await goToSurface(surface);
  if (surface === 'chat') {
    await startNewThread('chat');
    return;
  }
  await startNewAgentRun();
  await chooseScratchWorkspace();
  await tap(`agent.mode.${mode}`);
}

/** Opens the `+` menu, flips one switch and waits for the row to say so. */
async function flip(id: string, on: boolean): Promise<void> {
  await openPlusMenu();
  await waitForSwitch(id, !on);
  await tap(id);
  await waitForSwitch(id, on);
  await closePlusMenu();
}

/** Sends into the thread on screen, new so far, and says which it is: until the
 * send lands the newest row is the last case's. */
async function sendInNewThread(creds: { email: string; password: string }, prompt: string): Promise<string> {
  const before = new Set((await listConversations(creds)).map((c) => c.id));
  await sendMessage(prompt);
  let id = '';
  await browser.waitUntil(
    async () => {
      id = (await listConversations(creds)).find((c) => !before.has(c.id))?.id ?? '';
      return id !== '';
    },
    { timeout: 20_000, timeoutMsg: 'the new thread never reached the conversation list' },
  );
  return id;
}

/** The same PATCH from a connection of its own, as the owner's other device. */
async function switchElsewhere(creds: { email: string; password: string }, conversationId: string, body: Record<string, boolean>): Promise<void> {
  const res = await fetch(`${BASE_URL}/v1/conversations/${conversationId}`, {
    method: 'PATCH',
    headers: { authorization: `Bearer ${await apiToken(creds)}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`[e2e] limits patch failed (${String(res.status)}): ${await res.text()}`);
}

describe('a chat turns its own step limit and loop check off and on', () => {
  const creds = uniqueCreds();

  before(async () => {
    await signUp(creds);
  });

  after(async () => {
    await patchPrefs(creds, { maxIterations: 100 });
  });

  for (const surface of ['chat', 'agent'] as const) {
    it(`runs past the limit when it was turned off before the first message, and remembers (${surface})`, async function () {
      this.timeout(3 * 60_000);
      await patchPrefs(creds, { maxIterations: 1 });
      await newThread(surface);

      await openPlusMenu();
      await waitForSwitch(STEP_LIMIT, true);
      await waitForSwitch(LOOP_CHECK, true);
      await tap(STEP_LIMIT);
      await waitForSwitch(STEP_LIMIT, false);
      await waitForTextIn(`${STEP_LIMIT}.state`, 'Off for this chat');
      await shot(`run-limits-off-${surface}`);
      await closePlusMenu();

      const conversationId = await sendInNewThread(creds, CHECKIN_SCENARIO_PROMPT);
      await waitForRunDone(creds, conversationId);
      // The header on Agent: with a keyboard up, a phone's agent thread is a
      // sliver under the banner and the reply is off it.
      if (surface === 'chat') await waitForTextIn('chat.messageList', CHECKIN_SCENARIO_DONE, 90_000);
      else await waitForTextIn('agent.run.status', 'Done', 90_000);
      expect(await isVisible('checkin.banner')).toBe(false);
      expect((await getToolResults(creds, conversationId)).length).toBe(2);

      // It belongs to the conversation, not the session.
      if (platform() === 'web' || platform() === 'electron') {
        await browser.refresh();
        await waitForComposerReady();
      }
      await goToSurface(surface);
      await selectThread(conversationId, surface);
      await openPlusMenu();
      await waitForSwitch(STEP_LIMIT, false);
      await waitForSwitch(LOOP_CHECK, true);
      await closePlusMenu();

      // ...and to that one: a new chat starts with its limits on.
      await newThread(surface);
      await openPlusMenu();
      await waitForSwitch(STEP_LIMIT, true);
      await closePlusMenu();
    });

    it(`answers a waiting check-in when the step limit is turned off, and only then (${surface})`, async function () {
      this.timeout(3 * 60_000);
      await patchPrefs(creds, { maxIterations: 1 });
      await newThread(surface);
      await sendMessage(CHECKIN_SCENARIO_PROMPT);
      await waitForVisible('checkin.banner', 90_000);
      await waitForTextIn('checkin.reason', 'step');

      // The other switch is no answer to this question.
      await flip(LOOP_CHECK, false);
      expect(await isVisible('checkin.banner')).toBe(true);
      await shot(`run-limits-other-switch-${surface}`);

      await openPlusMenu();
      await tap(STEP_LIMIT);
      await waitForSwitch(STEP_LIMIT, false);
      await closePlusMenu();
      await waitForGone('checkin.banner');
      await waitForTextIn('chat.messageList', CHECKIN_SCENARIO_DONE, 90_000);

      const [conversation] = await listConversations(creds);
      await waitForRunDone(creds, conversation.id);
      expect((await getToolResults(creds, conversation.id)).length).toBe(2);
      if (surface === 'agent') {
        await waitForTextIn('agent.run.status', 'Done');
      }
    });
  }

  for (const surface of ['chat', 'agent'] as const) {
    it(`follows a switch flipped on another device, with the menu open (${surface})`, async function () {
      this.timeout(2 * 60_000);
      await patchPrefs(creds, { maxIterations: 100 });
      await newThread(surface);
      const conversationId = await sendInNewThread(creds, 'nothing to do here');
      await waitForRunDone(creds, conversationId);

      await openPlusMenu();
      await waitForSwitch(STEP_LIMIT, true);
      await waitForSwitch(LOOP_CHECK, true);
      await switchElsewhere(creds, conversationId, { step_limit_off: true, loop_check_off: true });
      await waitForSwitch(STEP_LIMIT, false);
      await waitForSwitch(LOOP_CHECK, false);
      await switchElsewhere(creds, conversationId, { step_limit_off: false });
      await waitForSwitch(STEP_LIMIT, true);
      await waitForSwitch(LOOP_CHECK, false);
      await closePlusMenu();
    });
  }

  it('counts steps with no limit while it is off', async function () {
    this.timeout(3 * 60_000);
    await patchPrefs(creds, { maxIterations: 1 });
    await newThread('agent');
    await flip(STEP_LIMIT, false);
    await sendMessage(LOOP_SCENARIO_PROMPT);

    // The loop check is still on, and a run waiting on it shows its count.
    await waitForVisible('checkin.banner', 90_000);
    await waitForTextIn('checkin.reason', 'loop');
    await waitForTextIn('agent.run.status', 'Waiting for you · 3');
    const status = await byTestId('agent.run.status').getText();
    if (status.includes('/')) throw new Error(`a run with no step limit still counts towards one: "${status}"`);
    await shot('run-limits-count-with-no-limit');

    await tap('checkin.stop');
    await waitForGone('checkin.banner');
    const [conversation] = await listConversations(creds);
    await waitForRunDone(creds, conversation.id);
  });

  it('pauses again once the step limit is back on, in the middle of a run', async function () {
    this.timeout(3 * 60_000);
    await patchPrefs(creds, { maxIterations: 1 });
    await newThread('agent', 'manual');
    await flip(STEP_LIMIT, false);
    await sendMessage(WRITE_TWO_FILES);

    // Step one, and a limit of 1 does not stop it: it reaches the second approval.
    await waitForVisible('agent.permission.bar', 60_000);
    await tap('agent.permission.allow');
    // By its file: on a fast lane the second bar replaces the first with no gap.
    await waitForTextIn('agent.permission.bar', 'second.txt', 60_000);

    await flip(STEP_LIMIT, true);
    await tap('agent.permission.allow');

    // One window on from the step it was last off at.
    await waitForVisible('checkin.banner', 60_000);
    await waitForTextIn('checkin.reason', 'step');
    await waitForTextIn('agent.run.status', 'Waiting for you · 2/2');
    await shot('run-limits-back-on');
    await tap('checkin.continue');
    await waitForGone('checkin.banner');
    const [conversation] = await listConversations(creds);
    await waitForRunDone(creds, conversation.id);
  });

  it('answers a waiting loop check when it is turned off, and pauses on the next run once it is back on', async function () {
    this.timeout(4 * 60_000);
    await patchPrefs(creds, { maxIterations: 100 });
    await newThread('agent');
    await sendMessage(LOOP_SCENARIO_PROMPT);
    await waitForVisible('checkin.banner', 90_000);
    await waitForTextIn('checkin.reason', 'loop');
    await waitForTextIn('agent.run.status', 'Waiting for you · 3/100');

    await flip(LOOP_CHECK, false);
    await waitForGone('checkin.banner');
    const [conversation] = await listConversations(creds);
    await waitForRunDone(creds, conversation.id);
    await waitForTextIn('agent.run.status', 'Done', 60_000);
    await shot('run-limits-loop-off');

    await flip(LOOP_CHECK, true);
    await sendMessage(LOOP_SCENARIO_PROMPT);
    await waitForVisible('checkin.banner', 90_000);
    await waitForTextIn('checkin.reason', 'loop');
    await tap('checkin.stop');
    await waitForGone('checkin.banner');
    await waitForRunDone(creds, conversation.id);
  });
});
