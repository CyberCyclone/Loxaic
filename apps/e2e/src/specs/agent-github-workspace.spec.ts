/**
 * An agent conversation started in a GitHub repository.
 *
 * The chooser, the clone, and the branch are all exercised for real: the
 * server looks the repo up on the harness's mock GitHub API, clones the
 * `clone_url` it reports — which points at the harness's own git server — and
 * checks out the branch the chooser generated. Nothing on the server side is
 * stubbed. What is asserted afterwards is read from the sandbox's filesystem
 * through the exec API, not inferred from the UI.
 *
 * Cloning needs network, which sandboxes do not have by default. This spec
 * turns it on through the admin API in `before` and turns it back off in
 * `after` — the same discipline every sandbox spec follows for mode.
 */
import { apiToken, provisionAdmin, provisionUser, uniqueCreds } from '../helpers/auth.ts';
import { VALID_TOKEN } from '../../scripts/mock-github.ts';
import { shot } from '../helpers/screenshot.ts';
import { tap, waitForTextIn, waitForVisible } from '../helpers/selectors.ts';
import {
  BASH_PROMPT,
  MOCK_BASH_OUTPUT,
  chooseGithubWorkspace,
  connectGithub,
  execInSandbox,
  goToSurface,
  listConversations,
  listSandboxes,
  patchSandboxSettings,
  resetSandboxSettings,
  sendMessage,
  signIn,
  startNewAgentRun,
  waitForRunDone,
  waitForToolResult,
} from '../helpers/app.ts';

const WORKDIR = '/home/loxaic/repo';

describe('agent workspace: GitHub repository', () => {
  const creds = uniqueCreds();

  before(async function () {
    this.timeout(60_000);
    await provisionAdmin();
    await resetSandboxSettings();
    await patchSandboxSettings({ allowNetwork: true });
    await provisionUser(creds);
    await connectGithub(creds, VALID_TOKEN);
    await signIn(creds);
  });

  after(async () => {
    await resetSandboxSettings();
  });

  it('offers the repo in the chooser and clones it onto a new branch', async function () {
    this.timeout(4 * 60_000);

    await goToSurface('agent');
    const branch = await chooseGithubWorkspace(1);
    await shot('github-workspace-chosen');

    await tap('agent.mode.manual');
    await sendMessage(BASH_PROMPT);
    await waitForVisible('agent.permission.bar');
    await tap('agent.permission.allow');
    // The first tool call is what creates the sandbox — and so the clone.
    await waitForToolResult(MOCK_BASH_OUTPUT);

    const [conversation] = await listConversations(creds);
    await waitForRunDone(creds, conversation.id);
    const token = await apiToken(creds);
    const [sandbox] = await listSandboxes(token, conversation.id);

    // The checkout is the fixture, on the branch the chooser named, cut from
    // main — read from disk, not from what any UI said.
    const head = await execInSandbox(token, sandbox.id, 'git rev-parse --abbrev-ref HEAD', WORKDIR);
    expect(head.stdout.trim()).toBe(branch);
    const file = await execInSandbox(token, sandbox.id, 'cat src/math.js', WORKDIR);
    expect(file.stdout).toContain('export function add');
    const log = await execInSandbox(token, sandbox.id, 'git log --oneline main', WORKDIR);
    expect(log.stdout).toContain('fixture: bugfix-app');

    // And the token is nowhere in the checkout — the invariant sandbox/git.ts
    // exists for, checked where it matters: inside the model's environment.
    const remote = await execInSandbox(token, sandbox.id, 'git config --get remote.origin.url', WORKDIR);
    expect(remote.stdout).not.toContain(VALID_TOKEN);
    const grep = await execInSandbox(token, sandbox.id, `grep -r ${VALID_TOKEN} .git || echo clean`, WORKDIR);
    expect(grep.stdout.trim()).toBe('clean');

    // The Inspector names it, and the pill is no longer a control.
    await tap('agent.inspector.toggle');
    await waitForTextIn('agent.inspector.workspace.kind', 'e2e/bugfix-app');
    await waitForTextIn('agent.inspector.workspace.kind', branch);
    await shot('github-workspace-inspector');
  });

  it('refuses GitHub in the chooser when sandboxes have no network, and says why', async () => {
    await patchSandboxSettings({ allowNetwork: false });
    // The agent screen reads /v1/config when it mounts, so leave and return
    // for the chooser to see the changed setting.
    await goToSurface('chat');
    await goToSurface('agent');
    await startNewAgentRun();

    await tap('agent.workspace.button');
    await waitForVisible('agent.workspace.dialog');
    // Present but refused, with the reason and the fix, rather than hidden —
    // the failure this prevents is a clone that dies on the first tool call
    // with a message about DNS.
    await waitForVisible('agent.workspace.source.github');
    await waitForTextIn('agent.workspace.dialog', 'network access');
    await waitForTextIn('agent.workspace.dialog', 'Agent Sandbox');
    await shot('github-workspace-refused-no-network');
  });
});
