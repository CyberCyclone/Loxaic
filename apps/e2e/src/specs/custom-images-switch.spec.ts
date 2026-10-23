/**
 * Changing a conversation's image (#253): never while it runs, and when it
 * does, the history stays and the workspace's files move into the new image,
 * where the next turn runs.
 *
 * The shared image comes from the mock registry (scripts/mock-registry.ts),
 * loaded through the API; loading one through the screens is
 * custom-images.spec.ts's subject.
 */
import { BASE_URL, SANDBOX_HOST_MODE, mockRegistry } from '../../scripts/standup.ts';
import { REGISTRY_PASSWORD, REGISTRY_USERNAME } from '../../scripts/mock-registry.ts';
import { adminCreds, apiToken, provisionAdmin, provisionUser, uniqueCreds, type Credentials } from '../helpers/auth.ts';
import { shot } from '../helpers/screenshot.ts';
import { platform, scrollTo, tap, waitForAbsent, waitForFreshText, waitForTextIn, waitForVisible } from '../helpers/selectors.ts';
import {
  BASH_PROMPT,
  MOCK_BASH_OUTPUT,
  MOCK_TOOL_DONE,
  closeInspector,
  execInSandbox,
  goToSurface,
  listConversations,
  listSandboxes,
  openInspector,
  patchSandboxSettings,
  resetSandboxSettings,
  selectThread,
  sendMessage,
  signIn,
  startNewAgentRun,
  waitForRunDone,
  waitForToolResult,
  requiresContainerEngine,
} from '../helpers/app.ts';

