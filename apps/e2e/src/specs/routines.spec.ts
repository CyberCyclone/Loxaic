/**
 * Routines: opening a routine's chats, and a delete that deletes (#179).
 *
 * The issue is two complaints and this covers both. Pressing a routine used to
 * open its edit form; there was no way to reach the chats its runs produced,
 * and nothing in the client ever read `routine_runs.conversation_id`. And
 * "Delete" only disabled the routine, so it came back — still there, greyed
 * out — seconds after the toast said it was gone.
 *
 * Three things here can only be settled over the API, and are:
 *   - **which model a run used**, since the screen shows a name and the
 *     question is which reference was actually sent (`assistantModels`);
 *   - **where a message landed**, since a misrouted one renders perfectly well
 *     in the thread it was wrongly written to;
 *   - **what survived a delete**, since the list hiding a row is exactly the
 *     bug being fixed.
 *
 * iOS skips every step that goes through a Modal overlay — XCUITest cannot
 * resolve testIDs inside one, which `delete-conversation.spec.ts` already
 * documents — and seeds the same state through the API instead, so the
 * navigation and history half still runs there.
 */
import { browser } from '@wdio/globals';
import { provisionUser, type Credentials } from '../helpers/auth.ts';
import { shot } from '../helpers/screenshot.ts';
import { byTestId, platform, tap, typeInto, waitForGone, waitForTextIn, waitForVisible } from '../helpers/selectors.ts';
import {
  assistantModels,
  createRoutine,
  goToSurface,
  listConversations,
  listRoutineConversations,
  listRoutines,
  mockEcho,
  openThreadList,
  runRoutine,
  sendMessage,
  signIn,
  SLOW_PROMPT,
  waitForRunDone,
  type E2ERoutine,
} from '../helpers/app.ts';

/** The mock backend's two models. Two is the point: a routine has to run on
 * the one it was given rather than on whatever is loaded. */
const MODEL_A = 'llama-3.1-8b-instruct';
const MODEL_B = 'qwen2.5-14b-instruct';

const PROMPT = 'summarise yesterday';

