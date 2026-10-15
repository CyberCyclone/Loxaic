/**
 * Changing a conversation's image (#253): never while it runs, and when it
 * does, the history stays and the workspace's files move into the new image,
 * where the next turn runs.
 *
 * The shared image comes from the mock registry (scripts/mock-registry.ts),
 * loaded through the API; loading one through the screens is
 * custom-images.spec.ts's subject.
 */
import { BASE_URL, mockRegistry } from '../../scripts/standup.ts';
import { REGISTRY_PASSWORD, REGISTRY_USERNAME } from '../../scripts/mock-registry.ts';
import { adminCreds, apiToken, provisionAdmin, provisionUser, uniqueCreds, type Credentials } from '../helpers/auth.ts';
import { shot } from '../helpers/screenshot.ts';
import { platform, scrollTo, tap, waitForAbsent, waitForFreshText, waitForTextIn, waitForVisible } from '../helpers/selectors.ts';
import {
  BASH_PROMPT,
  MOCK_BASH_OUTPUT,
  SLOW_PROMPT,
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

async function runBash(): Promise<void> {
  await sendMessage(BASH_PROMPT);
  await waitForVisible('agent.permission.bar', 120_000);
  await tap('agent.permission.allow');
  await waitForToolResult(MOCK_BASH_OUTPUT);
}

describe("changing a conversation's image (#253)", function () {
  this.timeout(600_000);
  let user: Credentials;
  let sharedId = '';
  let conversationId = '';

  before(async () => {
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
    const admin = adminCreds();
    await api(admin, 'DELETE', `/v1/admin/images/${sharedId}`).catch(() => undefined);
    const logins = ((await api(admin, 'GET', '/v1/admin/images/logins').catch(() => ({ logins: [] }))) as { logins: { id: string }[] }).logins;
    for (const login of logins) await api(admin, 'DELETE', `/v1/admin/images/logins/${login.id}`).catch(() => undefined);
    await resetSandboxSettings();
  });

  it("refuses while a run is going, and offers it once the run ends", async () => {
    await goToSurface('agent');
    await startNewAgentRun();
    await sendMessage(BASH_PROMPT);
    await waitForVisible('agent.permission.bar', 120_000);
    await tap('agent.permission.allow');
    await waitForToolResult(MOCK_BASH_OUTPUT);
    conversationId = (await listConversations(user)).find((c) => c.kind === 'agent')?.id ?? '';
    expect(conversationId).not.toBe('');

    // A slow reply holds the run open long enough to look.
    await sendMessage(SLOW_PROMPT);
    await openInspector();
    await scrollTo('agent.inspector.workspace.changeImage');
    await waitForFreshText('agent.inspector.workspace.changeImage.reason', 'Stop the run first');
    await shot('image-switch-refused-while-running');
    // And the server refuses too, whatever a client sends.
    await expect(api(user, 'POST', `/v1/conversations/${conversationId}/image`, { image: { id: sharedId } })).rejects.toThrow(/409/);

    await waitForRunDone(user, conversationId);
    await waitForAbsent('agent.inspector.workspace.changeImage.reason', 30_000);
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
    await waitForTextIn('chat.messageList', MOCK_BASH_OUTPUT);

    const token = await apiToken(user);
    const [sandbox] = await listSandboxes(token, conversationId);
    const inside = await execInSandbox(token, sandbox.id, 'cat /opt/marker && test -e /home/loxaic/repo/.mock-bash && echo files-moved && stat -c %u /home/loxaic/repo/.mock-bash');
    expect(inside.stdout).toContain('custom-image-marker');
    expect(inside.stdout).toContain('files-moved');
    expect(inside.stdout).toContain('1234');
  });

  it('runs the next turn in the new image', async () => {
    await runBash();
    await waitForRunDone(user, conversationId);
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
