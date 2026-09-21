/**
 * "Processing prompt…" says what it is processing.
 *
 * The line exists because a bare elapsed counter cannot tell twenty minutes of
 * real prompt evaluation from a hung request. So the assertion is that while
 * the model has produced nothing yet, the indicator carries the prompt's
 * estimated size and — on a second turn, whose prompt extends the first's —
 * how much of it was reusable, and that it is gone once output starts.
 *
 * The mock's slow prompt holds the first token back for eight seconds, which
 * is the only way to observe this window in the mock lane at all.
 */
import { uniqueCreds } from '../helpers/auth.ts';
import { shot } from '../helpers/screenshot.ts';
import { waitForGone, waitForTextIn, waitForVisible } from '../helpers/selectors.ts';
import { SLOW_PROMPT, goToSurface, mockEcho, sendAndAwaitReply, sendMessage, signUp } from '../helpers/app.ts';

describe('the prompt-processing indicator', () => {
  const creds = uniqueCreds();

  before(async () => {
    await signUp(creds);
  });

  it('shows the prompt size and reuse while waiting for the first token', async function () {
    this.timeout(2 * 60_000);
    await goToSurface('chat');
    // A first turn, so the second has a previous request to extend.
    const opener = 'hello there';
    await sendAndAwaitReply(opener, mockEcho(opener));

    await sendMessage(SLOW_PROMPT);
    await waitForVisible('chat.status.promptStats', 20_000);
    await waitForTextIn('chat.status.promptStats', 'tokens');
    await waitForTextIn('chat.status.promptStats', '% reusable');
    await waitForTextIn('chat.status.promptStats', '(estimate)');
    await shot('prompt-stats-processing');

    // Gone the moment the model says anything.
    await waitForGone('chat.status.promptStats', 30_000);
  });
});
