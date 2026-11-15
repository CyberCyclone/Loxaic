/**
 * A conversation's own progress-review switch, in the composer's `+` menu: off
 * for that chat alone, set before its first message or at any point after,
 * and followed by the owner's other devices.
 *
 * Reviews are set to every three steps against a stuck drill of twelve, so a
 * run that reaches all twelve with no note is the switch working and nothing
 * else.
 */
import { browser } from '@wdio/globals';
import { BASE_URL } from '../../scripts/standup.ts';
import { apiToken, uniqueCreds } from '../helpers/auth.ts';
import { shot } from '../helpers/screenshot.ts';
import { isVisible, platform, tap, waitForSwitch, waitForTextIn } from '../helpers/selectors.ts';
import {
  REVIEW_STUCK_PROMPT,
  chooseScratchWorkspace,
  closePlusMenu,
  getMessageTexts,
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

const SWITCH = 'composer.plus.progressReview';

type Surface = 'chat' | 'agent';

async function newThread(surface: Surface): Promise<void> {
  await goToSurface(surface);
  if (surface === 'chat') {
    await startNewThread('chat');
    return;
  }
  await startNewAgentRun();
  await chooseScratchWorkspace();
  await tap('agent.mode.auto');
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
async function switchElsewhere(creds: { email: string; password: string }, conversationId: string, off: boolean): Promise<void> {
  const res = await fetch(`${BASE_URL}/v1/conversations/${conversationId}`, {
    method: 'PATCH',
    headers: { authorization: `Bearer ${await apiToken(creds)}`, 'content-type': 'application/json' },
    body: JSON.stringify({ progress_review_off: off }),
  });
  if (!res.ok) throw new Error(`[e2e] switch patch failed (${String(res.status)}): ${await res.text()}`);
}

describe("a chat's own progress review switch", () => {
  const creds = uniqueCreds();

  before(async () => {
    await signUp(creds);
    await patchPrefs(creds, { progressReview: true, progressCheckSteps: 3 });
  });

  after(async () => {
    await patchPrefs(creds, { progressCheckSteps: null });
  });

  for (const surface of ['chat', 'agent'] as const) {
    it(`lets a run go unreviewed when it was turned off before the first message, and remembers (${surface})`, async function () {
      this.timeout(3 * 60_000);
      await newThread(surface);

      await openPlusMenu();
      await waitForSwitch(SWITCH, true);
      await waitForTextIn(`${SWITCH}.state`, 'An AI check steps in');
      await tap(SWITCH);
      await waitForSwitch(SWITCH, false);
      await waitForTextIn(`${SWITCH}.state`, 'Off for this chat');
      await shot(`progress-review-switch-off-${surface}`);
      await closePlusMenu();

      const conversationId = await sendInNewThread(creds, REVIEW_STUCK_PROMPT);
      await waitForRunDone(creds, conversationId, 150_000);
      // Stuck all the way, and never reviewed: every step ran, and no note.
      expect((await getToolResults(creds, conversationId)).length).toBe(12);
      expect((await getMessageTexts(creds, conversationId)).filter((t) => t.startsWith('[Progress check] '))).toEqual([]);
      expect(await isVisible('progress.note')).toBe(false);

      // It belongs to the conversation, not the session.
      if (platform() === 'web' || platform() === 'electron') {
        await browser.refresh();
        await waitForComposerReady();
      }
      await goToSurface(surface);
      await selectThread(conversationId, surface);
      await openPlusMenu();
      await waitForSwitch(SWITCH, false);
      await closePlusMenu();

      // ...and to that one: a new chat starts with the review on.
      await newThread(surface);
      await openPlusMenu();
      await waitForSwitch(SWITCH, true);
      await closePlusMenu();
    });

    it(`follows a switch flipped on another device, with the menu open (${surface})`, async function () {
      this.timeout(2 * 60_000);
      await newThread(surface);
      const conversationId = await sendInNewThread(creds, 'nothing to do here');
      await waitForRunDone(creds, conversationId);

      await openPlusMenu();
      await waitForSwitch(SWITCH, true);
      await switchElsewhere(creds, conversationId, true);
      await waitForSwitch(SWITCH, false);
      await switchElsewhere(creds, conversationId, false);
      await waitForSwitch(SWITCH, true);
      await closePlusMenu();
    });
  }
});
