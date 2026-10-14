/**
 * Running status in the chat list (#282).
 *
 * A thread-list row says what its conversation's run is doing — Running,
 * Queued · #N, Awaiting approval — including for runs this screen did not
 * start: one it switched away from, another device's send, a routine's run.
 * The badges come from the run registry through the socket's liveness watch
 * (`conversations.watch`), so what a row shows is the server's own answer to
 * "is a run going here", not a guess from message statuses.
 *
 * Assertions key on `threadList.run.<conversationId>.<state>` — the state is
 * part of the id, because on native a container's text is not searchable and
 * a text probe would match the open run's own header instead of the row.
 * The words themselves are pinned in lib/runStateCopy.test.ts.
 */
import { browser, expect } from '@wdio/globals';
import { adminCreds, provisionAdmin } from '../helpers/auth.ts';
import { shot } from '../helpers/screenshot.ts';
import { isVisible, tap, waitForAbsent, waitForFreshText, waitForTextIn, waitForVisible } from '../helpers/selectors.ts';
import {
  MOCK_TOOL_DONE,
  SLOW_PROMPT,
  TOOL_PROMPT,
  createRoutine,
  goToSurface,
  listConversations,
  openThreadList,
  resetInferenceSettings,
  runRoutine,
  selectThread,
  sendOnSecondSocket,
  sendMessage,
  signIn,
  startNewAgentRun,
  waitForComposerReady,
  waitForRunDone,
} from '../helpers/app.ts';

/** The mock waits eight seconds: long enough to open the list mid-run,
 * switch threads, or let a second conversation see the queue. */
const TOOL_ASK_PROMPT = `take your time and ${TOOL_PROMPT}`;

const runBadge = (conversationId: string, state: string) => `threadList.run.${conversationId}.${state}`;

/** Starts what becomes a new conversation and returns its server id once the
 * list has it (set-difference, the pattern `sendInNewRun` uses). */
async function sendAndCapture(prompt: string): Promise<string> {
  const before = new Set((await listConversations(adminCreds())).map((c) => c.id));
  await sendMessage(prompt);
  let id = '';
  await browser.waitUntil(
    async () => {
      id = (await listConversations(adminCreds())).find((c) => !before.has(c.id))?.id ?? '';
      return id !== '';
    },
    { timeout: 30_000, timeoutMsg: '[e2e] the new conversation never appeared in the list' },
  );
  return id;
}

