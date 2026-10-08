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
import { BASE_URL, mockProviderApiBase } from '../../scripts/standup.ts';
import { VALID_KEY } from '../../scripts/mock-provider.ts';
import { adminCreds, apiToken, provisionAdmin, provisionUser, uniqueCreds, type Credentials } from '../helpers/auth.ts';
import { shot } from '../helpers/screenshot.ts';
import { byTestId, expectTextAbsent, isVisible, platform, tap, waitForAbsent, waitForTextIn, waitForVisible } from '../helpers/selectors.ts';
import {
  chooseScratchWorkspace,
  deleteProvidersWithBaseUrl,
  execInSandbox,
  goToSurface,
  listConversations,
  listSandboxes,
  patchSandboxSettings,
  resetSandboxSettings,
  sendMessage,
  signIn,
  signOut,
  startNewThread,
  waitForComposerReady,
  waitForRunDone,
} from '../helpers/app.ts';
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
    await provisionAdmin();
    await provisionUser(alice);
    await provisionUser(viewer);
    await signIn(alice);
  });

  after(async () => {
    await deleteProvidersWithBaseUrl(mockProviderApiBase());
    await resetSandboxSettings();
  });

  async function pickModel(id: string): Promise<void> {
    await tap('composer.model');
    await waitForVisible(`models.row.${id}`);
    await tap(`models.row.${id}`);
    // An element inside the dialog: on Android a closed modal's root goes on
    // reporting itself displayed.
    await waitForAbsent('models.search', 10_000);
  }

  /** A conversation started from this page, found by being new. */
  async function newConversationAfter(known: Set<string>): Promise<string> {
    let id = '';
    await browser.waitUntil(
      async () => {
        id = (await listConversations(alice)).find((c) => !known.has(c.id))?.id ?? '';
        return id !== '';
      },
      { timeout: 30_000 },
    );
    return id;
  }

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

  it("offers Edit message on a reply the model's server refused as too long, and says who can fix it", async function () {
    this.timeout(3 * 60_000);
    // An added provider whose model reports no context size: Loxaic cannot
    // know it is full, so the provider is the one that says so.
    const adminToken = await apiToken(adminCreds());
    const created = await fetch(`${BASE_URL}/v1/admin/providers`, {
      method: 'POST',
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: `Rewind ${String(Date.now())}`, baseUrl: mockProviderApiBase(), apiKey: VALID_KEY }),
    });
    expect(created.ok).toBe(true);
    const { slug } = (await created.json()) as { slug: string };
    const known = new Set((await listConversations(alice)).map((c) => c.id));
    await startNewThread();
    await pickModel(`${slug}::acme/nova-classic`);

    await sendMessage('please overflow the provider');
    const convId = await newConversationAfter(known);
    await waitForVisible('chat.message.editMessage', 30_000);
    await waitForVisible('chat.message.contextHint');
    await shot('overflow-edit-message');

    await tap('chat.message.editMessage');
    await browser.waitUntil(async () => (await composerText()) === 'please overflow the provider', { timeout: 15_000 });
    await waitForAbsent('chat.message.editMessage');
    expect(await rowsOf(alice, convId)).toEqual([]);

    // Shorter (typed over what came back), and answered.
    await sendMessage('a shorter question');
    await waitForTextIn('chat.messageList', 'Reply from the external provider.', 30_000);
  });

  it('offers Edit message on a message Loxaic knows cannot fit, and a shorter one is answered', async function () {
    // Typing a 30,000-character paste is something only a browser can do in
    // the time a spec has: XCUITest and UiAutomator2 type a character at a
    // time. The refusal itself is the server's and is unit-tested
    // (auto-compact-run.test.ts); the button is the same one the case above
    // drives on every platform.
    if (platform() !== 'web' && platform() !== 'electron') this.skip();
    this.timeout(3 * 60_000);
    const known = new Set((await listConversations(alice)).map((c) => c.id));
    await startNewThread();
    await pickModel('llama-3.1-8b-instruct');
    const paste = `a long paste: ${'words '.repeat(5000)}`;
    await sendMessage(paste);
    const convId = await newConversationAfter(known);
    await waitForVisible('chat.message.editMessage', 30_000);
    expect(await isVisible('chat.message.contextHint')).toBe(false);
    await waitForTextIn('chat.messageList', "doesn't fit the model's context", 15_000);
    await shot('cannot-fit-edit-message');

    await tap('chat.message.editMessage');
    // As it was sent: the composer trims what it sends.
    await browser.waitUntil(async () => (await composerText()) === paste.trim(), { timeout: 15_000 });
    await sendMessage('just the first paragraph');
    await browser.waitUntil(async () => (await rowsOf(alice, convId)).length === 2, { timeout: 30_000 });
    await waitForRunDone(alice, convId);
    expect((await rowsOf(alice, convId)).map(textOf)).toEqual(['just the first paragraph', expect.stringContaining('just the first paragraph')]);
  });

  it("puts back the files the agent's edit tools changed, and leaves what a command made", async function () {
    this.timeout(5 * 60_000);
    // A host sandbox: no container engine needed, and its files are the
    // server's to read back through the exec API.
    await patchSandboxSettings({ mode: 'host' });
    const known = new Set((await listConversations(alice)).map((c) => c.id));
    await goToSurface('agent');
    await chooseScratchWorkspace();
    await tap('agent.mode.auto');
    const prompt = 'please edit the notes for rewind';
    await sendMessage(prompt);
    const convId = await newConversationAfter(known);
    await waitForTextIn('chat.messageList', 'Notes edited', 60_000);
    await waitForRunDone(alice, convId);
    const token = await apiToken(alice);
    const [sandbox] = await listSandboxes(token, convId);
    const cat = async (file: string) => (await execInSandbox(token, sandbox.id, `cat ${file} 2>/dev/null || echo MISSING`)).stdout.trim();
    expect(await cat('notes.md')).toBe('second draft');
    const turnMessage = async () => {
      const row = (await rowsOf(alice, convId)).find((r) => r.authorType === 'user' && textOf(r) === prompt);
      if (!row) throw new Error('the message was not stored');
      return row.id;
    };

    // The conversation only: the agent's edit stays.
    await tap(`chat.message.rewind.${await turnMessage()}`);
    await waitForVisible('chat.rewind.filesNote');
    await shot('rewind-dialog-files');
    await tap('chat.rewind.conversation');
    await browser.waitUntil(async () => (await composerText()) === prompt, { timeout: 15_000 });
    expect(await cat('notes.md')).toBe('second draft');

    // Changed by hand, then the same request again; then rewound with the
    // files: notes.md is put back to what it was before that turn, and the
    // command's build.log, which no checkpoint tracks, stays.
    await execInSandbox(token, sandbox.id, "printf 'by hand\\n' > notes.md && rm -f build.log");
    await sendMessage(prompt);
    await browser.waitUntil(async () => (await rowsOf(alice, convId)).length > 1, { timeout: 30_000 });
    await waitForRunDone(alice, convId);
    expect(await cat('notes.md')).toBe('second draft');
    expect(await cat('build.log')).toBe('built');
    await tap(`chat.message.rewind.${await turnMessage()}`);
    await waitForVisible('chat.rewind.both');
    await tap('chat.rewind.both');
    await browser.waitUntil(async () => (await cat('notes.md')) === 'by hand', { timeout: 15_000, timeoutMsg: 'notes.md was not put back' });
    expect(await cat('build.log')).toBe('built');
    expect(await rowsOf(alice, convId)).toEqual([]);
    await shot('rewind-files-restored');
  });
});