describe('routines', () => {
  let creds: Credentials;

  before(async () => {
    // Provisioned over the API and then signed *in* — `signUp` would fill the
    // form with an email that already exists and never reach the composer.
    creds = await provisionUser();
    await signIn(creds);
  });

  it('creates a routine, and makes you choose the model it will run on', async function () {
    // The form is a Modal.
    if (platform() === 'ios') this.skip();

    await goToSurface('routines');
    await tap('routines.new');
    await waitForVisible('routineModal.name');
    await typeInto('routineModal.name', 'Morning digest');
    await typeInto('routineModal.prompt', PROMPT);

    // The Model row is what this stage adds, and adding it is what pushes the
    // form past the fold — so assert Save is *reachable*, not merely
    // "displayed", which WebDriver reports true for an element past the
    // viewport edge either way. Same check as mcp-servers.spec.ts, where a
    // field below the fold cost a real credential.
    if (platform() === 'web') {
      const reach = await reachability('routineModal.save');
      expect(reach.found).toBe(true);
      if (reach.overflowing) expect(reach.scrollable).toBe(true);
    }

    await shot('routine-create-modal');

    await tap('routineModal.model');
    await waitForVisible(`models.row.${MODEL_A}`);
    await shot('routine-model-picker');
    await tap(`models.row.${MODEL_A}`);

    await tap('routineModal.save');
    await waitForGone('routineModal.save');

    const rows = await listRoutines(creds);
    const made = rows.find((r) => r.name === 'Morning digest');
    expect(made).toBeDefined();
    // Stored, not implied: there is no fallback on the server, so a routine
    // saved without one would simply fail every run.
    expect(made?.model).toBe(MODEL_A);
  });

  it('opens on an explanation, not an empty chat, before it has ever run', async () => {
    const routine = await seedRoutine(creds, 'Never run', MODEL_A);
    await openRoutine(routine);

    await waitForVisible('routineChat.empty');
    await shot('routine-empty');
    // No composer: sending would have nothing to send into, and opening an
    // ordinary chat conversation from the routines screen is the bug that
    // would be.
    expect(await byTestId('composer.input').isDisplayed().catch(() => false)).toBe(false);
  });

  it('runs on demand and shows the reply, on the routine’s own model', async () => {
    const routine = await seedRoutine(creds, 'Run me', MODEL_A);
    await openRoutine(routine);

    await waitForVisible('routineChat.empty.runNow');
    await tap('routineChat.empty.runNow');
    await waitForTextIn('chat.messageList', mockEcho(PROMPT));
    await shot('routine-first-run');

    const convs = await listRoutineConversations(creds, routine.id);
    expect(convs).toHaveLength(1);
    await waitForRunDone(creds, convs[0].id);
    // The run used the routine's model and not the other one the mock offers.
    expect(await assistantModels(creds, convs[0].id)).toEqual([MODEL_A]);
  });

  it('carries the conversation on, still on the routine’s model', async () => {
    const routine = await seedRoutine(creds, 'Continue me', MODEL_A);
    const run = await runRoutine(creds, routine.id);
    await waitForRunDone(creds, run.conversationId);

    await openRoutine(routine);
    await waitForTextIn('chat.messageList', mockEcho(PROMPT));
    await sendMessage('and the day before');
    await waitForTextIn('chat.messageList', mockEcho('and the day before'));
    await shot('routine-continued');

    await waitForRunDone(creds, run.conversationId);
    // Both turns in the routine's own chat — and the follow-up answered on the
    // routine's model too, which is the thing a composer with no picker is
    // relying on.
    expect(await assistantModels(creds, run.conversationId)).toEqual([MODEL_A, MODEL_A]);
    // And no ordinary chat thread was conjured on the side.
    const chats = await listConversations(creds);
    expect(chats.map((c) => c.id)).not.toContain(run.conversationId);
  });

  it('lists this routine’s chats and nobody else’s', async () => {
    const mine = await seedRoutine(creds, 'Mine', MODEL_A);
    const other = await seedRoutine(creds, 'Other', MODEL_A);
    const first = await runRoutine(creds, mine.id);
    await waitForRunDone(creds, first.conversationId);
    const second = await runRoutine(creds, mine.id);
    await waitForRunDone(creds, second.conversationId);
    const theirs = await runRoutine(creds, other.id);
    await waitForRunDone(creds, theirs.conversationId);

    await openRoutine(mine);
    // Opens on the last run — "it should show me the last chat's run".
    await waitForVisible(`threadList.status.${second.conversationId}`).catch(() => undefined);
    await openThreadList('routineChat');
    await waitForVisible(`threadList.item.${second.conversationId}`);
    await waitForVisible(`threadList.item.${first.conversationId}`);
    // "only for this routine. If I want to see other routine chats, I need to
    // go back to the routines list, and select that routine."
    expect(await byTestId(`threadList.item.${theirs.conversationId}`).isDisplayed().catch(() => false)).toBe(false);
    await shot('routine-history-scoped');

    // An older run still opens, so the history is a way in rather than a label.
    await tap(`threadList.item.${first.conversationId}`);
    await waitForTextIn('chat.messageList', mockEcho(PROMPT));

    // "If I want to see other routine chats, I need to go back to the
    // routines list, and select that routine." Doing exactly that has to
    // *change* the list: the screen is the same component with a different
    // param, so a hook that keyed its fetch on the session alone would leave
    // the previous routine's chats on screen with the active one still
    // pointing into them.
    await openRoutine(other);
    await openThreadList('routineChat');
    await waitForVisible(`threadList.item.${theirs.conversationId}`);
    expect(await byTestId(`threadList.item.${second.conversationId}`).isDisplayed().catch(() => false)).toBe(false);
  });

  it('picks up a run that was already going when the screen opened', async () => {
    // The one genuinely new client mechanism: a scheduled run starts on the
    // server, so opening its chat is the first this client hears of it. The
    // hook otherwise only subscribes on socket open and on a seq gap, which
    // is enough where every run starts from this client — here the transcript
    // would sit static while the run streamed on.
    const routine = await createRoutine(creds, {
      name: `In flight ${String(Date.now())}`,
      prompt: SLOW_PROMPT,
      model: MODEL_A,
    });
    const run = await runRoutine(creds, routine.id);

    await openRoutine(routine);
    // Streaming, from a run this client never started: the stop control only
    // exists while one is in flight.
    await waitForVisible('composer.stop');
    await shot('routine-inflight');

    await waitForTextIn('chat.messageList', mockEcho(SLOW_PROMPT), 60_000);
    await waitForRunDone(creds, run.conversationId);
  });

  it('goes back to the routines list', async () => {
    const routine = await seedRoutine(creds, 'Back out', MODEL_A);
    await openRoutine(routine);
    await tap('routineChat.back');
    await waitForVisible('routines.new');
  });

  it('survives a reload on its own URL', async function () {
    // A deep link is the reason this is a route rather than screen state.
    if (platform() !== 'web') this.skip();
    const routine = await seedRoutine(creds, 'Deep link', MODEL_A);
    const run = await runRoutine(creds, routine.id);
    await waitForRunDone(creds, run.conversationId);

    await openRoutine(routine);
    await browser.refresh();
    await waitForVisible('routineChat.back');
    await waitForTextIn('chat.messageList', mockEcho(PROMPT));
  });

  it('asks before deleting, and then really deletes', async function () {
    // The confirm dialog is a Modal.
    if (platform() === 'ios') this.skip();

    const routine = await seedRoutine(creds, 'Doomed', MODEL_A);
    const run = await runRoutine(creds, routine.id);
    await waitForRunDone(creds, run.conversationId);

    await goToSurface('routines');
    await waitForVisible(`routines.delete.${routine.id}`);
    await tap(`routines.delete.${routine.id}`);
    await waitForVisible('routines.deleteConfirm.dialog');
    await shot('routine-delete-confirm');

    // Cancelling changes nothing — the old delete had no way back at all.
    await tap('routines.deleteConfirm.cancel');
    await waitForGone('routines.deleteConfirm.dialog');
    expect(await byTestId(`routines.open.${routine.id}`).isDisplayed()).toBe(true);

    await tap(`routines.delete.${routine.id}`);
    await waitForVisible('routines.deleteConfirm.dialog');
    await tap('routines.deleteConfirm.confirm');
    await waitForGone(`routines.open.${routine.id}`);
    await shot('routine-after-delete');

    // The row not being on screen is exactly what the old bug also looked
    // like for a few seconds, so the server is what settles it.
    expect((await listRoutines(creds)).find((r) => r.id === routine.id)).toBeUndefined();
    // "It should fully delete it along with all the chats that were
    // associated with it."
    const chats = await listConversations(creds);
    expect(chats.map((c) => c.id)).not.toContain(run.conversationId);
  });

  it('says so rather than showing an empty chat when the routine is gone', async function () {
    if (platform() !== 'web') this.skip();
    const routine = await seedRoutine(creds, 'Vanishing', MODEL_A);
    await openRoutine(routine);
    await waitForVisible('routineChat.empty');

    // Deleted from elsewhere — another device, or the list behind this screen.
    await deleteRoutine(creds, routine.id);
    await browser.refresh();
    await waitForVisible('routineChat.notFound');
  });

  it('runs a re-pointed routine on its new model', async function () {
    if (platform() === 'ios') this.skip();

    const routine = await seedRoutine(creds, 'Repointed', MODEL_A);
    await goToSurface('routines');
    await tap(`routines.edit.${routine.id}`);
    await waitForVisible('routineModal.model');
    await tap('routineModal.model');
    await waitForVisible(`models.row.${MODEL_B}`);
    await tap(`models.row.${MODEL_B}`);
    await tap('routineModal.save');
    await waitForGone('routineModal.save');

    const run = await runRoutine(creds, routine.id);
    await waitForRunDone(creds, run.conversationId);
    expect(await assistantModels(creds, run.conversationId)).toEqual([MODEL_B]);
  });
});

