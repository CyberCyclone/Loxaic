/**
 * Deleting a chat, and the header that has to fit its title first (#177, #185).
 *
 * Both halves are here because they are the same header: the ⋮ menu is the
 * fourth control in a row whose title used to push the others off the edge, so
 * a title-overflow regression is also a "Delete is unreachable" regression.
 *
 * The overflow assertion checks **reachability, not visibility** — WebDriver
 * reports `isDisplayed()` true for an element pushed past the viewport edge,
 * so a visibility check passes with the bug and without it (AGENTS.md records
 * the same trap in mcp-servers.spec.ts). It compares bounding rectangles
 * instead: the title must end at or before the controls begin, and the last
 * control must be inside the viewport.
 *
 * Retention is driven through the admin API rather than the settings card,
 * for the reason sharing.spec.ts drives its share over the API: the subject is
 * what the *delete* does under each policy, not the switch. It is restored in
 * `after` — it is a deployment-wide setting and every other spec's deletes
 * would otherwise start being kept.
 */
import { browser } from '@wdio/globals';
import { provisionUser, apiToken, adminCreds, uniqueCreds } from '../helpers/auth.ts';
import { BASE_URL } from '../../scripts/standup.ts';
import { shot } from '../helpers/screenshot.ts';
import { byTestId, tap, platform, waitForVisible, waitForGone } from '../helpers/selectors.ts';
import {
  listConversations,
  openThreadList,
  sendAndAwaitReply,
  signUp,
  mockEcho,
  waitForComposerReady,
} from '../helpers/app.ts';

/** A first message long enough that its derived title cannot fit a phone
 * header — which is exactly how #185 was reported. */
const LONG_PROMPT =
  'why does the conversation title overflow the header bar on a narrow phone screen and what should we do about it';

/** A phone, for the one assertion that only means anything at that width. */
const PHONE = { width: 390, height: 844 };
/** What the rest of the suite expects to be looking at. */
const DESKTOP = { width: 1440, height: 900 };

async function setRetention(patch: { keepDeleted?: boolean; keepDeletedDays?: number }): Promise<void> {
  const token = await apiToken(adminCreds());
  const res = await fetch(`${BASE_URL}/v1/admin/settings/conversations`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    throw new Error(`[e2e] retention patch failed (${String(res.status)}): ${await res.text()}`);
  }
}

async function adminConversation(id: string) {
  const token = await apiToken(adminCreds());
  const res = await fetch(`${BASE_URL}/v1/admin/conversations`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`[e2e] admin list failed (${String(res.status)})`);
  const rows = (await res.json()) as { id: string; deletedAt: string | null; purgeAt: string | null }[];
  return rows.find((r) => r.id === id) ?? null;
}

