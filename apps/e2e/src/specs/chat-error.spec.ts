/**
 * A failed reply says why — and still says so after a reload.
 *
 * It used to show a red icon and nothing else, and after a reload not even
 * that: the reason rode only on the live `message.end` event, so the stored
 * row had no reason to hand back. The mock fails "fail to load the model" the
 * way LM Studio fails a model it cannot load (see MOCK_FAIL_MATCH in
 * apps/server/src/inference/provider.ts), so this runs the real failure path
 * with nothing stubbed.
 */
import { browser } from '@wdio/globals';
import { apiToken, uniqueCreds } from '../helpers/auth.ts';
import { shot } from '../helpers/screenshot.ts';
import { platform, waitForTextIn } from '../helpers/selectors.ts';
import {
  listConversations,
  mockEcho,
  selectThread,
  sendAndAwaitReply,
  sendMessage,
  signUp,
  startNewThread,
  waitForComposerReady,
} from '../helpers/app.ts';
import { BASE_URL } from '../../scripts/standup.ts';

/** Trips the mock's failure. */
const FAIL_PROMPT = 'please fail to load the model';
/** The reason the mock throws — shaped like LM Studio's own HTTP 400 message. */
const FAIL_REASON = 'Failed to load model "mock-model". Error: the mock backend was asked to fail this turn.';

describe('a failed chat reply', () => {
  const creds = uniqueCreds();

  before(async () => {
    await signUp(creds);
  });

  it('shows the reason it failed', async () => {
    await sendMessage(FAIL_PROMPT);
    await waitForTextIn('chat.message.error', FAIL_REASON);
    await shot('chat-error-live');
  });

  it('still shows the reason after a reload', async function () {
    // The reason is on the stored row, which is the fix: before it, the row
    // said `error` and nothing more.
    const [conv] = await listConversations(creds);
    const res = await fetch(`${BASE_URL}/v1/conversations/${conv.id}/messages`, {
      headers: { authorization: `Bearer ${await apiToken(creds)}` },
    });
    const body = (await res.json()) as { messages: { authorType: string; status: string; error: string | null }[] };
    const failed = body.messages.find((m) => m.authorType === 'assistant');
    expect(failed?.status).toBe('error');
    expect(failed?.error).toBe(FAIL_REASON);

    // A page reload is what a person does; native has no equivalent that
    // leaves the session in place, and the stored reason is already asserted
    // above for every platform.
    const p = platform();
    if (p !== 'web' && p !== 'electron') this.skip();

    // Drop the client's offline copy first. It holds the message exactly as
    // the live event left it, so rendering from it would pass this assertion
    // without the history path — the one that used to lose the reason — ever
    // being exercised.
    await browser.execute(() => {
      for (const key of Object.keys(window.localStorage)) {
        if (key.startsWith('loxaic-cache:')) window.localStorage.removeItem(key);
      }
    });
    await browser.refresh();
    await waitForComposerReady();
    await selectThread(conv.id);

    await waitForTextIn('chat.message.error', FAIL_REASON);
    await shot('chat-error-after-reload');
  });

  it('shows a failed compaction as failed, and still does after a reload', async function () {
    const [failedTurn] = await listConversations(creds);
    await startNewThread('chat');
    const opener = 'something worth compacting';
    await sendAndAwaitReply(opener, mockEcho(opener));
    // Guidance rides in the summarisation instruction, which is the compaction
    // prompt's last user turn — the one the mock's failure trigger reads.
    await sendMessage(`/compact ${FAIL_PROMPT}`);
    await waitForTextIn('chat.compaction.error', FAIL_REASON);
    await shot('compaction-error-live');

    const conv = (await listConversations(creds)).find((c) => c.id !== failedTurn.id);
    if (!conv) throw new Error('the compacted conversation was not listed');
    const res = await fetch(`${BASE_URL}/v1/conversations/${conv.id}/messages`, {
      headers: { authorization: `Bearer ${await apiToken(creds)}` },
    });
    const body = (await res.json()) as { messages: { authorType: string; status: string; error: string | null }[] };
    const summary = body.messages.find((m) => m.authorType === 'summary');
    expect(summary?.status).toBe('error');
    expect(summary?.error).toBe(FAIL_REASON);

    const p = platform();
    if (p !== 'web' && p !== 'electron') this.skip();

    // The failure this guards against was reload-only: a failed summary row
    // has no stats, and the card read "no stats" as still compacting.
    await browser.execute(() => {
      for (const key of Object.keys(window.localStorage)) {
        if (key.startsWith('loxaic-cache:')) window.localStorage.removeItem(key);
      }
    });
    await browser.refresh();
    await waitForComposerReady();
    await selectThread(conv.id);

    await waitForTextIn('chat.compaction.error', FAIL_REASON);
    await shot('compaction-error-after-reload');
  });
});
