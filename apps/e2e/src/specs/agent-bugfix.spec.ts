/**
 * A realistic coding task, end to end: clone a repo whose tests genuinely
 * fail, let the agent (auto mode, no approvals) find and fix the real bug,
 * confirm the fix independently, then commit/push/open a PR from the
 * Inspector — exactly the operator flow the other GitHub-workspace specs
 * exercise, but now driven by a multi-step mock scenario instead of a single
 * trigger, so the "loop" part of the tool loop is actually exercised.
 *
 * Every claim is checked off the server, never off the transcript: the fixed
 * file's bytes, the test's real exit code, the pushed commit in the harness's
 * own bare repository, and the PR in the mock GitHub API's own record of the
 * call it received.
 */
import { execFileSync } from 'node:child_process';
import { apiToken, provisionAdmin, provisionUser, uniqueCreds } from '../helpers/auth.ts';
import { GIT_SERVER_DIR, mockGithubUrl } from '../../scripts/standup.ts';
import { VALID_TOKEN } from '../../scripts/mock-github.ts';
import { shot } from '../helpers/screenshot.ts';
import { tap, typeInto, waitForTextIn, waitForVisible } from '../helpers/selectors.ts';
import {
  BUGFIX_SCENARIO_DONE,
  BUGFIX_SCENARIO_PROMPT,
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
  waitForRunDone,
} from '../helpers/app.ts';

const WORKDIR = '/home/loxaic/repo';

interface RecordedPull {
  number: number;
  owner: string;
  repo: string;
  head: string;
  base: string;
  title: string;
}

describe('a realistic bugfix task, from clone to pull request', () => {
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

  it('fixes the real bug, verifies it, and opens a PR — all confirmed off the server', async function () {
    this.timeout(5 * 60_000);

    await goToSurface('agent');
    const branch = await chooseGithubWorkspace(1);

    // Auto mode: none of the scenario's three tool calls (two bash, one
    // fs_edit) waits on an approval tap — the whole point of exercising a
    // multi-step scenario is seeing the loop actually iterate unattended.
    await tap('agent.mode.auto');
    await sendMessage(BUGFIX_SCENARIO_PROMPT);
    await waitForTextIn('chat.messageList', BUGFIX_SCENARIO_DONE, 4 * 60_000);
    await shot('bugfix-scenario-chat');

    const [conversation] = await listConversations(creds);
    await waitForRunDone(creds, conversation.id);
    const token = await apiToken(creds);
    const [sandbox] = await listSandboxes(token, conversation.id);

    // The fix is real, read off disk — not inferred from the mock's own
    // account of what it did.
    const file = await execInSandbox(token, sandbox.id, 'cat src/math.js', WORKDIR);
    expect(file.stdout).toContain('return a + b;');
    expect(file.stdout).not.toContain('return a + b + 1;');

    // And the tests genuinely pass now — a second, independent run of the
    // exact command the scenario's own last step already ran.
    const rerun = await execInSandbox(token, sandbox.id, 'node --test', WORKDIR);
    expect(rerun.exitCode).toBe(0);

    await tap('agent.inspector.toggle');
    await waitForVisible('agent.inspector.git.branch');
    await waitForTextIn('agent.inspector.git.branch', branch);
    await waitForTextIn('agent.inspector.git.changed', '1 file');
    await shot('bugfix-scenario-dirty');

    await typeInto('agent.inspector.git.commitMessage', 'fix off-by-one in add()');
    await tap('agent.inspector.git.commit');
    await waitForTextIn('agent.inspector.git.changed', 'No changes');
    await waitForTextIn('agent.inspector.git.aheadBehind', '1 ahead');

    await tap('agent.inspector.git.push');

    // Confirmed against the harness's own bare repository, the same
    // discipline agent-git-actions.spec.ts uses — polled because the push is
    // a real network round trip the UI gives no distinct completion signal for.
    const gitDir = `${GIT_SERVER_DIR}/bugfix-app.git`;
    const deadline = Date.now() + 30_000;
    let log = '';
    for (;;) {
      log = execFileSync('git', ['--git-dir', gitDir, 'branch', '--list', branch]).toString();
      if (log.trim() !== '') break;
      if (Date.now() > deadline) throw new Error(`[e2e] branch ${branch} never appeared on the origin`);
      await new Promise((r) => setTimeout(r, 500));
    }
    log = execFileSync('git', ['--git-dir', gitDir, 'log', '--oneline', branch]).toString();
    expect(log).toContain('fix off-by-one in add()');
    await shot('bugfix-scenario-pushed');

    await typeInto('agent.inspector.git.prTitle', 'Fix off-by-one in add()');
    await tap('agent.inspector.git.openPr');
    await waitForVisible('agent.inspector.git.prLink');
    await waitForTextIn('agent.inspector.git.prLink', 'Pull request #');
    await shot('bugfix-scenario-pr-opened');

    // Found by branch, not by being the only entry: the mock's pull list is
    // shared server-wide, and another spec exercising the same PR flow
    // concurrently (agent-git-actions.spec.ts does) legitimately adds its own
    // entry to the same list.
    const res = await fetch(`${mockGithubUrl()}/__e2e/pulls`);
    const recorded = (await res.json()) as RecordedPull[];
    const mine = recorded.find((p) => p.head === branch);
    expect(mine).toMatchObject({
      owner: 'e2e',
      repo: 'bugfix-app',
      head: branch,
      base: 'main',
      title: 'Fix off-by-one in add()',
    });
  });
});
