/**
 * `git` and `gh` in a GitHub workspace, through Loxaic's egress proxy
 * (apps/server/src/egress): the agent pushes its branch and opens and reads
 * its pull request with the ordinary tools, while the token stays on the
 * server, and the proxy refuses what the workspace may not do — a push to
 * main, deleting its branch — with a sentence the model reads.
 *
 * Nothing about GitHub is stubbed on the server: the harness's git server
 * (scripts/git-server.ts) refuses anything without the token, so a clone or
 * push that works proves the proxy added it, and every check below is made
 * against the bare repository and the mock API's own records, not the UI.
 * Each prompt is a scenario (fixtures/scenarios.json) running one exact
 * command; manual mode, so everything that is not read-only asks first.
 */
import { execFileSync } from 'node:child_process';
import { apiToken, provisionAdmin, provisionUser, uniqueCreds } from '../helpers/auth.ts';
import { GIT_SERVER_DIR, mockGithubUrl } from '../../scripts/standup.ts';
import { VALID_TOKEN } from '../../scripts/mock-github.ts';
import { shot } from '../helpers/screenshot.ts';
import { browser } from '@wdio/globals';
import { byTestId, closeKeyboard, isVisible, platform, tap, waitForFreshText, waitForVisible } from '../helpers/selectors.ts';
import {
  chooseGithubWorkspace,
  connectGithub,
  execInSandbox,
  getToolResults,
  goToSurface,
  listSandboxes,
  patchSandboxSettings,
  resetSandboxSettings,
  sendInNewRun,
  sendMessage,
  signIn,
  startNewAgentRun,
  waitForRunDone,
} from '../helpers/app.ts';

const GIT_DIR = `${GIT_SERVER_DIR}/e2e/gh-app.git`;

interface RecordedPull {
  number: number;
  owner: string;
  repo: string;
  head: string;
  base: string;
  title: string;
}

/** A ref of the harness's bare repository, or null when it does not exist. */
function originRef(ref: string): string | null {
  try {
    return execFileSync('git', ['--git-dir', GIT_DIR, 'rev-parse', '--verify', '--quiet', ref]).toString().trim();
  } catch {
    return null;
  }
}

describe('agent: git and gh through the egress proxy', () => {
  const creds = uniqueCreds();
  let conversationId = '';
  let branch = '';

  before(async function () {
    this.timeout(60_000);
    await provisionAdmin();
    await resetSandboxSettings();
    await patchSandboxSettings({ allowNetwork: true });
    await provisionUser(creds);
    await connectGithub(creds, VALID_TOKEN);
    await signIn(creds);
    await goToSurface('agent');
  });

  after(async () => {
    await resetSandboxSettings();
  });

  /** Sends one drill prompt, answers its approval if it asks, and returns the
   * tool result it left. */
  async function drill(prompt: string, answer: 'allow' | 'none') {
    const before = (await getToolResults(creds, conversationId)).length;
    await sendMessage(prompt);
    if (answer === 'allow') {
      await waitForVisible('agent.permission.bar');
      await tap('agent.permission.allow');
    }
    await waitForRunDone(creds, conversationId);
    const results = await getToolResults(creds, conversationId);
    expect(results.length).toBe(before + 1);
    const result = results.at(-1);
    if (!result) throw new Error('no tool result');
    return result;
  }

  it('pushes its branch and opens its pull request, asking first, with the token never in the sandbox', async function () {
    this.timeout(6 * 60_000);
    await startNewAgentRun();
    branch = await chooseGithubWorkspace(6, 'gh-app');
    await tap('agent.mode.manual');
    const mainBefore = originRef('refs/heads/main');

    // The first command clones (through the proxy), then asks to push.
    conversationId = await sendInNewRun(creds, 'egress drill: push the branch');
    await waitForVisible('agent.permission.bar');
    await shot('gh-proxy-push-asks');
    await tap('agent.permission.allow');
    await waitForRunDone(creds, conversationId);
    const [pushed] = await getToolResults(creds, conversationId);
    expect(pushed).toMatchObject({ ok: true });
    expect(originRef(`refs/heads/${branch}`)).toBeTruthy();
    expect(originRef('refs/heads/main')).toBe(mainBefore);

    const opened = await drill('egress drill: open the pull request', 'allow');
    expect(opened.ok).toBe(true);
    expect(opened.output).toContain('/e2e/gh-app/pull/1');
    const recorded = (await (await fetch(`${mockGithubUrl()}/__e2e/pulls`)).json()) as RecordedPull[];
    expect(recorded.find((p) => p.repo === 'gh-app')).toMatchObject({
      number: 1, owner: 'e2e', head: branch, base: 'main', title: 'Opened by the agent',
    });

    // Reading needs no approval: `gh pr view` is read-only.
    const viewed = await drill('egress drill: view the pull request', 'none');
    expect(viewed).toMatchObject({ ok: true, permission: { by: 'readonly' } });
    expect(viewed.output).toContain('Opened by the agent');
    expect(await isVisible('agent.permission.bar')).toBe(false);
    // On a phone the keyboard is still up from the send, over the card. On an
    // iPhone a tap on the thread puts it away (as sendInNewRun does); the
    // drag closeKeyboard uses does not, on this screen.
    if (platform() === 'ios' && (await browser.isKeyboardShown().catch(() => false))) {
      await byTestId('chat.messageList').click().catch(() => undefined);
    }
    await closeKeyboard();
    await waitForFreshText(`chat.toolCall.permission.${viewed.call_id}`, 'Read-only command');
    await shot('gh-proxy-pr-view-unasked');

    // Whatever the sandbox's environment and files hold, the token is not in
    // them: what it has is a proxy address with a credential of Loxaic's own.
    const token = await apiToken(creds);
    const [sandbox] = await listSandboxes(token, conversationId);
    const seen = await execInSandbox(
      token,
      sandbox.id,
      'env; cat .git/config ~/.gitconfig ~/.git-credentials ~/.config/gh/hosts.yml 2>/dev/null; true',
    );
    expect(seen.stdout).toContain('HTTPS_PROXY=http://sbx:');
    expect(seen.stdout).toContain('url = https://github.com/e2e/gh-app.git');
    expect(`${seen.stdout}${seen.stderr}`).not.toContain(VALID_TOKEN);
  });

  it('refuses a push to main and deleting its branch, even once approved, and says why', async function () {
    this.timeout(4 * 60_000);
    const mainBefore = originRef('refs/heads/main');
    const branchBefore = originRef(`refs/heads/${branch}`);

    // After a commit: a push of what main already has would be "Everything
    // up-to-date" and never reach the proxy's check at all.
    const toMain = await drill('egress drill: push to main', 'allow');
    expect(toMain.ok).toBe(false);
    expect(toMain.output).toContain(`Loxaic lets this workspace push only to refs/heads/${branch}`);
    expect(originRef('refs/heads/main')).toBe(mainBefore);
    await shot('gh-proxy-push-to-main-refused');

    const deleted = await drill('egress drill: delete the branch', 'allow');
    expect(deleted.ok).toBe(false);
    expect(deleted.output).toContain('does not let this workspace delete');
    expect(originRef(`refs/heads/${branch}`)).toBe(branchBefore);
  });
});
