/**
 * The composer's `+`: Attach file, and MCP, where each connected server can be
 * switched off for this chat alone — and the context popup, where "Tool
 * definitions" opens to say what each server's schemas cost.
 *
 * The point of all of it is the prompt. GitHub's tool schemas alone were over
 * half of a 52k window in an ordinary chat, so every assertion that matters is
 * made against what the server actually put in the request (its stored
 * context breakdown), not against what a switch looks like.
 *
 * The first-message case is the one most likely to regress silently: a new
 * chat has no conversation id to PATCH, so its choices ride the send that
 * creates it. If they were dropped, the switch would still read "off" and the
 * first request would still carry the server's schemas.
 */
import { browser } from '@wdio/globals';
import { apiToken, provisionUser, uniqueCreds, type Credentials } from '../helpers/auth.ts';
import { BASE_URL } from '../../scripts/standup.ts';
import { shot } from '../helpers/screenshot.ts';
import { isVisible, platform, tap, waitForGone, waitForSwitch, waitForTextIn, waitForVisible } from '../helpers/selectors.ts';
import {
  addMockMcpServer,
  closeContextPopover,
  closePlusMenu,
  conversationMcpOverrides,
  goToSurface,
  lastToolSourceKeys,
  listConversations,
  mockEcho,
  openMcpFromPlusMenu,
  openPlusMenu,
  selectThread,
  sendAndAwaitReply,
  signIn,
  signOut,
  startNewThread,
} from '../helpers/app.ts';

describe('the composer + menu and per-chat MCP switches', () => {
  const creds = uniqueCreds();
  let alpha: string;
  let beta: string;

  before(async () => {
    await provisionUser(creds);
    alpha = await addMockMcpServer(creds, 'Mock Alpha', 'alpha');
    beta = await addMockMcpServer(creds, 'Mock Beta', 'beta');
    await signIn(creds);
    await goToSurface('chat');
  });

  it('offers Attach and MCP from the +', async () => {
    await openPlusMenu();
    // Attach is still first: the web item that opens the file picker, or the
    // native sheet's existing attach actions (unchanged, so the native
    // attachments helper still finds them).
    if (platform() === 'web' || platform() === 'electron') await waitForVisible('composer.plus.attach');
    else await waitForVisible('composer.attach.library');
    await shot('plus-menu');
    await closePlusMenu();
  });

  it('lists the connected servers, each on by default', async () => {
    await openPlusMenu();
    await openMcpFromPlusMenu();
    await waitForSwitch(`composer.mcp.toggle.${alpha}`, true);
    await waitForSwitch(`composer.mcp.toggle.${beta}`, true);
    await shot('plus-menu-mcp');
    await closePlusMenu();
  });

  it("leaves a server switched off before a new chat's first message out of that very message", async () => {
    await startNewThread('chat');
    await openPlusMenu();
    await openMcpFromPlusMenu();
    await tap(`composer.mcp.toggle.${beta}`);
    await waitForSwitch(`composer.mcp.toggle.${beta}`, false);
    // The row's own identifier is not an element under XCUITest; the stored
    // choice is asserted through the API below on every platform.
    if (platform() !== 'ios') await waitForTextIn(`composer.mcp.server.${beta}`, 'this chat');
    await closePlusMenu();

    const prompt = 'which servers can you see';
    await sendAndAwaitReply(prompt, mockEcho(prompt));

    const [conv] = await listConversations(creds);
    expect(await conversationMcpOverrides(creds, conv.id)).toMatchObject({ disabledServerIds: [beta] });
    const keys = await lastToolSourceKeys(creds, conv.id);
    expect(keys).toContain('builtin');
    expect(keys).toContain(alpha);
    expect(keys).not.toContain(beta);
  });

  it('keeps the choice when the menu opens again on the same chat', async () => {
    await openPlusMenu();
    await openMcpFromPlusMenu();
    await waitForSwitch(`composer.mcp.toggle.${beta}`, false);
    await waitForSwitch(`composer.mcp.toggle.${alpha}`, true);
    await closePlusMenu();
  });

  it('lists what each server cost under Tool definitions, and switches one off from there', async function () {
    // Overlay testIDs inside the context popover are not visible to the iOS
    // driver (the limit context-live.spec.ts documents).
    if (platform() === 'ios') this.skip();

    await tap('composer.context');
    await tap('context.tools');
    await waitForVisible('context.toolSource.builtin');
    await waitForVisible(`context.toolSource.${alpha}`);
    // Beta was off for the request being described, so it is not in it.
    expect(await isVisible(`context.toolSource.${beta}`)).toBe(false);

    await tap(`context.toolSource.${alpha}.toggle`);
    await waitForTextIn(`context.toolSource.${alpha}`, 'frees');
    await shot('context-tool-sources-off');

    await closeContextPopover();
    await waitForGone('context.toolSource.builtin');

    const [conv] = await listConversations(creds);
    await browser.waitUntil(
      async () => (await conversationMcpOverrides(creds, conv.id))?.disabledServerIds?.includes(alpha) === true,
      { timeout: 10_000, timeoutMsg: 'switching Mock Alpha off in the context popup did not reach the server' },
    );

    const prompt = 'and now';
    await sendAndAwaitReply(prompt, mockEcho(prompt));
    await browser.waitUntil(async () => !(await lastToolSourceKeys(creds, conv.id)).includes(alpha), {
      timeout: 10_000,
      timeoutMsg: 'the next request still carried Mock Alpha',
    });
    expect(await lastToolSourceKeys(creds, conv.id)).toEqual(['builtin']);
  });

  it('switches a server back on for the next message', async () => {
    await openPlusMenu();
    await openMcpFromPlusMenu();
    await tap(`composer.mcp.toggle.${beta}`);
    await waitForSwitch(`composer.mcp.toggle.${beta}`, true);
    await closePlusMenu();

    const [conv] = await listConversations(creds);
    const prompt = 'one more';
    await sendAndAwaitReply(prompt, mockEcho(prompt));
    await browser.waitUntil(async () => (await lastToolSourceKeys(creds, conv.id)).includes(beta), {
      timeout: 10_000,
      timeoutMsg: 'switching Mock Beta back on did not put it in the next request',
    });
  });

  it('shows a shared editor the switches as locked, since only the owner may change them', async () => {
    const [conv] = await listConversations(creds);
    const guest: Credentials = await provisionUser(uniqueCreds());
    const signInRes = await fetch(`${BASE_URL}/api/auth/sign-in`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: guest.email, password: guest.password }),
    });
    const guestId = ((await signInRes.json()) as { user: { id: string } }).user.id;
    const share = await fetch(`${BASE_URL}/v1/conversations/${conv.id}/shares`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${await apiToken(creds)}`, 'content-type': 'application/json' },
      body: JSON.stringify({ user_id: guestId, role: 'editor' }),
    });
    expect(share.status).toBe(200);

    await signOut();
    await signIn(guest);
    await goToSurface('chat');
    await selectThread(conv.id);
    await openPlusMenu();
    await openMcpFromPlusMenu();
    await waitForTextIn('composer.mcp.locked', 'owner');
    await shot('plus-menu-mcp-editor-locked');
    await closePlusMenu();
  });
});
