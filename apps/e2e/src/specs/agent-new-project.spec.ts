/**
 * A scratch workspace built from nothing: three real files written by the
 * agent (a package.json, a source file, a test for it) and a real test run
 * that passes — no repo, no clone, just an empty sandbox and the tool loop.
 *
 * Everything is checked off the sandbox's filesystem and exit code, not off
 * the mock's own account of what it did; the Inspector's "Changed Files"
 * count is the one UI assertion, and it is checked against the same three
 * writes the exec-API checks already proved landed on disk.
 */
import { apiToken, uniqueCreds } from '../helpers/auth.ts';
import { shot } from '../helpers/screenshot.ts';
import { tap, waitForTextIn, waitForVisible } from '../helpers/selectors.ts';
import {
  NEW_PROJECT_SCENARIO_DONE,
  NEW_PROJECT_SCENARIO_PROMPT,
  chooseScratchWorkspace,
  execInSandbox,
  goToSurface,
  listConversations,
  listSandboxes,
  openInspector,
  sendMessage,
  signUp,
  waitForRunDone,
} from '../helpers/app.ts';

const WORKDIR = '/home/loxaic/repo';

describe('a new project, built from an empty scratch workspace', () => {
  const creds = uniqueCreds();

  before(async () => {
    await signUp(creds);
  });

  it('writes three files and passes its own tests, all confirmed off the sandbox', async function () {
    this.timeout(4 * 60_000);

    await goToSurface('agent');
    await chooseScratchWorkspace();

    await tap('agent.mode.auto');
    await sendMessage(NEW_PROJECT_SCENARIO_PROMPT);
    await waitForTextIn('chat.messageList', NEW_PROJECT_SCENARIO_DONE, 4 * 60_000);
    await shot('new-project-chat');

    const [conversation] = await listConversations(creds);
    await waitForRunDone(creds, conversation.id);
    const token = await apiToken(creds);
    const [sandbox] = await listSandboxes(token, conversation.id);

    // The three files, read off disk — each write really happened, not just
    // the tool call that claimed it.
    const pkg = await execInSandbox(token, sandbox.id, 'cat package.json', WORKDIR);
    expect(pkg.stdout).toContain('"test": "node --test"');
    const math = await execInSandbox(token, sandbox.id, 'cat src/math.js', WORKDIR);
    expect(math.stdout).toContain('export function add');
    const test = await execInSandbox(token, sandbox.id, 'cat test/math.test.js', WORKDIR);
    expect(test.stdout).toContain("add(2, 3), 5");

    // And an independent run of the exact command the scenario's own last
    // step already ran — the test the project ships with genuinely passes.
    const rerun = await execInSandbox(token, sandbox.id, 'node --test', WORKDIR);
    expect(rerun.exitCode).toBe(0);

    await openInspector();
    await waitForVisible('agent.inspector.changedFiles.count');
    await waitForTextIn('agent.inspector.changedFiles.count', 'Changed Files (3)');
    await shot('new-project-inspector');
  });
});