async function api(creds: Pick<Credentials, 'email' | 'password'>, method: string, pathname: string, body?: unknown): Promise<unknown> {
  const token = await apiToken(creds);
  const res = await fetch(`${BASE_URL}${pathname}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`[e2e] ${method} ${pathname} failed (${String(res.status)}): ${text}`);
  return text ? JSON.parse(text) : null;
}

const native = () => platform() === 'ios' || platform() === 'android';

/** The conversation's stored messages, as text: what it holds whatever is
 * on screen (XCUITest cannot see a line scrolled above the fold). */
async function storedHistory(creds: Credentials, id: string): Promise<{ ids: string[]; text: string }> {
  const page = (await api(creds, 'GET', `/v1/conversations/${id}/messages`)) as { messages: { id: string }[] };
  return { ids: page.messages.map((m) => m.id), text: JSON.stringify(page.messages) };
}

function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

describe("changing a conversation's image (#253)", function () {
  this.timeout(600_000);
  let user: Credentials;
  let sharedId = '';
  let conversationId = '';
  let historyBefore: string[] = [];

  before(async function () {
    requiresContainerEngine(this, 'custom images need a container engine and the mock registry');
    const registry = mockRegistry();
    const admin = await provisionAdmin();
    await resetSandboxSettings();
    await patchSandboxSettings({ customImages: 'shared' });
    await api(admin, 'PUT', '/v1/admin/images/logins', { registry: registry.host, username: REGISTRY_USERNAME, password: REGISTRY_PASSWORD });
    const added = (await api(admin, 'POST', '/v1/admin/images', { reference: registry.marker, label: 'Marker' })) as { id: string };
    sharedId = added.id;
    await browser.waitUntil(
      async () => {
        const rows = ((await api(admin, 'GET', '/v1/admin/images')) as { images: { id: string; status: string }[] }).images;
        return rows.find((r) => r.id === sharedId)?.status === 'ready';
      },
      { timeout: 180_000, interval: 1_000, timeoutMsg: 'the shared image never became ready' },
    );
    user = await provisionUser(uniqueCreds());
    await signIn(user);
  });

  after(async () => {
    // Mocha runs `after` even when `before` skipped the suite.
    if (SANDBOX_HOST_MODE) return;
    const admin = adminCreds();
    await api(admin, 'DELETE', `/v1/admin/images/${sharedId}`).catch(() => undefined);
    const logins = ((await api(admin, 'GET', '/v1/admin/images/logins').catch(() => ({ logins: [] }))) as { logins: { id: string }[] }).logins;
    for (const login of logins) await api(admin, 'DELETE', `/v1/admin/images/logins/${login.id}`).catch(() => undefined);
    await resetSandboxSettings();
  });

  it("refuses while a run is going, and offers it once the run ends", async () => {
    await goToSurface('agent');
    await startNewAgentRun();
    // A run waiting on a permission prompt is still a run, and holds there
    // for as long as the check below needs, on every platform.
    await sendMessage(BASH_PROMPT);
    await waitForVisible('agent.permission.bar', 120_000);
    conversationId = (await listConversations(user)).find((c) => c.kind === 'agent')?.id ?? '';
    expect(conversationId).not.toBe('');

    await openInspector();
    await scrollTo('agent.inspector.workspace.changeImage');
    await waitForFreshText('agent.inspector.workspace.changeImage.reason', 'Stop the run first');
    await shot('image-switch-refused-while-running');
    // And the server refuses too, whatever a client sends.
    await expect(api(user, 'POST', `/v1/conversations/${conversationId}/image`, { image: { id: sharedId } })).rejects.toThrow(/409/);
    await closeInspector();

    await tap('agent.permission.allow');
    await waitForRunDone(user, conversationId);
    if (!native()) await waitForToolResult(MOCK_BASH_OUTPUT);
    // A side panel on web and Electron stays open (closeInspector leaves it);
    // pressing its toggle again would close it.
    if (native()) await openInspector();
    await scrollTo('agent.inspector.workspace.changeImage');
    await waitForAbsent('agent.inspector.workspace.changeImage.reason', 30_000);
    historyBefore = (await storedHistory(user, conversationId)).ids;
  });

  it('moves the workspace into the new image, keeping its files and the history', async () => {
    await tap('agent.inspector.workspace.changeImage');
    await waitForVisible('agent.imageSwitch.dialog');
    await tap(`agent.imageSwitch.option.${sharedId}`);
    await shot('image-switch-dialog');
    await tap('agent.imageSwitch.confirm');
    await waitForAbsent('agent.imageSwitch.dialog', 120_000);

    if (platform() === 'ios' || platform() === 'android') await openInspector();
    await scrollTo('agent.inspector.workspace.image');
    await waitForFreshText('agent.inspector.workspace.image', 'Marker');
    await shot('image-switch-moved');
    await closeInspector();
    // The history is the same conversation's, untouched.
    expect((await storedHistory(user, conversationId)).ids).toEqual(historyBefore);
    if (!native()) await waitForTextIn('chat.messageList', MOCK_BASH_OUTPUT);

    const token = await apiToken(user);
    const [sandbox] = await listSandboxes(token, conversationId);
    const inside = await execInSandbox(token, sandbox.id, 'cat /opt/marker && test -e /home/loxaic/repo/.mock-bash && echo files-moved && stat -c %u /home/loxaic/repo/.mock-bash');
    expect(inside.stdout).toContain('custom-image-marker');
    expect(inside.stdout).toContain('files-moved');
    expect(inside.stdout).toContain('1234');
  });

  it('runs the next turn in the new image', async () => {
    await sendMessage(BASH_PROMPT);
    await waitForVisible('agent.permission.bar', 120_000);
    await tap('agent.permission.allow');
    await waitForRunDone(user, conversationId);
    // Its tool ran and answered, here as in the turn before the move.
    expect(occurrences((await storedHistory(user, conversationId)).text, MOCK_TOOL_DONE)).toBe(2);
    if (!native()) await waitForToolResult(MOCK_BASH_OUTPUT);
    const token = await apiToken(user);
    const [sandbox] = await listSandboxes(token, conversationId);
    const inside = await execInSandbox(token, sandbox.id, 'id -u && cat /opt/marker');
    expect(inside.stdout).toContain('1234');
    expect(inside.stdout).toContain('custom-image-marker');
  });

  it('tells another open page of the same conversation', async function () {
    if (platform() !== 'web') this.skip();
    const first = await browser.getWindowHandle();
    await browser.newWindow(`${BASE_URL}/agent`);
    const second = await browser.getWindowHandle();
    await waitForVisible('agent.inspector.toggle', 30_000).catch(async () => {
      await goToSurface('agent');
    });
    await selectThread(conversationId, 'agent');
    await openInspector();
    await scrollTo('agent.inspector.workspace.image');
    await waitForFreshText('agent.inspector.workspace.image', 'Marker');

    // Moved back to Loxaic's own image from the first page...
    await browser.switchToWindow(first);
    await scrollTo('agent.inspector.workspace.changeImage');
    await tap('agent.inspector.workspace.changeImage');
    await waitForVisible('agent.imageSwitch.dialog');
    await tap('agent.imageSwitch.option.builtin');
    await tap('agent.imageSwitch.confirm');
    await waitForAbsent('agent.imageSwitch.dialog', 120_000);

    // ...the second page's Inspector follows without a reload.
    await browser.switchToWindow(second);
    await waitForAbsent('agent.inspector.workspace.image', 30_000);
    await shot('image-switch-other-page');
    await browser.closeWindow();
    await browser.switchToWindow(first);
  });
});
