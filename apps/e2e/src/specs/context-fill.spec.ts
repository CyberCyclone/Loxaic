/**
 * A conversation that fills the model's context in the middle of a reply's
 * work: the run makes room between two of its own requests — a compaction, or
 * a larger context stage on a model set to extend — and carries on. Nothing is
 * sent that llama.cpp would cut off, and nothing is dropped from the history
 * without a summary in its place.
 *
 * The model is the mock HuggingFace's small one, on the fake router. "work in
 * steps" makes its first request of a turn call `todo_write` once, so a turn
 * has a second request; "overflow the context" makes every request of the turn
 * report 90% of the window the model was loaded with. A compaction replaces
 * that message with the run's nudge, so the request after it is small again,
 * as a real summary makes it.
 */
import { shot } from '../helpers/screenshot.ts';
import { provisionAdmin, provisionUser, uniqueCreds } from '../helpers/auth.ts';
import { isVisible, tap, waitForAbsent, waitForTextIn, waitForVisible } from '../helpers/selectors.ts';
import { browser } from '@wdio/globals';
import { listConversations, sendMessage, signIn, startNewThread, waitForComposerReady, waitForRunDone } from '../helpers/app.ts';
import { downloadTinyModel, patchModel, removeMockModels, routerEvents, routerName, userApi } from '../helpers/hostModels.ts';

const K = 1024;
const FILL_PROMPT = 'work in steps and overflow the context';

interface StoredRow {
  authorType: string;
  status: string;
  content: { kind: string; text?: string }[];
}

async function pickModel(id: string): Promise<void> {
  await tap('composer.model');
  await waitForVisible(`models.row.${id}`);
  await tap(`models.row.${id}`);
  // An element inside the dialog, not the dialog: on Android a closed
  // modal's root goes on reporting itself displayed.
  await waitForAbsent('models.search', 10_000);
}