async function readStatusAs(token: string, conversationId: string): Promise<number> {
  const res = await fetch(`${BASE_URL}/v1/conversations/${conversationId}/messages`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return res.status;
}

describe('deleting a conversation', () => {
  const owner = uniqueCreds();
  let convId: string;
  let secondId: string;

  after(async () => {
    // Deployment-wide: left on, every other spec's deletes would be kept and
    // the sandbox/agent specs would start finding conversations they deleted.
    await setRetention({ keepDeleted: false }).catch(() => undefined);
    // Belt and braces on the window: a failure inside the phone-width test
    // would otherwise leave this session narrow for everything after it.
    if (platform() === 'web' || platform() === 'electron') {
      await browser.setWindowSize(DESKTOP.width, DESKTOP.height).catch(() => undefined);
    }
  });

  it('starts a conversation whose title is far wider than the header', async () => {
    await setRetention({ keepDeleted: false });
    await signUp(owner);
    await sendAndAwaitReply(LONG_PROMPT, mockEcho(LONG_PROMPT));

    const convs = await listConversations(owner);
    expect(convs).toHaveLength(1);
    convId = convs[0].id;
    // The title really is derived from the message, which is what makes this
    // the reported case rather than a contrived one.
    expect(convs[0].title.length).toBeGreaterThan(40);
  });

  it('keeps the header controls reachable beside that title', async function headerFits() {
    // At the browser's default 1440px this assertion passes with the bug and
    // without it — the title simply fits. #185 was reported from a phone, so
    // the window is narrowed to one for the measurement and restored after.
    // Native is already this size, and has no resizable window.
    if (platform() === 'web' || platform() === 'electron') {
      await browser.setWindowSize(PHONE.width, PHONE.height);
      // The header re-lays out on the resize; wait for the narrow layout's own
      // control to appear rather than racing it.
      await waitForVisible('chat.threadList.toggle');
    }

    // Rect arithmetic, which Appium reports in device points on native and
    // CSS pixels on web — both fine, since every value compared here comes
    // from the same source.
    const title = byTestId('shell.header.title');
    await title.waitForDisplayed();
    const menu = byTestId('chat.header.menu');
    await menu.waitForDisplayed();

    const titleRect = { ...(await title.getLocation()), ...(await title.getSize()) };
    const menuRect = { ...(await menu.getLocation()), ...(await menu.getSize()) };
    const { width: viewportWidth } = await browser.getWindowSize();

    // The bug: the title sized to its content and sat on top of the controls.
    // A pixel of slack for sub-pixel layout rounding.
    expect(titleRect.x + titleRect.width).toBeLessThanOrEqual(menuRect.x + 1);
    // …and the menu is on screen, not pushed past the edge — the half
    // `isDisplayed()` cannot see.
    expect(menuRect.x + menuRect.width).toBeLessThanOrEqual(viewportWidth + 1);
    // One line: the fix is truncation, not wrapping into a taller header.
    expect(titleRect.height).toBeLessThan(40);
    await shot('delete-header-long-title');

    if (platform() === 'web' || platform() === 'electron') {
      await browser.setWindowSize(DESKTOP.width, DESKTOP.height);
    }
  });

  it('asks before deleting, and cancelling changes nothing', async () => {
    await tap('chat.header.menu');
    await waitForVisible('chat.header.delete');
    await shot('delete-header-menu');
    await tap('chat.header.delete');

    await waitForVisible('chat.deleteConfirm.dialog');
    // With retention off the dialog must say the messages are erased — the
    // wording is a promise about someone's data, and it comes from the server.
    const body = await byTestId('chat.deleteConfirm.dialog').getText();
    expect(body).toContain('erased');
    await shot('delete-confirm-erase');

    await tap('chat.deleteConfirm.cancel');
    await waitForGone('chat.deleteConfirm.dialog');
    // Still there, over the API — the sidebar merely not updating would look
    // the same as a delete that failed to reach the server.
    expect((await listConversations(owner)).map((c) => c.id)).toContain(convId);
  });

  it('erases it when confirmed, on the server and not just on screen', async () => {
    await tap('chat.header.menu');
    await tap('chat.header.delete');
    await waitForVisible('chat.deleteConfirm.dialog');
    await tap('chat.deleteConfirm.confirm');
    await waitForGone('chat.deleteConfirm.dialog');

    await browser.waitUntil(
      async () => !(await listConversations(owner)).some((c) => c.id === convId),
      { timeout: 15_000, timeoutMsg: 'the conversation was still listed after deleting it' },
    );
    // Gone by id too, not merely absent from the list.
    expect(await readStatusAs(await apiToken(owner), convId)).toBe(404);
    await shot('delete-after-erase');
  });

  // Asserted over the API, not by signing the guest in: signing a second
  // person into the same app instance signs the first one out, and what is
  // being proved is the server's answer. The client-side gate (the ⋮ renders
  // only for an owner) is a courtesy on top of this, not the enforcement.
  it('refuses a shared editor\'s delete, silently and without deleting', async () => {
    const guest = await provisionUser();
    const guestToken = await apiToken(guest);
    const ownerToken = await apiToken(owner);

    await sendAndAwaitReply('a second thread', mockEcho('a second thread'));
    const second = (await listConversations(owner)).find((c) => c.id !== convId);
    if (!second) throw new Error('[e2e] the second conversation was not created');
    secondId = second.id;

    const guestId = await userIdOf(guest);
    const share = await fetch(`${BASE_URL}/v1/conversations/${secondId}/shares`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${ownerToken}`, 'content-type': 'application/json' },
      // Editor, deliberately: the strongest role a share can grant still may
      // not delete, so viewer would prove less.
      body: JSON.stringify({ user_id: guestId, role: 'editor' }),
    });
    expect(share.status).toBe(200);

    // The server's answer is the one that matters — the UI gate is a courtesy.
    const attempt = await fetch(`${BASE_URL}/v1/conversations/${secondId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${guestToken}` },
    });
    // 200 and nothing happened: a non-owner's delete is indistinguishable
    // from deleting something already gone, deliberately.
    expect(attempt.status).toBe(200);
    expect(await readStatusAs(ownerToken, secondId)).toBe(200);
  });

  it('keeps a deleted chat for an audit when the server is set to, and says so first', async () => {
    await setRetention({ keepDeleted: true, keepDeletedDays: 30 });
    // The dialog reads the policy from /v1/config, which the app fetches on
    // mount — reload so this is the page's own answer, not a cached one. And
    // wait for the app to come back up before reaching for its chrome: a
    // refresh re-runs sign-in from stored session, and `openThreadList` fails
    // on the toggle rather than on anything to do with this feature.
    await browser.refresh();
    await waitForComposerReady();
    await openThreadList('chat');
    await tap(`threadList.item.${secondId}`);

    await tap('chat.header.menu');
    await tap('chat.header.delete');
    await waitForVisible('chat.deleteConfirm.dialog');
    const body = await byTestId('chat.deleteConfirm.dialog').getText();
    // Names the window rather than claiming the messages are gone.
    expect(body).toContain('30 days');
    await shot('delete-confirm-retained');
    await tap('chat.deleteConfirm.confirm');
    await waitForGone('chat.deleteConfirm.dialog');

    const ownerToken = await apiToken(owner);
    await browser.waitUntil(async () => (await readStatusAs(ownerToken, secondId)) === 404, {
      timeout: 15_000,
      timeoutMsg: 'the retained conversation was still readable by its owner',
    });
    // Gone for its owner, and kept for an administrator — both halves, since
    // either one alone is a different feature.
    const row = await adminConversation(secondId);
    expect(row?.deletedAt).toBeTruthy();
    expect(row?.purgeAt).toBeTruthy();
  });

  it('lets an admin see it, restore it, and erase it for good', async function adminAudit() {
    // Web and Electron only: the admin screen is reached through the nav rail,
    // and signing the admin in means signing the owner out — on native that is
    // a slow app-relaunch dance this assertion does not need. The routes
    // themselves are covered by the server's own suite on every platform.
    if (platform() === 'ios' || platform() === 'android') this.skip();

    const token = await apiToken(adminCreds());
    // Restore, through the API the screen calls.
    const restore = await fetch(`${BASE_URL}/v1/admin/conversations/${secondId}/restore`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(restore.status).toBe(200);
    expect(await readStatusAs(await apiToken(owner), secondId)).toBe(200);
    await shot('delete-restored-to-owner');

    // …and erase it, which is the end of the line for it.
    const ownerToken = await apiToken(owner);
    await fetch(`${BASE_URL}/v1/conversations/${secondId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    const purge = await fetch(`${BASE_URL}/v1/admin/conversations/${secondId}/purge`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(purge.status).toBe(200);
    expect(await adminConversation(secondId)).toBeNull();
  });
});

/**
 * A user's id, which a share is addressed to.
 *
 * From the sign-in response, which carries it — the same route `apiToken`
 * uses, and the shape sharing.spec.ts's own `signInApi` reads.
 */
async function userIdOf(creds: { email: string; password: string }): Promise<string> {
  const res = await fetch(`${BASE_URL}/api/auth/sign-in`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: creds.email, password: creds.password }),
  });
  if (!res.ok) throw new Error(`[e2e] sign-in failed (${String(res.status)}): ${await res.text()}`);
  const body = (await res.json()) as { user?: { id: string } };
  if (!body.user?.id) throw new Error(`[e2e] sign-in response carried no user: ${JSON.stringify(body)}`);
  return body.user.id;
}
