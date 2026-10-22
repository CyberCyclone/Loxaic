/**
 * "Allow always" on the agent's permission bar (#266).
 *
 * The bar used to offer one answer, for one call. It now also offers the
 * standing one, and what it offers is decided by the run that is asking and by
 * who is looking — the run's own mode, which the selector switches since #311,
 * never the selector itself:
 *
 *   - a builtin: allowed for the rest of the run and for later runs;
 *   - an MCP tool in an auto run: the bar says why auto is asking until the run
 *     goes to Manual, "Allow once" stays one call, and "Allow always" ends the
 *     asking;
 *   - someone the conversation is shared with can answer the call, and is
 *     offered no standing grant on the owner's server;
 *   - the MCP tools sheet says where such an allow came from.
 *
 * The MCP tool is `get_me` on a server of the user's own, added over the API:
 * the harness's streamable-HTTP mock, under the slug `httpmock`. A new tool
 * asks until someone allows it.
 */
import { expect } from '@wdio/globals';
import { apiToken, provisionUser, uniqueCreds, type Credentials } from '../helpers/auth.ts';
import { BASE_URL, MOCK_MCP_HTTP_TOKEN, mockMcpHttpUrl } from '../../scripts/standup.ts';
import { shot } from '../helpers/screenshot.ts';
import { isVisible, tap, waitForAbsent, waitForTextIn, waitForVisible } from '../helpers/selectors.ts';
import {
  HTTP_MCP_LOGIN,
  HTTP_MCP_PROMPT,
  MOCK_TOOL_DONE,
  TOOL_PROMPT,
  getConversation,
  goToSurface,
  listConversations,
  openMcpServers,
  sendInNewRun,
  sendMessage,
  signIn,
  signOut,
  startNewAgentRun,
  waitForRunDone,
} from '../helpers/app.ts';

/** MOCK scenario: two `fs_write` calls in one run (fixtures/scenarios.json). */
const TWO_WRITES_PROMPT = 'Write two files, asking each time.';
const TWO_WRITES_DONE = '[Mock] Wrote both files.';

interface ToolPolicy {
  approval: 'ask' | 'allow';
  grantedFrom?: string;
}

