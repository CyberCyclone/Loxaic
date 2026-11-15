/**
 * A conversation goes on after it is compacted.
 *
 * The summary used to ride as a second system message after the system
 * prompt. Chat templates from Qwen3.5 on refuse a system message anywhere but
 * first, and llama.cpp answers that with a 500, so every message after a
 * compaction failed. The mock refuses the same prompts (provider.ts), so this
 * is the whole path a person takes: talk, compact, ask again, get an answer.
 */
import { provisionUser, uniqueCreds } from '../helpers/auth.ts';
import { shot } from '../helpers/screenshot.ts';
import { waitForTextIn } from '../helpers/selectors.ts';
import { mockEcho, sendAndAwaitReply, sendMessage, signIn } from '../helpers/app.ts';

describe('after a compaction', () => {
  const creds = uniqueCreds();

  before(async function () {
    this.timeout(60_000);
    await provisionUser(creds);
    await signIn(creds);
  });

  it('answers the next message from the summary', async function () {
    this.timeout(3 * 60_000);
    await sendAndAwaitReply('first thing to remember', mockEcho('first thing to remember'));
    await sendAndAwaitReply('second thing to remember', mockEcho('second thing to remember'));

    await sendMessage('/compact keep both things');
    await waitForTextIn('chat.messageList', 'Compacted', 60_000);

    await sendAndAwaitReply('a question after the compaction', mockEcho('a question after the compaction'));
    await shot('compaction-continues-answered');
  });
});
