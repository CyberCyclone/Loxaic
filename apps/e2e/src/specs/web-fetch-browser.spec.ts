/**
 * web_fetch's browser fallback (#281): a page that refuses a plain fetch, or
 * only exists once its script has run, comes back rendered; a screenshot shows
 * on the tool card, opens in the viewer and is still there after a reload;
 * two conversations never share a browser's cookies; and with browsing off,
 * web_fetch is the plain fetch it always was.
 *
 * The pages are `scripts/mock-web.ts`, on loopback, let through the server's
 * address guard by standup's LOXAIC_E2E_FETCH_ALLOW. Browsing is switched on
 * through the admin API here and off again after, never pinned by env. The
 * first run on a machine downloads Chromium (~100 MB) into the harness's
 * cache; later runs reuse it.
 */
import { adminCreds, apiToken, provisionAdmin, provisionUser, uniqueCreds, type Credentials } from '../helpers/auth.ts';
import { shot } from '../helpers/screenshot.ts';
import { platform, scrollTo, tap, waitForFreshText, waitForGone, waitForVisible } from '../helpers/selectors.ts';
import {
  goToSurface,
  listConversations,
  openSettings,
  sendInNewRun,
  sendMessage,
  signIn,
  signOut,
  startNewAgentRun,
  startNewThread,
  waitForRunDone,
} from '../helpers/app.ts';
import { BASE_URL } from '../../scripts/standup.ts';
import { SCRIPT_TEXT, WALLED_TEXT } from '../../scripts/mock-web.ts';

interface BrowserView {
  enabled: boolean;
  status: { install: { state: string; percent?: number | null; error?: string } };
}

async function adminBrowser(method: 'GET' | 'PATCH' | 'POST', path: string, body?: unknown): Promise<BrowserView> {
  const token = await apiToken(adminCreds());
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!res.ok) throw new Error(`[e2e] ${method} ${path} failed (${String(res.status)}): ${await res.text()}`);
  return (await res.json()) as BrowserView;
}

/** Installs Chromium if this machine's cache has none, then switches browsing on. */
async function enableBrowsing(): Promise<void> {
  let view = await adminBrowser('GET', '/v1/admin/settings/browser');
  if (view.status.install.state !== 'installed') {
    await adminBrowser('POST', '/v1/admin/browser/install');
    const deadline = Date.now() + 10 * 60_000;
    for (;;) {
      view = await adminBrowser('GET', '/v1/admin/settings/browser');
      if (view.status.install.state === 'installed') break;
      if (view.status.install.state === 'failed') throw new Error(`[e2e] Chromium install failed: ${String(view.status.install.error)}`);
      if (Date.now() > deadline) throw new Error('[e2e] Chromium install did not finish in 10 minutes');
      await new Promise((r) => setTimeout(r, 2_000));
    }
  }
  await adminBrowser('PATCH', '/v1/admin/settings/browser', { enabled: true });
}

/** The tool results of a conversation, screenshots included. */
async function results(creds: Credentials, conversationId: string): Promise<{ call_id: string; output: string; ok?: boolean; images?: { ref: string }[] }[]> {
  const token = await apiToken(creds);
  const res = await fetch(`${BASE_URL}/v1/conversations/${conversationId}/messages`, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`[e2e] messages failed (${String(res.status)})`);
  const body = (await res.json()) as { messages: { content: { kind: string; call_id?: string; output?: string; ok?: boolean; images?: { ref: string }[] }[] }[] };
  return body.messages.flatMap((m) =>
    m.content.filter((b) => b.kind === 'tool_result').map((b) => ({ call_id: b.call_id ?? '', output: b.output ?? '', ok: b.ok, ...(b.images ? { images: b.images } : {}) })),
  );
}

/** Sends in a new chat thread and returns its id (the chat-surface twin of sendInNewRun). */
async function sendInNewChat(creds: Credentials, prompt: string): Promise<string> {
  await startNewThread('chat');
  const before = new Set((await listConversations(creds)).map((c) => c.id));
  await sendMessage(prompt);
  let id = '';
  await browser.waitUntil(
    async () => {
      id = (await listConversations(creds)).find((c) => c.kind !== 'agent' && !before.has(c.id))?.id ?? '';
      return id !== '';
    },
    { timeout: 20_000, timeoutMsg: 'the chat never appeared in the conversation list' },
  );
  return id;
}

async function expandCard(callId: string): Promise<void> {
  await scrollTo(`chat.toolCall.header.${callId}`);
  await tap(`chat.toolCall.header.${callId}`);
}

