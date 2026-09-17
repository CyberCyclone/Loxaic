/**
 * Connecting GitHub also sets up GitHub's MCP tools, with no second step and
 * no second copy of the token — and disconnecting takes them away again.
 *
 * Runs against the harness's mock GitHub API and its stand-in for GitHub's
 * hosted MCP server (apps/server/src/mcp/__tests__/mock-mcp-http.ts, reached
 * through GITHUB_MCP_URL). That stand-in refuses every bearer except
 * `VALID_TOKEN`, so a tool call that answers proves the connection's token
 * travelled to it; `/__e2e/auth` is checked as well, so the proof does not rest
 * on the reply alone.
 */
import { provisionUser, uniqueCreds, type Credentials } from '../helpers/auth.ts';
import { VALID_TOKEN } from '../../scripts/mock-github.ts';
import { mockGithubMcpUrl } from '../../scripts/standup.ts';
import { shot } from '../helpers/screenshot.ts';
import { isVisible, tap, waitForGone, waitForTextIn, waitForVisible } from '../helpers/selectors.ts';
import {
  connectGithub,
  GITHUB_MCP_LOGIN,
  GITHUB_MCP_PROMPT,
  goToSurface,
  listMcpServers,
  openGithubSettings,
  openMcpServers,
  sendMessage,
  signIn,
  waitForToolResult,
} from '../helpers/app.ts';

async function githubServerId(creds: Credentials): Promise<string | undefined> {
  const servers = await listMcpServers(creds);
  return servers.find((s) => s.builtinKey === 'github')?.id;
}

describe('GitHub tools follow the GitHub connection', () => {
  const creds = uniqueCreds();
  let serverId: string;

  before(async () => {
    await provisionUser(creds);
    await signIn(creds);
    await connectGithub(creds, VALID_TOKEN);
    const id = await githubServerId(creds);
    if (!id) throw new Error('connecting GitHub did not set up a GitHub MCP server');
    serverId = id;
  });

  it('says on the GitHub screen that the tools are on', async () => {
    await openGithubSettings();
    await waitForTextIn('github.mcp.status', 'GitHub tools are on');
    await waitForVisible('github.mcp.manage');
    await shot('github-mcp-status');
  });

  it('lists the server on the MCP screen, without a delete control or a second catalogue card', async () => {
    await openMcpServers();
    await waitForVisible(`mcp.serverRow.${serverId}`);
    await waitForTextIn(`mcp.serverRow.${serverId}`, 'Uses your GitHub connection');
    // Deleting it would only have it come back on the next reconnect: it is
    // removed by disconnecting GitHub, so the control is not offered.
    if (await isVisible(`mcp.serverDelete.${serverId}`)) {
      throw new Error('a GitHub server that follows the connection offered a delete control');
    }
    if (await isVisible('mcp.catalogRow.github')) {
      throw new Error('the GitHub catalogue card was still offered after the server was set up');
    }
    await shot('github-mcp-provisioned');
  });

  it('answers a chat with the connection token, without asking for approval', async () => {
    await goToSurface('chat');
    await sendMessage(GITHUB_MCP_PROMPT);
    // Chat runs manual-mode approval: an MCP tool that still asked would stop
    // here at a prompt, and the result would never arrive.
    await waitForToolResult(GITHUB_MCP_LOGIN);

    const auth = (await fetch(new URL('/__e2e/auth', mockGithubMcpUrl())).then((r) => r.json())) as {
      lastAuthorization: string | null;
    };
    if (auth.lastAuthorization !== `Bearer ${VALID_TOKEN}`) {
      throw new Error(`the GitHub MCP server was not called with the connection's token (saw ${String(auth.lastAuthorization)})`);
    }
    await shot('github-mcp-tool-call');
  });

  it('removes the tools when GitHub is disconnected', async () => {
    await openGithubSettings();
    await tap('github.disconnect');
    await waitForVisible('github.token');

    await openMcpServers();
    await waitForGone(`mcp.serverRow.${serverId}`, 20_000);
    await waitForVisible('mcp.catalogRow.github');
    await waitForVisible('mcp.catalogConnectGithub');
    if ((await githubServerId(creds)) !== undefined) {
      throw new Error('disconnecting GitHub left its MCP server behind');
    }
    await shot('github-mcp-removed');
  });
});
