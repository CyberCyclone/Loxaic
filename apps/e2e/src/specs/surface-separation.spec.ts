/**
 * Each surface shows only its own kind — #117. General chats under Chat,
 * coding sessions under Agent, routine runs under Routines.
 *
 * Both surfaces read the same unfiltered `GET /v1/conversations`, and only
 * the agent side filtered it, so every agent run also appeared as a chat
 * thread. Asserted in both directions on purpose: the bug was one-directional,
 * and a fix that over-corrects (filtering agent runs out of the *agent* list)
 * would pass a one-sided test.
 *
 * Selected by `threadList.item.<id>` rather than by title, so this cannot be
 * fooled by two conversations that happen to read alike.
 *
 * Routine runs are the third kind — the scheduler creates a conversation with
 * kind "routine" for each one — and they are excluded by the same filter. Not
 * covered here: making one needs the scheduler to fire on its cron, and the
 * create route only accepts "chat" | "agent", so a spec cannot mint one
 * through the API the way it can the two below.
 */
import { browser } from '@wdio/globals';
import { provisionUser, uniqueCreds } from '../helpers/auth.ts';
import { shot } from '../helpers/screenshot.ts';
import { waitForGone, waitForTextIn, waitForVisible } from '../helpers/selectors.ts';
import {
  goToSurface,
  getMessageTexts,
  listConversations,
  openThreadList,
  sendMessage,
  signIn,
  signOut,
  signUp,
  waitForRunDone,
} from '../helpers/app.ts';

describe('chat and agent surfaces keep their own conversations', () => {
  const creds = uniqueCreds();
  let chatId = '';
  let agentId = '';

  before(async function () {
    this.timeout(2 * 60_000);
    await signUp(creds);

    // One of each, created through the UI so each lands with the kind its own
    // surface assigns.
    await goToSurface('chat');
    await sendMessage('a thread that belongs to chat');
    // The conversation is created server-side by the turn, so wait for the
    // mock's reply — its existence, not the optimistic bubble — before
    // listing: a list that beat the insert left `chatId`/`agentId` empty
    // and failed both tests on something unrelated to what they assert.
    await waitForTextIn('chat.messageList', 'Echo: a thread that belongs to chat');
    await goToSurface('agent');
    await sendMessage('a run that belongs to agent');
    await waitForVisible('agent.run.status');

    const convs = await listConversations(creds);
    chatId = convs.find((c) => (c.kind ?? 'chat') === 'chat')?.id ?? '';
    agentId = convs.find((c) => c.kind === 'agent')?.id ?? '';
    expect(chatId).not.toBe('');
    expect(agentId).not.toBe('');
    // Let the agent turn finish so nothing is still streaming while the lists
    // are inspected.
    await waitForRunDone(creds, agentId, 60_000);
  });

  it('shows only the chat thread in the chat list', async () => {
    await goToSurface('chat');
    await openThreadList('chat');
    await waitForVisible(`threadList.item.${chatId}`);
    await waitForGone(`threadList.item.${agentId}`, 10_000);
    await shot('surface-split-chat-list');
  });

  it('shows only the agent run in the agent list', async () => {
    await goToSurface('agent');
    await openThreadList('agent');
    await waitForVisible(`threadList.item.${agentId}`);
    await waitForGone(`threadList.item.${chatId}`, 10_000);
    await shot('surface-split-agent-list');
  });
});

describe('a chat message never lands in an agent run', () => {
  // The second, worse half of #117, and the one a list-only assertion misses
  // entirely: Chat filtered the list it *showed* but auto-selected from the
  // unfiltered one, so with an agent run as the only conversation, the chat
  // surface opened it and wrote the message into it. Found by typing into
  // Chat by hand and finding the text in an agent conversation.
  const creds = uniqueCreds();

  before(async function () {
    this.timeout(2 * 60_000);
    // Provisioned through the API and signed into, rather than signed up
    // through the UI: the describe above leaves the browser authenticated, so
    // the sign-up screen is not on display for a second user.
    await provisionUser(creds);
    await signOut();
    await signIn(creds);
    // Deliberately the *only* conversation, which is what made the raw
    // `convs[0]` resolve to an agent run.
    await goToSurface('agent');
    await sendMessage('an agent run, and nothing else');
    const [agent] = await listConversations(creds);
    await waitForRunDone(creds, agent.id, 60_000);
  });

  it('creates a chat conversation instead of appending to the agent one', async function () {
    this.timeout(2 * 60_000);

    const before = await listConversations(creds);
    const agentRun = before.find((c) => c.kind === 'agent');
    if (!agentRun) throw new Error('the agent run this case depends on was not created');

    await goToSurface('chat');
    await sendMessage('this belongs in chat');

    // A chat conversation now exists…
    await browser.waitUntil(
      async () => (await listConversations(creds)).some((c) => (c.kind ?? 'chat') === 'chat'),
      { timeout: 30_000, interval: 500, timeoutMsg: 'the chat message created no chat conversation' },
    );

    // …and the agent run did not grow. Checked off the server rather than the
    // screen: the misrouted message rendered in the agent thread, so a UI-only
    // assertion would have been just as wrong as the code.
    const agentMsgs = await getMessageTexts(creds, agentRun.id);
    expect(agentMsgs.some((t) => t.includes('this belongs in chat'))).toBe(false);
    await shot('surface-split-chat-message-routing');
  });
});
