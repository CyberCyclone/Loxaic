/**
 * Chat pauses to ask too.
 *
 * Chat and agent share one tool loop, so a chat turn reaches the same step
 * budget the agent surface does — but chat has no run header, no mode
 * selector, and its own approval state keyed by conversation rather than flat.
 * Every one of those is a place the question could be dropped on this surface
 * while working perfectly on the other, which is the whole reason this is a
 * separate spec rather than a case in agent-checkin.spec.ts.
 *
 * `todo_write` is read-only, so it runs without an approval in chat's
 * always-manual mode — which is what lets the same scenario drive both.
 */
import { browser } from '@wdio/globals';
import { uniqueCreds } from '../helpers/auth.ts';
import { shot } from '../helpers/screenshot.ts';
import { platform, tap, waitForGone, waitForTextIn, waitForVisible } from '../helpers/selectors.ts';
import {
  ANSWER_NOW_TEXT,
  CHECKIN_SCENARIO_PROMPT,
  getToolResults,
  goToSurface,
  listConversations,
  patchPrefs,
  selectThread,
  sendMessage,
  signUp,
  startNewThread,
  waitForComposerReady,
  waitForRunDone,
} from '../helpers/app.ts';

/** The shortest window the server accepts. Per user, so no other spec waits
 * on it — the reason these cases can exist at all now that the window is not
 * a process-wide environment variable. */
const SHORT_WAIT_MS = 5_000;

describe('a chat turn that pauses to ask whether to keep going', () => {
  const creds = uniqueCreds();

  before(async () => {
    await signUp(creds);
    await patchPrefs(creds, { maxIterations: 1 });
  });

  after(async () => {
    await patchPrefs(creds, {
      maxIterations: 100,
      checkinTimeoutMs: null,
      checkinAutoContinues: 2,
      adaptiveTimeout: true,
    });
  });

  it('asks above the composer, and answers with what it has', async function () {
    this.timeout(3 * 60_000);

    await goToSurface('chat');
    await sendMessage(CHECKIN_SCENARIO_PROMPT);

    await waitForVisible('checkin.banner', 90_000);
    await waitForTextIn('checkin.reason', 'step');
    // Stop is offered here as well as on the banner: the composer's own Stop
    // is what a parked run is still stoppable by, and it must not have
    // reverted to Send while the question is up.
    await waitForVisible('composer.stop');
    await shot('chat-checkin-banner');

    await tap('checkin.answer');
    await waitForGone('checkin.banner');
    await waitForTextIn('chat.messageList', ANSWER_NOW_TEXT, 90_000);
    await waitForVisible('chat.message.checkinNudge');
    // The turn is over, so the composer offers Send again.
    await waitForVisible('composer.send');
    await shot('chat-checkin-answered');

    const [conversation] = await listConversations(creds);
    await waitForRunDone(creds, conversation.id);
    const results = await getToolResults(creds, conversation.id);
    if (results.length !== 1) {
      throw new Error(`expected only the first step to have run, got ${String(results.length)}`);
    }
  });

  it('says nobody answered when the check-in times out — live, and after a reload', async function () {
    this.timeout(3 * 60_000);
    await patchPrefs(creds, { checkinTimeoutMs: SHORT_WAIT_MS, checkinAutoContinues: 0, adaptiveTimeout: false });

    await startNewThread('chat');
    await sendMessage(CHECKIN_SCENARIO_PROMPT);
    await waitForVisible('checkin.banner', 90_000);
    // The question says what will happen, and when, before it happens.
    await waitForTextIn('checkin.deadline', "I'll wrap up with what I have");
    await shot('chat-checkin-deadline');

    // Nobody answers.
    await waitForGone('checkin.banner', 30_000);
    await waitForTextIn('chat.message.checkinNudge', 'Nobody answered the check-in');
    await shot('chat-checkin-timed-out');

    // From history, with the offline copy dropped so the REST path — the
    // row's null author — is what renders.
    const [conversation] = await listConversations(creds);
    await waitForRunDone(creds, conversation.id);
    const p = platform();
    if (p === 'web' || p === 'electron') {
      await browser.execute(() => {
        for (const key of Object.keys(window.localStorage)) {
          if (key.startsWith('loxaic-cache:')) window.localStorage.removeItem(key);
        }
      });
      await browser.refresh();
      await waitForComposerReady();
      await selectThread(conversation.id);
      await waitForTextIn('chat.message.checkinNudge', 'Nobody answered the check-in');
      await shot('chat-checkin-timed-out-after-reload');
    }
  });

  it('keeps going on its own when allowed, and says so', async function () {
    this.timeout(3 * 60_000);
    // One auto-continue against a two-step scenario at one step per window:
    // the first check-in keeps going, the second wraps up.
    await patchPrefs(creds, { checkinTimeoutMs: SHORT_WAIT_MS, checkinAutoContinues: 1, adaptiveTimeout: false });

    await startNewThread('chat');
    await sendMessage(CHECKIN_SCENARIO_PROMPT);
    await waitForVisible('checkin.banner', 90_000);
    await waitForTextIn('checkin.deadline', "I'll keep going (1 of 1)");
    await shot('chat-checkin-auto-continue-deadline');

    await waitForTextIn('chat.message.autoContinued', 'so it kept going (1 of 1', 60_000);
    await waitForTextIn('chat.message.checkinNudge', 'Nobody answered the check-in', 60_000);
    await shot('chat-checkin-auto-continued');

    const [conversation] = await listConversations(creds);
    await waitForRunDone(creds, conversation.id);
    // Both steps ran: the first unanswered check-in granted another window.
    const results = await getToolResults(creds, conversation.id);
    if (results.length !== 2) {
      throw new Error(`expected both steps to have run, got ${String(results.length)}`);
    }
  });
});
