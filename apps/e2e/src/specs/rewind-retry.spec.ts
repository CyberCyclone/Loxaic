/**
 * Rewinding a conversation to one of its messages, and answering the newest
 * one again (#166).
 *
 * A rewind removes the message and everything after it, and puts the message —
 * its image included — back in the composer to edit and send again. A retry
 * replaces the newest reply and keeps the message it answers. Both reach a
 * page that only watches the conversation, and a reload does not bring
 * anything back: the removed runs' stream logs go with them, so a resync has
 * nothing to replay.
 *
 * The mock's "give a different answer" prompt answers with a number that goes
 * up every time, so a retry is visibly a new reply rather than the same echo.
 */
import { browser } from '@wdio/globals';
import { BASE_URL } from '../../scripts/standup.ts';
import { apiToken, provisionUser, uniqueCreds, type Credentials } from '../helpers/auth.ts';
import { shot } from '../helpers/screenshot.ts';
import { byTestId, expectTextAbsent, isVisible, platform, tap, waitForAbsent, waitForTextIn, waitForVisible } from '../helpers/selectors.ts';
import { listConversations, sendMessage, signIn, signOut, startNewThread, waitForComposerReady, waitForRunDone } from '../helpers/app.ts';
import { attachImage } from '../helpers/attachments.ts';

interface Row {
  id: string;
  authorType: string;
  content: { kind: string; text?: string }[];
}

async function rowsOf(creds: Credentials, conversationId: string): Promise<Row[]> {
  const token = await apiToken(creds);
  const res = await fetch(`${BASE_URL}/v1/conversations/${conversationId}/messages`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`[e2e] messages failed (${String(res.status)})`);
  return ((await res.json()) as { messages: Row[] }).messages;
}

const textOf = (row: Row) => row.content.filter((b) => b.kind === 'text').map((b) => b.text ?? '').join('\n');

/** What the composer holds — a value on the web, text on a phone. */
async function composerText(): Promise<string> {
  const field = byTestId('composer.input');
  return platform() === 'web' || platform() === 'electron' ? field.getValue() : field.getText();
}

