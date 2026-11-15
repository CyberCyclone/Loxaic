/**
 * A real model carries a conversation on after it is compacted.
 *
 * The summary used to ride as a second system message, and every chat
 * template from Qwen3.5 on refuses one anywhere but first: llama.cpp answered
 * each request after a compaction with HTTP 500. The mock lane's
 * compaction-continues.spec.ts holds the mock to the same rule; this is the
 * same path against the template itself. Point E2E_INFERENCE_URL at
 * llama.cpp (`--jinja`) serving a Qwen3.5-or-later model. Guarded by
 * wdio.web.real-model.ts on E2E_REAL_MODEL=1; never runs in CI.
 *
 * Pass is the stored reply, read after the run: complete, not an error, and
 * built from the summary (it names both things), not a reply the model could
 * give without it.
 */
import { apiToken, uniqueCreds } from '../../helpers/auth.ts';
import { shot } from '../../helpers/screenshot.ts';
import { waitForFreshText } from '../../helpers/selectors.ts';
import { listConversations, sendMessage, signUp, waitForRunDone } from '../../helpers/app.ts';
import { BASE_URL } from '../../../scripts/standup.ts';

const RUN_TIMEOUT_MS = 5 * 60_000;

interface StoredMessage {
  authorType: string;
  status: string;
  content: { kind: string; text?: string }[];
}

async function storedMessages(token: string, conversationId: string): Promise<StoredMessage[]> {
  const res = await fetch(`${BASE_URL}/v1/conversations/${conversationId}/messages`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`[e2e] getting messages failed (${String(res.status)})`);
  return ((await res.json()) as { messages: StoredMessage[] }).messages;
}

/** Until `count` messages of `kind` are stored and finished, failed ones
 * included: a send's own end, which `waitForRunDone` can miss by polling
 * before the run has started. */
async function settled(token: string, conversationId: string, kind: string, count: number): Promise<void> {
  const deadline = Date.now() + RUN_TIMEOUT_MS;
  for (;;) {
    const done = (await storedMessages(token, conversationId)).filter((m) => m.authorType === kind && m.status !== 'streaming');
    if (done.length >= count) return;
    if (Date.now() > deadline) throw new Error(`[e2e] ${String(count)} finished ${kind} message(s) never arrived`);
    await new Promise((r) => setTimeout(r, 1_000));
  }
}

describe('real model: after a compaction', () => {
  it('answers the next message from the summary', async function () {
    this.timeout(20 * 60_000);
    const creds = uniqueCreds();
    await signUp(creds);

    await sendMessage('Remember this: my cat is called Biscuit. Reply with one short sentence.');
    await browser.waitUntil(async () => (await listConversations(creds)).length > 0, { timeout: 30_000 });
    const [conversation] = await listConversations(creds);
    const token = await apiToken(creds);
    await settled(token, conversation.id, 'assistant', 1);
    await sendMessage('Remember this too: my favourite colour is teal. Reply with one short sentence.');
    await settled(token, conversation.id, 'assistant', 2);

    await sendMessage('/compact keep both things');
    await waitForFreshText('chat.compaction.guidance', 'keep both things', RUN_TIMEOUT_MS);
    await waitForRunDone(creds, conversation.id, RUN_TIMEOUT_MS);

    await sendMessage("What is my cat's name, and what is my favourite colour? Answer in one sentence.");
    await settled(token, conversation.id, 'assistant', 3);
    await waitForRunDone(creds, conversation.id, RUN_TIMEOUT_MS);
    await shot('real-model-compaction-answered');

    const rows = await storedMessages(token, conversation.id);
    const at = rows.findIndex((m) => m.authorType === 'summary');
    if (at < 0) throw new Error('no summary was stored: the compaction never ran');
    const after = rows.slice(at + 1).filter((m) => m.authorType === 'assistant');
    const reply = after.at(-1);
    if (!reply) throw new Error('nothing answered after the compaction');
    if (reply.status !== 'complete') {
      throw new Error(`the reply after the compaction is ${reply.status}: ${JSON.stringify(reply).slice(0, 600)}`);
    }
    const text = reply.content.filter((b) => b.kind === 'text').map((b) => b.text ?? '').join(' ');
    if (!/biscuit/i.test(text) || !/teal/i.test(text)) {
      throw new Error(`the reply does not come from the summary: ${text}`);
    }
  });
});