describe('a conversation that fills up in the middle of a run', () => {
  const alice = uniqueCreds();
  let model = '';
  const chats = () => routerEvents().filter((e) => e.event === 'chat' && e.model === routerName(model));
  const newest = async () => (await listConversations(alice))[0].id;
  async function rowsOf(conversationId: string): Promise<StoredRow[]> {
    const res = await userApi(alice, `/v1/conversations/${conversationId}/messages`);
    const body = (await res.json()) as { messages: StoredRow[] };
    return body.messages;
  }

  before(async function () {
    this.timeout(3 * 60_000);
    await provisionAdmin();
    await provisionUser(alice);
    await removeMockModels();
    model = await downloadTinyModel();
    // No stages yet: a full conversation can only be compacted.
    await patchModel(model, { enabled: true, loadSettings: { ctxSize: 16 * K }, contextStages: null });
    await signIn(alice);
  });

  after(async () => {
    // Deleted, not just left: a conversation that used most of a stage counts
    // as one still needing it for two hours (context-stage-policy.ts), and the
    // specs after this one use the same mock model — context-stages.spec could
    // not step it back down while these were there.
    for (const { id } of await listConversations(alice)) {
      await userApi(alice, `/v1/conversations/${id}`, { method: 'DELETE' });
    }
    await removeMockModels();
  });

  it('compacts between two requests of a reply, and the reply carries on from the summary', async function () {
    this.timeout(4 * 60_000);
    await startNewThread();
    await pickModel(model);
    // Enough already said to be worth summarising (the floor is eight). Each
    // turn waits for the server to say its run is over, not for reply text:
    // every reply reads "Hello from…", so text cannot tell one turn's from the
    // next, and on a phone the next send went out while the last was ending.
    await sendMessage('hello 1');
    await browser.waitUntil(async () => (await listConversations(alice)).length > 0, { timeout: 30_000 });
    const conversationId = await newest();
    await waitForRunDone(alice, conversationId);
    for (const n of [2, 3]) {
      await waitForComposerReady();
      await sendMessage(`hello ${String(n)}`);
      await browser.waitUntil(async () => (await rowsOf(conversationId)).length >= n * 2, { timeout: 30_000 });
      await waitForRunDone(alice, conversationId);
    }
    expect((await rowsOf(conversationId)).filter((r) => r.authorType === 'assistant')).toHaveLength(3);
    await waitForComposerReady();
    const before = chats().length;

    await sendMessage(FILL_PROMPT);
    await waitForTextIn('chat.messageList', 'Auto-compacted', 120_000);
    await waitForVisible('chat.message.compactionNudge', 60_000);
    await waitForRunDone(alice, conversationId);
    await shot('context-fill-compacted-mid-run');

    // Stored: the tool step, the summary, the nudge, then the run's reply.
    const rows = await rowsOf(conversationId);
    const at = rows.findIndex((r) => r.authorType === 'summary');
    expect(rows[at].status).toBe('complete');
    expect(rows[at - 1].authorType).toBe('tool');
    expect(rows[at + 1].authorType).toBe('user');
    expect(rows.slice(at + 2).some((r) => r.authorType === 'assistant' && r.status === 'complete')).toBe(true);

    // What llama.cpp was sent: the tool step at 90% of the window, then —
    // after the summary — a small request. Nothing went out full.
    const sent = chats().slice(before);
    expect(sent[0].prompt_tokens).toBe(Math.round(16 * K * 0.9));
    expect(sent.at(-1)?.prompt_tokens).toBe(10);
  });

  it('compacts before answering a new message, and answers that message rather than a nudge', async function () {
    this.timeout(4 * 60_000);
    // A turn that ends almost at the window without compacting: two messages
    // are under the floor of eight. The next message then cannot fit, so the
    // run compacts before its first request — and the message it was started
    // for must stay after the summary, to be answered, not summarised.
    await startNewThread();
    await pickModel(model);
    const known = new Set((await listConversations(alice)).map((c) => c.id));
    await sendMessage('exceed the context');
    let conversationId = '';
    await browser.waitUntil(
      async () => {
        conversationId = (await listConversations(alice)).find((c) => !known.has(c.id))?.id ?? '';
        return conversationId !== '';
      },
      { timeout: 30_000 },
    );
    await waitForRunDone(alice, conversationId);
    expect(await rowsOf(conversationId)).toHaveLength(2);
    await waitForComposerReady();
    const before = chats().length;

    await sendMessage('and now a short question');
    await waitForTextIn('chat.messageList', 'Auto-compacted', 120_000);
    await waitForRunDone(alice, conversationId);
    await shot('context-fill-compacted-before-answering');
    expect(await isVisible('chat.message.compactionNudge')).toBe(false);

    // Stored: the summary, then the person's message, then its answer.
    const rows = await rowsOf(conversationId);
    const at = rows.findIndex((r) => r.authorType === 'summary');
    expect(rows[at].status).toBe('complete');
    expect(rows[at + 1]).toMatchObject({ authorType: 'user', content: [{ kind: 'text', text: 'and now a short question' }] });
    expect(rows.slice(at + 2).map((r) => r.authorType)).toEqual(['assistant']);
    // And that is what the model was asked.
    expect(chats().slice(before).at(-1)?.last_user).toBe('and now a short question');
  });

  it('extends the context of a model set to extend, inside the run, and the reply carries on at the larger window', async function () {
    this.timeout(4 * 60_000);
    await patchModel(model, {
      contextStages: { enabled: true, whoMayChange: 'everyone', whenFull: 'extend', stages: [{ ctxSize: 64 * K }] },
    });
    await startNewThread();
    await pickModel(model);
    const before = chats().length;

    await sendMessage(FILL_PROMPT);
    await waitForTextIn('chat.contextStage.label', 'Context extended to 64K', 120_000);
    await waitForTextIn('chat.messageList', 'Hello from', 60_000);
    await waitForRunDone(alice, await newest());
    await shot('context-fill-extended-mid-run');

    // The first request at 16K, the next at 64K: the switch happened between
    // them, and nothing was summarised.
    expect(chats().slice(before).map((c) => c.ctx_size)).toEqual([16 * K, 64 * K]);
    expect(await isVisible('chat.message.compactionNudge')).toBe(false);
  });
});