// ── helpers ───────────────────────────────────────────────

/** Seeded over the API: every case above is about something other than the
 * create form, and on iOS the form is unreachable anyway. */
async function seedRoutine(creds: Credentials, name: string, model: string): Promise<E2ERoutine> {
  return createRoutine(creds, { name: `${name} ${String(Date.now())}`, prompt: PROMPT, model });
}

async function openRoutine(routine: E2ERoutine): Promise<void> {
  await goToSurface('routines');
  await waitForVisible(`routines.open.${routine.id}`);
  await tap(`routines.open.${routine.id}`);
  await waitForVisible('routineChat.back');
}

async function deleteRoutine(creds: Credentials, id: string): Promise<void> {
  const { apiToken } = await import('../helpers/auth.ts');
  const { BASE_URL } = await import('../../scripts/standup.ts');
  const token = await apiToken(creds);
  const res = await fetch(`${BASE_URL}/v1/routines/${id}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`[e2e] DELETE routine failed (${String(res.status)})`);
}

/**
 * Whether an element can actually be brought into view, rather than whether
 * WebDriver calls it displayed — which it does for anything past the viewport
 * edge, so a visibility check passes with the bug and without it.
 *
 * Copied in shape from `specs/browser/mcp-servers.spec.ts`, where the same
 * question (a field below a modal's fold) cost a real credential.
 * `overflowing` is reported separately so the verdict does not depend on the
 * runner's window height: on a tall window nothing overflows, no ancestor
 * qualifies, and "not scrollable" would be reported for a modal working
 * perfectly.
 */
async function reachability(id: string): Promise<{ found: boolean; overflowing: boolean; scrollable: boolean }> {
  const { testIdSelector } = await import('../helpers/selectors.ts');
  return browser.execute((selector: string) => {
    const el = document.querySelector<HTMLElement>(selector);
    if (!el) return { found: false, overflowing: false, scrollable: false };
    let node = el.parentElement;
    let overflowing = false;
    while (node) {
      if (node.scrollHeight > node.clientHeight) overflowing = true;
      const overflow = getComputedStyle(node).overflowY;
      if ((overflow === 'auto' || overflow === 'scroll') && node.scrollHeight > node.clientHeight) {
        return { found: true, overflowing, scrollable: true };
      }
      node = node.parentElement;
    }
    return { found: true, overflowing, scrollable: false };
  }, testIdSelector(id));
}
