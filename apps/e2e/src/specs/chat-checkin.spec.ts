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
import { uniqueCreds } from '../helpers/auth.ts';
import { shot } from '../helpers/screenshot.ts';
import { tap, waitForGone, waitForTextIn, waitForVisible } from '../helpers/selectors.ts';
import {
  ANSWER_NOW_TEXT,
  CHECKIN_SCENARIO_PROMPT,
  getToolResults,
  goToSurface,
  listConversations,
  patchPrefs,
  sendMessage,
  signUp,
  waitForRunDone,
} from '../helpers/app.ts';

describe('a chat turn that pauses to ask whether to keep going', () => {
  const creds = uniqueCreds();

  before(async () => {
    await signUp(creds);
    await patchPrefs(creds, { maxIterations: 1 });
  });

  after(async () => {
    await patchPrefs(creds, { maxIterations: 100 });
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
});
