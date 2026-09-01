/**
 * The shared smoke suite: one pass through the paths that must never be broken
 * — sign-up, sign-in, a chat turn answered by inference, an agent tool call
 * approved through the permission bar, and sign-out.
 *
 * Written once and run unchanged on every platform. Everything platform-shaped
 * lives in the selector/app helpers, so this file is pure behaviour.
 *
 * Assertions target the mock provider's deterministic output rather than
 * anything a real model would produce, which is what makes the run repeatable.
 */
import { uniqueCreds } from '../helpers/auth.ts';
import { shot } from '../helpers/screenshot.ts';
import { expectTextAbsent, tap, waitForTextIn, waitForVisible } from '../helpers/selectors.ts';
import {
  MOCK_TOOL_DONE,
  TOOL_PROMPT,
  goToSurface,
  mockEcho,
  sendAndAwaitReply,
  sendMessage,
  signIn,
  signOut,
  signUp,
} from '../helpers/app.ts';

describe('smoke', () => {
  const creds = uniqueCreds();

  it('signs up a new user', async () => {
    await signUp(creds);
    await shot('signed-up');
  });

  it('signs out and back in with the same account', async () => {
    await signOut();
    await shot('signed-out');

    await signIn(creds);
    await shot('signed-in');
  });

  it('answers a chat message with the mock response', async () => {
    const prompt = 'hello shannon';
    await sendAndAwaitReply(prompt, mockEcho(prompt));
    await shot('chat-mock-response');
  });

  it('offers no incognito toggle in the composer', async () => {
    // #74 removed incognito entirely. The composer is the only place it was
    // ever offered, so its absence here is the user-visible proof — and the
    // regression guard against the toggle coming back without its server side.
    await expectTextAbsent('Incognito');
    await shot('composer-no-incognito');
  });

  it('runs an agent tool call once approved', async () => {
    await goToSurface('agent');
    await tap('agent.mode.manual');

    await sendMessage(TOOL_PROMPT);

    // The permission bar only renders while an approval is pending, so its
    // appearance is itself the assertion that the tool was gated, not auto-run.
    await waitForVisible('agent.permission.bar');
    await shot('permission-bar');

    await tap('agent.permission.allow');
    await waitForTextIn('chat.messageList', MOCK_TOOL_DONE);
    await shot('agent-tool-approved');
  });

  it('signs out', async () => {
    await signOut();
    await waitForVisible('login.submit');
    await shot('final-signed-out');
  });
});
