/**
 * Two conversations, one model server: the second waits and is told so.
 *
 * The behaviour under test is invisible from inside a single conversation —
 * each one's own prompt still extends the last perfectly while two of them
 * alternate, which is exactly what evicts the backend's cached prefix on every
 * request. So this drives two real conversations through the UI and asserts on
 * what the waiting one is shown, which is also the only part a user ever sees.
 */
import { adminCreds, provisionAdmin } from '../helpers/auth.ts';
import { shot } from '../helpers/screenshot.ts';
import { tap, waitForTextIn, waitForVisible } from '../helpers/selectors.ts';
import {
  SLOW_PROMPT,
  goToSurface,
  openSandboxSettings,
  resetInferenceSettings,
  sendMessage,
  signIn,
  startNewAgentRun,
} from '../helpers/app.ts';

describe('run queue', () => {
  before(async () => {
    await provisionAdmin();
    // Concurrency is persisted server state that outlives the process, so
    // start from a known value rather than trusting the previous run's
    // cleanup — the same reasoning the sandbox specs have for mode.
    await resetInferenceSettings();
    await signIn(adminCreds());
  });

  after(async () => {
    await resetInferenceSettings();
  });

  it('tells the second conversation it is waiting, then runs it', async function () {
    this.timeout(3 * 60_000);

    await goToSurface('agent');
    await startNewAgentRun();
    // Deliberately slow, so it is still holding the backend when the next
    // conversation asks for it.
    await sendMessage(SLOW_PROMPT);
    await waitForTextIn('agent.run.status', 'Running');

    // A second conversation, started while the first is still going.
    await startNewAgentRun();
    await sendMessage('hello from the second conversation');

    // The point of the whole stage: it is not running, and it says why and
    // where it stands rather than looking indistinguishable from a stalled
    // one.
    await waitForTextIn('agent.run.status', 'Queued');
    await waitForTextIn('agent.run.status', '#1');
    await shot('run-queue-second-waiting');

    // And it does eventually run — a queue that never drains would satisfy
    // every assertion above.
    await waitForTextIn('chat.messageList', 'hello from the second conversation');
    await waitForTextIn('agent.run.status', 'Done');
    await shot('run-queue-second-ran');
  });

  it('lets an admin see what the limit resolves to, and pin it', async () => {
    await openSandboxSettings();

    // "Automatic" on its own would leave an admin unable to tell whether their
    // `--parallel 4` was picked up, so the resolved number is on screen with
    // it. The mock backend reports no slots, which is one.
    await waitForVisible('inference.concurrency.auto');
    await waitForTextIn('inference.concurrency.explainer', 'Following the model server');

    await tap('inference.concurrency.2');
    await waitForTextIn('inference.concurrency.explainer', 'Pinned to 2');
    await shot('run-queue-settings');
  });
});