describe('web_fetch falls back to a browser', () => {
  const creds = uniqueCreds();

  before(async function () {
    this.timeout(12 * 60_000);
    await provisionAdmin();
    await enableBrowsing();
    await provisionUser(creds);
    await signIn(creds);
    await goToSurface('chat');
  });

  after(async () => {
    await adminBrowser('PATCH', '/v1/admin/settings/browser', { enabled: false });
  });

  it('reads a page that refuses a plain fetch, and says it used the browser', async function () {
    this.timeout(3 * 60_000);
    const conv = await sendInNewChat(creds, 'read the walled page');
    await waitForRunDone(creds, conv);
    const [result] = await results(creds, conv);
    expect(result.ok).toBe(true);
    expect(result.output).toContain('[Rendered in a browser: the plain fetch returned 403.]');
    expect(result.output).toContain(WALLED_TEXT);
    await expandCard(result.call_id);
    await waitForFreshText(`chat.toolCall.resultText.${result.call_id}`, WALLED_TEXT);
    await shot('web-fetch-rendered-walled');
  });

  it('renders a page whose text only its script draws, on the agent surface too', async function () {
    this.timeout(3 * 60_000);
    await goToSurface('agent');
    await startNewAgentRun();
    const conv = await sendInNewRun(creds, 'read the script page');
    await waitForRunDone(creds, conv);
    const [result] = await results(creds, conv);
    expect(result.output).toContain('the page builds itself with JavaScript');
    expect(result.output).toContain(SCRIPT_TEXT);
    await goToSurface('chat');
  });

  it('shows a screenshot on the card, opens it, and keeps it after a reload', async function () {
    this.timeout(3 * 60_000);
    const conv = await sendInNewChat(creds, 'screenshot the script page');
    await waitForRunDone(creds, conv);
    const [result] = await results(creds, conv);
    expect(result.images).toHaveLength(1);
    const thumb = `chat.toolCall.screenshot.${result.call_id}`;
    await scrollTo(thumb);
    await shot('web-fetch-screenshot-thumb');
    await tap(thumb);
    // As attachments.spec does: the image is what every platform exposes
    // once the viewer is up.
    await waitForVisible('viewer.image');
    await shot('web-fetch-screenshot-viewer');
    await tap('viewer.close');
    await waitForGone('viewer.image');
    if (platform() === 'web' || platform() === 'electron') {
      await browser.refresh();
      await waitForVisible(thumb, 30_000);
    }
  });

  it('keeps cookies inside one conversation; another starts with none', async function () {
    this.timeout(4 * 60_000);
    const first = await sendInNewChat(creds, 'visit the cookie setter');
    await waitForRunDone(creds, first);
    await sendMessage('check the cookie echo');
    await waitForRunDone(creds, first);
    const echoed = (await results(creds, first)).at(-1);
    expect(echoed?.output).toMatch(/Cookie seen: loxaic_e2e=\d+/);

    const second = await sendInNewChat(creds, 'check the cookie echo');
    await waitForRunDone(creds, second);
    const [fresh] = await results(creds, second);
    expect(fresh.output).toContain('Cookie seen: none');
    await expandCard(fresh.call_id);
    await waitForFreshText(`chat.toolCall.resultText.${fresh.call_id}`, 'Cookie seen: none');
    await shot('web-fetch-second-conversation-no-cookie');
  });

  it('is the plain fetch it always was with browsing off', async function () {
    this.timeout(3 * 60_000);
    await adminBrowser('PATCH', '/v1/admin/settings/browser', { enabled: false });
    try {
      const conv = await sendInNewChat(creds, 'read the walled page');
      await waitForRunDone(creds, conv);
      const [result] = await results(creds, conv);
      expect(result.ok).toBe(false);
      expect(result.output).toContain('HTTP 403');
      expect(result.output).not.toContain('Rendered in a browser');
      // Scrolled to first: on iOS the keyboard left up by the send covers the
      // newest card, and XCUITest reports what it covers as not displayed.
      await scrollTo(`chat.toolCall.failed.${result.call_id}`);
      await waitForVisible(`chat.toolCall.failed.${result.call_id}`);
    } finally {
      await adminBrowser('PATCH', '/v1/admin/settings/browser', { enabled: true });
    }
  });

  it('lets an admin see the switch and what Chromium is doing', async function () {
    this.timeout(2 * 60_000);
    await signOut();
    await signIn(adminCreds());
    await openSettings();
    await scrollTo('settings.nav.sandbox');
    await tap('settings.nav.sandbox');
    await scrollTo('sandbox.browser.toggle');
    await waitForFreshText('sandbox.browser.status', 'Using Chromium.');
    await shot('web-fetch-admin-browsing');
  });
});