describe('running status in the thread list', () => {
  // Admin because the queue case resets the inference settings, and the
  // settings endpoint answers admin creds only — the same choice
  // run-queue.spec.ts makes.
  before(async () => {
    await provisionAdmin();
    await resetInferenceSettings();
    await signIn(adminCreds());
  });

  after(async () => {
    await resetInferenceSettings();
  });

  it('badges a chat row while its run is going, and clears when it ends', async function () {
    this.timeout(3 * 60_000);
    await goToSurface('chat');
    await waitForComposerReady();
    // A second thread to switch to, so the badge is read from a conversation
    // other than the one running.
    const idleChat = await sendAndCapture('a thread to switch back to');
    await waitForRunDone(adminCreds(), idleChat);

    const running = await sendAndCapture(SLOW_PROMPT);
    await openThreadList('chat');
    await waitForVisible(runBadge(running, 'running'));
    await shot('thread-list-running');

    // Switch away: the run goes on unwatched by any stream tap, and the row
    // keeps telling the truth from the watch alone.
    await selectThread(idleChat, 'chat');
    await openThreadList('chat');
    await waitForVisible(runBadge(running, 'running'));

    await waitForRunDone(adminCreds(), running);
    // The row goes idle: no badge element at all, and the ordinary row is
    // still there to open.
    await waitForAbsent(runBadge(running, 'running'));
    await waitForVisible(`threadList.item.${running}`);
    await shot('thread-list-cleared');
  });

  it('badges a run started on another device, never sent from this one', async function () {
    this.timeout(3 * 60_000);
    // Another socket for the same user, sending into a thread this screen
    // already lists: the run reaches it only through the watch.
    await goToSurface('chat');
    // A chat-kind row (the listing carries both surfaces' rows), and one
    // with no run going — the previous case's runs have all been awaited.
    const someChat = (await listConversations(adminCreds())).find((c) => c.kind !== 'agent');
    if (!someChat) throw new Error('[e2e] no chat to send into');
    const other = await sendOnSecondSocket(adminCreds(), SLOW_PROMPT, 'chat', someChat.id);
    try {
      await openThreadList('chat');
      await waitForVisible(runBadge(someChat.id, 'running'));
      await shot('thread-list-another-device');
      await waitForRunDone(adminCreds(), other.conversationId);
      await waitForAbsent(runBadge(someChat.id, 'running'));
    } finally {
      other.close();
    }
  });

  it('says Awaiting approval on a run parked on a person elsewhere in the list', async function () {
    this.timeout(4 * 60_000);
    await goToSurface('agent');
    await waitForComposerReady();
    await startNewAgentRun();
    const run = await sendAndCapture(TOOL_ASK_PROMPT);

    // Away while it is still thinking; the question arrives in the
    // background, and the row must change state without this screen ever
    // opening the run.
    await startNewAgentRun();
    await waitForComposerReady();
    await openThreadList('agent');
    await waitForVisible(runBadge(run, 'running'));
    await waitForVisible(runBadge(run, 'awaiting_approval'), 30_000);
    await shot('thread-list-awaiting-approval');

    // Answering from the run's own thread clears the row's word.
    await selectThread(run, 'agent');
    await waitForVisible('agent.permission.bar');
    await tap('agent.permission.allow');
    await waitForTextIn('chat.messageList', MOCK_TOOL_DONE);
    await waitForRunDone(adminCreds(), run);
    await waitForAbsent(runBadge(run, 'awaiting_approval'));
    await waitForAbsent(runBadge(run, 'running'));
  });

  it('shows the queue place on a row waiting for the backend, then the run', async function () {
    this.timeout(4 * 60_000);
    // Concurrency resolves to 1 for the mock (it reports no slots), the same
    // way run-queue.spec.ts relies on; the settings reset in `before` keeps
    // a previous run's value from leaving the queue invisible.
    await goToSurface('agent');
    await waitForComposerReady();
    await startNewAgentRun();
    const first = await sendAndCapture(SLOW_PROMPT);

    // A second conversation, started while the first holds the backend.
    await startNewAgentRun();
    await waitForComposerReady();
    const second = await sendAndCapture('queued for the badge test');

    await openThreadList('agent');
    await waitForVisible(runBadge(second, 'queued'), 30_000);
    await waitForTextIn(runBadge(second, 'queued'), '#1');
    await shot('thread-list-queued');

    // The queue moves: the second run gets its slot, so its row stops saying
    // Queued — the edge the scheduler's `onAdmitted` exists for; without it
    // the row would say "Queued · #1" over a run that is running.
    await waitForVisible(runBadge(second, 'running'), 60_000);
    await waitForAbsent(runBadge(second, 'queued'));

    await waitForRunDone(adminCreds(), first);
    await waitForRunDone(adminCreds(), second);
    await waitForAbsent(runBadge(second, 'running'));
  });

  it('badges a routine run live, and hands the row back to the recorded status', async function () {
    this.timeout(4 * 60_000);
    const routine = await createRoutine(adminCreds(), {
      name: `Badge ${String(Date.now())}`,
      prompt: SLOW_PROMPT,
    });
    const run = await runRoutine(adminCreds(), routine.id);

    await goToSurface('routines');
    await waitForVisible(`routines.open.${routine.id}`);
    await tap(`routines.open.${routine.id}`);
    await waitForVisible('routineChat.back');
    await openThreadList('routineChat');
    // Live, from a run the server started — and while it is going the live
    // badge owns the row: the recorded run status is hidden, because it only
    // refreshes on a list fetch and would be the older claim.
    await waitForVisible(runBadge(run.conversationId, 'running'));
    expect(await isVisible(`threadList.status.${run.conversationId}`)).toBe(false);
    await shot('thread-list-routine-running');

    await waitForRunDone(adminCreds(), run.conversationId);
    // The live badge goes, and the recorded status takes the slot back,
    // saying how the run ended. The list was fetched mid-run, so its record
    // said "Running": without fetching it again when the badge goes, the row
    // went back to claiming a finished run was going — what it says is the
    // assertion, not that a badge is there.
    await waitForAbsent(runBadge(run.conversationId, 'running'));
    await waitForFreshText(`threadList.status.${run.conversationId}.label`, 'Done');
    await shot('thread-list-routine-recorded');

    // And the row still opens its run.
    await tap(`threadList.item.${run.conversationId}`);
    await waitForTextIn('chat.messageList', 'take your time');
  });
});
