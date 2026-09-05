/**
 * Conversation sharing, end to end and across two real accounts.
 *
 * The point of the feature is what one user can see of another's, so a
 * single-account test would prove nothing. The owner's side is driven through
 * the UI (share sheet, badge, composer); the second user is created and
 * inspected over the API, because signing a second person into the same app
 * instance means signing the first one out, and the interesting assertions —
 * can they read it, can they send into it — are answers the server gives.
 *
 * Runs on every platform: the share sheet is ordinary UI with no
 * platform-specific picker behind it, unlike attachments.
 */
import { provisionUser, apiToken, uniqueCreds, type Credentials } from '../helpers/auth.ts';
import { BASE_URL } from '../../scripts/standup.ts';
import { shot } from '../helpers/screenshot.ts';
import { tap, longPress, platform, waitForVisible, isVisible } from '../helpers/selectors.ts';
import { openThreadList, sendAndAwaitReply, signIn, signOut, signUp, mockEcho } from '../helpers/app.ts';

interface ApiConversation {
  id: string;
  title: string;
  role?: string;
}

async function listConversations(token: string): Promise<ApiConversation[]> {
  const res = await fetch(`${BASE_URL}/v1/conversations`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`list failed: ${String(res.status)}`);
  return (await res.json()) as ApiConversation[];
}

/**
 * Status the server gives this token for reading the thread's messages.
 *
 * Named for what it does. Whether a *send* is refused is enforced on the WS
 * path and covered by the server's own authz and route tests; driving a
 * rejected socket send from here would assert on the absence of a reply,
 * which is indistinguishable from a slow one.
 */
async function readStatusAs(token: string, conversationId: string): Promise<number> {
  const res = await fetch(`${BASE_URL}/v1/conversations/${conversationId}/messages`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return res.status;
}

describe('conversation sharing', () => {
  const owner = uniqueCreds();
  let guest: Credentials;
  let guestToken: string;
  let guestId: string;
  let convId: string;

  before(async () => {
    guest = await provisionUser();
    ({ token: guestToken, userId: guestId } = await signInApi(guest));
  });

  it('signs in an owner and starts a conversation worth sharing', async () => {
    await signUp(owner);
    const prompt = 'a thread to share';
    await sendAndAwaitReply(prompt, mockEcho(prompt));

    const ownerToken = await apiToken(owner);
    const convs = await listConversations(ownerToken);
    expect(convs).toHaveLength(1);
    convId = convs[0].id;
    // The owner's own conversation reports `owner`, which is what keeps the
    // share action and the composer enabled.
    expect(convs[0].role).toBe('owner');
  });

  it('is invisible to another user before it is shared', async () => {
    expect(await listConversations(guestToken)).toHaveLength(0);
    // Not merely absent from the list — unreadable by id, which is the part
    // that matters if an id ever leaks.
    expect(await readStatusAs(guestToken, convId)).toBe(404);
  });

  it('offers the owner a share sheet listing nobody yet', async function shareSheet() {
    // Skipped on iOS: the sheet is reached by long-pressing a thread row, and
    // XCUITest's synthesized hold does not reach React Native's long-press
    // recogniser here — `mobile: touchAndHold` at 0.8s and at 2s both resolve
    // as a plain tap (the row selects, no sheet). It is the *gesture* that
    // won't drive, not the feature: the same sheet, testIDs and all, is
    // exercised on web and Android, and every non-gesture assertion in this
    // spec runs on iOS too.
    if (platform() === 'ios') this.skip();

    await openThreadList('chat');
    const row = `threadList.item.${convId}`;
    await waitForVisible(row);
    // Long-press is the cross-platform route to the row actions — web's hover
    // actions have no touch fallback (see ThreadList's own comment).
    await longPress(row);
    await waitForVisible('threadList.share');
    await tap('threadList.share');
    // "Only you can see this" is the honest empty state, and its presence
    // proves the sheet read the (empty) share list rather than failing open.
    await waitForVisible('share.empty');
    await shot('sharing-share-sheet-empty');
    await tap('share.close');
  });

  it('grants the second user view access and they can read it', async () => {
    // Driven over the API rather than the sheet: the sheet's people-picker
    // needs a directory search against a name only this run knows, and what
    // is being proved here is the access change, not the search box.
    const ownerToken = await apiToken(owner);
    const res = await fetch(`${BASE_URL}/v1/conversations/${convId}/shares`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${ownerToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ user_id: guestId, role: 'viewer' }),
    });
    expect(res.status).toBe(200);

    const convs = await listConversations(guestToken);
    expect(convs).toHaveLength(1);
    expect(convs[0].id).toBe(convId);
    expect(convs[0].role).toBe('viewer');
    expect(await readStatusAs(guestToken, convId)).toBe(200);
  });

  it('shows the viewer a shared badge and a composer they cannot type in', async () => {
    // The guest account already exists (provisioned over the API in `before`),
    // so this is a sign-in, not a sign-up.
    await signOut();
    await signIn(guest);

    await openThreadList('chat');
    await waitForVisible(`threadList.shared.${convId}`);
    await tap(`threadList.item.${convId}`);

    // The composer is replaced by an explanation, not merely disabled — the
    // read-only notice is the assertion, and composer.input should be gone.
    await waitForVisible('composer.readOnly');
    expect(await isVisible('composer.input')).toBe(false);
    await shot('sharing-viewer-read-only');
  });

  it('revoking removes it from the viewer entirely', async () => {
    const ownerToken = await apiToken(owner);
    const res = await fetch(
      `${BASE_URL}/v1/conversations/${convId}/shares/${guestId}`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${ownerToken}` } },
    );
    expect(res.status).toBe(200);

    expect(await listConversations(guestToken)).toHaveLength(0);
    expect(await readStatusAs(guestToken, convId)).toBe(404);
  });
});

/**
 * A user's own id, read from the sign-in response rather than a session
 * lookup — better-auth returns the user alongside the token, so this needs no
 * second round-trip and no assumption about the session endpoint's shape.
 */
async function signInApi(creds: Credentials): Promise<{ token: string; userId: string }> {
  const res = await fetch(`${BASE_URL}/api/auth/sign-in`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: creds.email, password: creds.password }),
  });
  if (!res.ok) throw new Error(`sign-in failed (${String(res.status)}): ${await res.text()}`);
  const body = (await res.json()) as { token: string; user?: { id: string } };
  if (!body.user?.id) throw new Error(`sign-in response carried no user: ${JSON.stringify(body)}`);
  return { token: body.token, userId: body.user.id };
}


