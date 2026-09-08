/**
 * Chat threads belong to Chat, agent runs belong to Agent — #117.
 *
 * Both surfaces read the same unfiltered `GET /v1/conversations`, and only
 * the agent side filtered it, so every agent run also appeared as a chat
 * thread. Asserted in both directions on purpose: the bug was one-directional,
 * and a fix that over-corrects (filtering agent runs out of the *agent* list)
 * would pass a one-sided test.
 *
 * Selected by `threadList.item.<id>` rather than by title, so this cannot be
 * fooled by two conversations that happen to read alike.
 */
import { uniqueCreds } from '../helpers/auth.ts';
import { shot } from '../helpers/screenshot.ts';
import { waitForGone, waitForVisible } from '../helpers/selectors.ts';
import {
  goToSurface,
  listConversations,
  openThreadList,
  sendMessage,
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
    await goToSurface('agent');
    await sendMessage('a run that belongs to agent');

    const convs = await listConversations(creds);
    chatId = convs.find((c) => c.kind !== 'agent')?.id ?? '';
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
