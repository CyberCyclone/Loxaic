/**
 * A reply that is only a tool call, whose run goes back in the queue after its
 * approval, still says "Queued" on Chat.
 *
 * Chat has no run header: the typing indicator is the only place its queue
 * place is shown. A reply that is only tool calls has its card on screen
 * rather than the indicator (its card used to hide behind "Processing
 * prompt…"), and the first version of that change used one flag for both, so
 * the indicator disappeared with the "empty" reply. Then an approval hands the
 * slot back, another conversation takes it, and on Allow the run re-queues:
 * nothing on screen said it was waiting, and the visible tool card read as
 * though the tool was running.
 *
 * The other direction — no "Processing prompt…" under a tool that is running
 * — is `typingIndicatorFor`'s unit test: the mock's tool finishes too quickly
 * for a spec to look at it.
 */
import { provisionAdmin, uniqueCreds, apiToken, type Credentials } from '../helpers/auth.ts';
import { shot } from '../helpers/screenshot.ts';
import { browser } from '@wdio/globals';
import { platform, tap, waitForAbsent, waitForTextIn, waitForVisible } from '../helpers/selectors.ts';
import { MOCK_TOOL_DONE, SLOW_PROMPT, goToSurface, resetInferenceSettings, sendMessage, signUp } from '../helpers/app.ts';
import { BASE_URL } from '../../scripts/standup.ts';

const MODEL = 'llama-3.1-8b-instruct';
/** The mock's `fs_write`, with no "[Mock] I'll use…" before it. */
const WORDLESS_WRITE = 'without a word, write a file called notes';

/**
 * Another conversation of the same person's, sent from a connection of its
 * own and slow enough (the mock's eight seconds) to hold the only slot.
 * Resolves once it has been admitted — its first `iteration` — so the slot is
 * really taken before the case answers its approval.
 */
async function holdTheSlot(creds: Pick<Credentials, 'email' | 'password'>): Promise<{ done: Promise<void>; close: () => void }> {
  const token = await apiToken(creds);
  const ws = new WebSocket(`${BASE_URL.replace(/^http/, 'ws')}/ws/chat?token=${encodeURIComponent(token)}`);
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => { resolve(); });
    ws.addEventListener('error', () => { reject(new Error('[e2e] the slot holder could not connect')); });
  });
  let admitted!: () => void;
  const running = new Promise<void>((resolve) => { admitted = resolve; });
  const done = new Promise<void>((resolve) => {
    ws.addEventListener('message', (m) => {
      try {
        const msg = JSON.parse(String(m.data)) as { type?: string; event?: { kind?: string } };
        if (msg.type === 'stream.event' && msg.event?.kind === 'iteration') admitted();
        if (msg.type === 'stream.end') resolve();
      } catch {
        // not JSON
      }
    });
    ws.addEventListener('close', () => { resolve(); });
  });
  ws.send(JSON.stringify({ type: 'chat.send', content: SLOW_PROMPT, model: MODEL }));
  await Promise.race([
    running,
    new Promise<never>((_, reject) => setTimeout(() => { reject(new Error('[e2e] the slot holder was never admitted')); }, 20_000)),
  ]);
  return { done, close: () => { ws.close(); } };
}

describe('queued after an approval', () => {
  const creds = uniqueCreds();

  before(async () => {
    await provisionAdmin();
    // One slot, as the mock reports none: the default. Pinned by another
    // spec's leftovers, the holder would not be in the way.
    await resetInferenceSettings();
    await signUp(creds);
    // The line being looked for sits beside a spinner, and UiAutomator2 waits
    // for the UI to go idle before every query: the whole eight-second queue
    // passed during one lookup. See compaction-live.spec.ts.
    if (platform() === 'android') await browser.updateSettings({ waitForIdleTimeout: 0 });
  });

  after(async () => {
    if (platform() === 'android') await browser.updateSettings({ waitForIdleTimeout: 10_000 });
    await resetInferenceSettings();
  });

  it('says "Queued" beside a tool-only reply waiting for a slot, then runs it', async function () {
    this.timeout(3 * 60_000);

    await goToSurface('chat');
    await sendMessage(WORDLESS_WRITE);
    // Chat asks before a write. The run has handed its slot back.
    await waitForVisible('chat.approval.dialog', 30_000);
    await waitForTextIn('chat.approval.dialog', 'fs_write');

    const holder = await holdTheSlot(creds);
    try {
      await tap('chat.approval.allowOnce');
      await waitForAbsent('chat.approval.dialog');

      // Back in line behind the holder, with only the tool card to show for
      // the reply: the indicator speaks for it.
      await waitForTextIn('chat.status', 'Queued', 10_000);
      // The card is on screen too (it names the file), not hidden behind the line.
      await waitForTextIn('chat.messageList', 'notes.txt', 5_000);
      await shot('queued-after-approval');

      // Admitted once the holder finishes: the tool runs and the reply ends,
      // and nothing claims "Processing prompt…" beside a running tool.
      await holder.done;
      await waitForTextIn('chat.messageList', MOCK_TOOL_DONE, 60_000);
      await waitForAbsent('chat.status', 10_000);
      await shot('queued-after-approval-done');
    } finally {
      holder.close();
    }
  });
});