describe('agent "Allow always"', () => {
  const creds = uniqueCreds();
  let serverId = '';

  async function api<T>(path: string, init?: { method: string; body: unknown }): Promise<T> {
    const res = await fetch(`${BASE_URL}${path}`, {
      method: init?.method ?? 'GET',
      headers: { authorization: `Bearer ${await apiToken(creds)}`, 'content-type': 'application/json' },
      ...(init ? { body: JSON.stringify(init.body) } : {}),
    });
    if (!res.ok) throw new Error(`[e2e] ${init?.method ?? 'GET'} ${path} failed (${String(res.status)})`);
    return (await res.json()) as T;
  }

  /** The stored policy for the mock's `get_me`: the row a run's toolset reads. */
  async function getMePolicy(): Promise<ToolPolicy | undefined> {
    const servers = await api<{ id: string; slug: string; toolPolicies: Record<string, ToolPolicy> }[]>('/v1/mcp/servers');
    const mine = servers.find((s) => s.slug === 'httpmock');
    if (!mine) throw new Error('[e2e] no httpmock MCP server');
    serverId = mine.id;
    return mine.toolPolicies.get_me;
  }

  async function allowlist(): Promise<string[]> {
    return (await api<{ toolAllowlist?: string[] }>('/v1/prefs')).toolAllowlist ?? [];
  }

  async function startRun(mode: 'manual' | 'auto', prompt: string): Promise<void> {
    await startNewAgentRun();
    await tap(`agent.mode.${mode}`);
    await sendMessage(prompt);
  }

  /**
   * Starts a run that must finish without asking, and checks that it did.
   *
   * From the server rather than the list: with no prompt nothing dismisses a
   * phone's keyboard, and XCUITest does not report the reply above it. A run
   * that did ask would still be parked when the wait gives up, ten minutes
   * short of its approval deadline, so this cannot pass on a refusal.
   */
  async function runsWithoutAsking(mode: 'manual' | 'auto', prompt: string, expected: string): Promise<void> {
    const before = new Set((await listConversations(creds)).map((c) => c.id));
    await startRun(mode, prompt);
    let id: string | undefined;
    await browser.waitUntil(
      async () => {
        id = (await listConversations(creds)).find((c) => !before.has(c.id))?.id;
        return id !== undefined;
      },
      { timeout: 30_000, timeoutMsg: '[e2e] the new run never appeared' },
    );
    if (!id) throw new Error('[e2e] no new run');
    await waitForRunDone(creds, id, 60_000);
    expect(await isVisible('agent.permission.bar')).toBe(false);
    expect(JSON.stringify(await api(`/v1/conversations/${id}/messages`))).toContain(expected);
  }

  before(async () => {
    await provisionUser(creds);
    await signIn(creds);
    const created = await api<{ id: string }>('/v1/mcp/servers', {
      method: 'POST',
      body: {
        name: 'HTTP mock',
        slug: 'httpmock',
        transport: 'http',
        url: mockMcpHttpUrl(),
        // The mock listens on loopback, which the SSRF guard refuses unless
        // the owner says so, as the form's checkbox does.
        allowPrivateNetwork: true,
        secrets: { Authorization: `Bearer ${MOCK_MCP_HTTP_TOKEN}` },
      },
    });
    serverId = created.id;
    // Discovers its tools, which start asking.
    await api(`/v1/mcp/servers/${serverId}/test`, { method: 'POST', body: {} });
    expect(await getMePolicy()).toMatchObject({ approval: 'ask' });
  });

  it('allows a builtin for the rest of the run, and for the next one', async function () {
    this.timeout(4 * 60_000);
    await goToSurface('agent');
    await tap('agent.mode.manual');
    await sendMessage(TWO_WRITES_PROMPT);

    await waitForVisible('agent.permission.bar');
    await waitForVisible('agent.permission.allowAlways');
    // Nothing to explain about a builtin in a manual run.
    expect(await isVisible('agent.permission.alwaysNote')).toBe(false);
    await shot('agent-allow-always-offered');
    await tap('agent.permission.allowAlways');

    // The run's second write is the same tool. Had the grant only been saved
    // for later, the run would be parked on the bar again and never get here.
    await waitForTextIn('chat.messageList', TWO_WRITES_DONE);
    await waitForAbsent('agent.permission.bar');
    await shot('agent-allow-always-same-run');
    expect(await allowlist()).toContain('fs_write');

    await runsWithoutAsking('manual', TOOL_PROMPT, MOCK_TOOL_DONE);
    await shot('agent-allow-always-next-run');
  });

  it('says why an auto run is asking, drops it once the run goes to Manual, and keeps "Allow once" to one call', async function () {
    this.timeout(4 * 60_000);
    await startNewAgentRun();
    await tap('agent.mode.auto');
    const conversationId = await sendInNewRun(creds, HTTP_MCP_PROMPT);
    await waitForVisible('agent.permission.bar');
    await waitForTextIn('agent.permission.alwaysNote', 'get_me from httpmock');
    await shot('agent-auto-mcp-prompt');

    // Since #311 the selector switches the run that is going. A Manual run
    // asks before every call, so there is no reason left to give: the note
    // goes, the call is still asked, and the owner still has "Allow always".
    await tap('agent.mode.manual');
    await browser.waitUntil(async () => (await getConversation(creds, conversationId)).permissionMode === 'manual', {
      timeout: 10_000,
      timeoutMsg: '[e2e] the run never went to Manual',
    });
    await waitForAbsent('agent.permission.alwaysNote');
    await waitForVisible('agent.permission.bar');
    await waitForVisible('agent.permission.allowAlways');
    // The run switched: no line saying it stayed in Auto.
    expect(await isVisible('agent.permission.mode')).toBe(false);
    await shot('agent-mcp-prompt-switched-to-manual');

    await tap('agent.permission.allow');
    await waitForTextIn('chat.messageList', HTTP_MCP_LOGIN);
    expect((await getMePolicy())?.approval).toBe('ask');
  });

  it('offers someone the thread is shared with the call, and no standing grant', async function () {
    this.timeout(5 * 60_000);
    // "Allow once" granted nothing, so this auto run asks again.
    await startRun('auto', HTTP_MCP_PROMPT);
    await waitForVisible('agent.permission.bar');
    const [conv] = await listConversations(creds);

    const guest: Credentials = await provisionUser(uniqueCreds());
    const signInRes = await fetch(`${BASE_URL}/api/auth/sign-in`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: guest.email, password: guest.password }),
    });
    const guestId = ((await signInRes.json()) as { user: { id: string } }).user.id;
    await api(`/v1/conversations/${conv.id}/shares`, { method: 'PUT', body: { user_id: guestId, role: 'editor' } });

    await signOut();
    await signIn(guest);
    // The shared thread is the guest's only one, so the agent screen opens on
    // it — a fresh session, whose bar is built from the run's snapshot.
    await goToSurface('agent');
    await waitForVisible('agent.permission.bar');
    await waitForVisible('agent.permission.allow');
    expect(await isVisible('agent.permission.allowAlways')).toBe(false);
    expect(await isVisible('agent.permission.alwaysNote')).toBe(false);
    await shot('agent-auto-mcp-prompt-shared-editor');
    await signOut();
  });

  it('still says so after the app is opened again, and "Allow always" ends the asking', async function () {
    this.timeout(5 * 60_000);
    // A fresh session: the bar is built from the run's snapshot, and must
    // still describe the auto run.
    await signIn(creds);
    // The parked run is the owner's newest thread, so the screen opens on it.
    await goToSurface('agent');
    await waitForVisible('agent.permission.bar');
    await waitForTextIn('agent.permission.alwaysNote', 'get_me from httpmock');
    await shot('agent-auto-mcp-prompt-after-reopen');
    await tap('agent.permission.allowAlways');
    await waitForTextIn('chat.messageList', HTTP_MCP_LOGIN);
    expect(await getMePolicy()).toMatchObject({ approval: 'allow', grantedFrom: 'prompt' });

    await runsWithoutAsking('auto', HTTP_MCP_PROMPT, HTTP_MCP_LOGIN);
    await shot('agent-auto-mcp-no-prompt');
  });

  it('says in the MCP tools sheet where that allow came from', async () => {
    await openMcpServers();
    await tap(`mcp.serverTools.${serverId}`);
    await waitForTextIn('mcp.toolTrustNote.get_me', 'Allow always');
    await shot('mcp-tools-sheet-allowed-from-prompt');
  });
});
