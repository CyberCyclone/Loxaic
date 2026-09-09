/**
 * The real thing, on the bugfix fixture: a live inference endpoint clones
 * apps/e2e/fixtures/bugfix-app (the same fixture and git server the mock
 * lane's agent-bugfix.spec.ts drives with a scripted scenario), reads a plain
 * natural-language instruction — no scenario file, no scripted tool-call
 * sequence — finds the real off-by-one in `add()`, fixes it, confirms
 * `node --test` actually passes, and commits. Guarded by
 * wdio.web.real-model.ts on E2E_REAL_MODEL=1; never runs in CI. See the README.
 *
 * Every check happens *after* the run has fully finished (`waitForRunDone`),
 * not the moment tests start passing on disk. Polling `node --test` directly
 * and declaring victory the instant it exits 0 was tried first and is a real
 * race: the model's own last two steps are "see tests pass" then "commit",
 * and an external poller sharing the same sandbox can observe the passing
 * tests after the model's own test run but before its commit — so the
 * checks below waited for the wrong event and could catch the model
 * mid-turn, one step short of what it was asked to do.
 *
 * The pass/fail bar is the test run's own exit code and `git rev-list
 * --count`, not whether the Inspector's Git panel or the model's own words
 * say so.
 */
import { apiToken, uniqueCreds } from '../../helpers/auth.ts';
import { shot } from '../../helpers/screenshot.ts';
import { tap } from '../../helpers/selectors.ts';
import {
  chooseGithubWorkspace,
  connectGithub,
  execInSandbox,
  goToSurface,
  listConversations,
  listSandboxes,
  sendMessage,
  signUp,
  waitForRunDone,
} from '../../helpers/app.ts';
import { VALID_TOKEN } from '../../../scripts/mock-github.ts';

const PROMPT =
  'The tests in this repository are failing. Find the bug, fix it, and confirm the tests pass by ' +
  'running `node --test` again. Once they pass, commit your fix by running ' +
  '`git add -A && git commit -m "fix off-by-one"`.';
const WORKDIR = '/home/loxaic/repo';
const RUN_TIMEOUT_MS = 25 * 60_000;

describe('real-model task: fix the bugfix-app', () => {
  it('finds the real bug, fixes it, gets the real tests passing, and commits', async function () {
    this.timeout(30 * 60_000);

    const creds = uniqueCreds();
    await signUp(creds);
    await connectGithub(creds, VALID_TOKEN);
    await goToSurface('agent');
    await chooseGithubWorkspace(1);

    await tap('agent.mode.auto');
    await sendMessage(PROMPT);
    await shot('real-model-bugfix-started');

    const [conversation] = await listConversations(creds);
    await waitForRunDone(creds, conversation.id, RUN_TIMEOUT_MS);

    const token = await apiToken(creds);
    const sandboxes = await listSandboxes(token);
    if (sandboxes.length === 0) throw new Error('the run finished with no sandbox — did it ever call a tool?');
    const sandboxId = sandboxes[0].id;

    const tests = await execInSandbox(token, sandboxId, 'node --test', WORKDIR);
    if (tests.exitCode !== 0) {
      throw new Error(`node --test exited ${String(tests.exitCode)}\n--- stdout ---\n${tests.stdout}\n--- stderr ---\n${tests.stderr}`);
    }

    // Real bytes, not the model's word for it.
    const file = await execInSandbox(token, sandboxId, 'cat src/math.js', WORKDIR);
    expect(file.stdout).not.toContain('return a + b + 1;');

    const commits = await execInSandbox(token, sandboxId, 'git rev-list --count HEAD ^main', WORKDIR);
    expect(Number(commits.stdout.trim())).toBeGreaterThanOrEqual(1);

    await shot('real-model-bugfix-passed').catch(() => undefined);
  });
});