describe('rewinding and retrying', () => {
  const alice = uniqueCreds();
  const viewer = uniqueCreds();
  let conversationId = '';

  before(async () => {
    await provisionUser(alice);
    await provisionUser(viewer);
    await signIn(alice);
  });

  async function newestConversation(): Promise<string> {
    await browser.waitUntil(async () => (await listConversations(alice)).length > 0, { timeout: 30_000 });
    return (await listConversations(alice))[0].id;
  }

  /** Sends and waits for the server to say the run is over. */
  async function turn(text: string, rows: number): Promise<void> {
    await waitForComposerReady();
    await sendMessage(text);
    if (!conversationId) conversationId = await newestConversation();
    await browser.waitUntil(async () => (await rowsOf(alice, conversationId)).length >= rows, { timeout: 30_000 });
    await waitForRunDone(alice, conversationId);
  }

  it('rewinds to a message: the thread ends before it, and it comes back to the composer with its image', async function () {
    this.timeout(4 * 60_000);
    await startNewThread();
    await turn('the first question', 2);
    if (platform() === 'web' || platform() === 'electron') await attachImage();
    await turn('the second question, too long', 4);
    const second = (await rowsOf(alice, conversationId)).find((r) => textOf(r) === 'the second question, too long');
    if (!second) throw new Error('the second message was not stored');

    await tap(`chat.message.rewind.${second.id}`);
    await waitForVisible('chat.rewind.message');
    await shot('rewind-dialog');
    await tap('chat.rewind.confirm');
    await waitForAbsent('chat.rewind.dialog');

    await browser.waitUntil(async () => (await composerText()) === 'the second question, too long', { timeout: 15_000 });
    if (platform() === 'web' || platform() === 'electron') await waitForVisible('composer.attachment.preview');
    await waitForAbsent(`chat.message.rewind.${second.id}`);
    await shot('rewind-back-in-composer');
    expect((await rowsOf(alice, conversationId)).map(textOf)).toEqual(['the first question', expect.stringContaining('the first question')]);

    // Edited and sent again — with the image it came back with: an ordinary
    // turn.
    await turn('the second question', 4);
    const resent = (await rowsOf(alice, conversationId)).find((r) => textOf(r) === 'the second question');
    expect(resent?.content.some((b) => b.kind === 'attachment')).toBe(platform() === 'web' || platform() === 'electron');
  });

  it('answers the newest message again, keeping the message', async function () {
    this.timeout(3 * 60_000);
    await waitForRunDone(alice, conversationId);
    await turn('please give a different answer', 6);
    const before = await rowsOf(alice, conversationId);
    const asked = before.find((r) => textOf(r) === 'please give a different answer');
    const firstAnswer = textOf(before[before.length - 1]);
    expect(firstAnswer).toMatch(/Answer number \d+/);

    await tap('chat.message.retry');
    await browser.waitUntil(
      async () => {
        const rows = await rowsOf(alice, conversationId);
        const last = rows[rows.length - 1];
        return rows.length === before.length && last.authorType === 'assistant' && textOf(last) !== firstAnswer && textOf(last).includes('Answer number');
      },
      { timeout: 30_000, timeoutMsg: 'the retry did not replace the reply' },
    );
    const after = await rowsOf(alice, conversationId);
    // The same message answered, not a second copy of it.
    expect(after.filter((r) => textOf(r) === 'please give a different answer').map((r) => r.id)).toEqual([asked?.id]);
    await waitForTextIn('chat.messageList', textOf(after[after.length - 1]), 15_000);
    // And the old answer has left the screen, not merely been joined.
    await browser.waitUntil(
      () => expectTextAbsent(firstAnswer).then(() => true, () => false),
      { timeout: 15_000, timeoutMsg: `"${firstAnswer}" is still on screen after the retry` },
    );
    expect(await isVisible('chat.message.retry')).toBe(true);
    await shot('retry-new-answer');
  });

  it('reaches a page that only watches, and a reload brings nothing back', async function () {
    this.timeout(3 * 60_000);
    // Another device: the rewind is made over the API while this page sits on
    // the thread.
    const rows = await rowsOf(alice, conversationId);
    const target = rows.find((r) => textOf(r) === 'please give a different answer');
    if (!target) throw new Error('no target');
    const token = await apiToken(alice);
    const res = await fetch(`${BASE_URL}/v1/conversations/${conversationId}/rewind`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ message_id: target.id, scope: 'conversation' }),
    });
    expect(res.status).toBe(200);
    await waitForAbsent(`chat.message.rewind.${target.id}`, 15_000);

    await browser.refresh();
    await waitForComposerReady(30_000);
    await waitForTextIn('chat.messageList', 'the second question', 30_000);
    expect(await isVisible(`chat.message.rewind.${target.id}`)).toBe(false);
    await shot('rewound-after-reload');
  });

  it('offers neither to someone the conversation is shared with to view', async function () {
    this.timeout(2 * 60_000);
    const ownerToken = await apiToken(alice);
    const viewerSignIn = await fetch(`${BASE_URL}/api/auth/sign-in`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: viewer.email, password: viewer.password }),
    });
    const viewerId = ((await viewerSignIn.json()) as { user: { id: string } }).user.id;
    await fetch(`${BASE_URL}/v1/conversations/${conversationId}/shares`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${ownerToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ user_id: viewerId, role: 'viewer' }),
    });
    const first = (await rowsOf(alice, conversationId))[0];

    await signOut();
    await signIn(viewer);
    await waitForTextIn('chat.messageList', 'the first question', 30_000);
    expect(await isVisible(`chat.message.rewind.${first.id}`)).toBe(false);
    expect(await isVisible('chat.message.retry')).toBe(false);
    await signOut();
    await signIn(alice);
  });
});
