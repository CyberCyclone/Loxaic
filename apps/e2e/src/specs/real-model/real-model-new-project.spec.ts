/**
 * The real thing, from nothing: a live inference endpoint builds a small
 * Node.js project from a plain natural-language instruction in an empty
 * scratch workspace — no scenario file, no scripted tool-call sequence, no
 * fixture to read from. The prompt pins the test command so the pass/fail bar
 * can be resolved deterministically; everything else (file names, the
 * function, the test content) is the model's own decision. Guarded by
 * wdio.web.real-model.ts on E2E_REAL_MODEL=1; never runs in CI. See the README.
 *
 * Checked once, after `waitForRunDone` — not by polling `npm test` and
 * declaring victory the moment it exits 0. See real-model-bugfix.spec.ts's
 * doc comment: an external poller sharing the sandbox can observe a passing
 * test run before the model reaches whatever it does next in the same turn,
 * which is racing the model rather than testing it.
 *
 * The pass/fail bar is `npm test`'s own exit code, resolved through the same
 * sandbox exec API a client would use — not the model's account of what it
 * wrote.
 */
import { apiToken, uniqueCreds } from '../../helpers/auth.ts';
import { shot } from '../../helpers/screenshot.ts';
import { tap } from '../../helpers/selectors.ts';
import {
  chooseScratchWorkspace,
  execInSandbox,
  goToSurface,
  listConversations,
  listSandboxes,
  sendMessage,
  signUp,
  waitForRunDone,
} from '../../helpers/app.ts';

const PROMPT =
  'Create a new Node.js project in this directory: a package.json whose "test" script runs `node --test`, ' +
  'one small source file that exports a function, and a test file for it using node\'s built-in test runner. ' +
  'Then run `npm test` and make sure it passes.';
const WORKDIR = '/home/loxaic/repo';
const RUN_TIMEOUT_MS = 25 * 60_000;

describe('real-model task: build a new project from nothing', () => {
  it('writes its own project and gets its own tests passing', async function () {
    this.timeout(30 * 60_000);

    const creds = uniqueCreds();
    await signUp(creds);
    await goToSurface('agent');
    await chooseScratchWorkspace();

    await tap('agent.mode.auto');
    await sendMessage(PROMPT);
    await shot('real-model-new-project-started');

    const [conversation] = await listConversations(creds);
    await waitForRunDone(creds, conversation.id, RUN_TIMEOUT_MS);

    const token = await apiToken(creds);
    const sandboxes = await listSandboxes(token);
    if (sandboxes.length === 0) throw new Error('the run finished with no sandbox — did it ever call a tool?');
    const sandboxId = sandboxes[0].id;

    const tests = await execInSandbox(token, sandboxId, 'npm test', WORKDIR);
    if (tests.exitCode !== 0) {
      throw new Error(`npm test exited ${String(tests.exitCode)}\n--- stdout ---\n${tests.stdout}\n--- stderr ---\n${tests.stderr}`);
    }

    await shot('real-model-new-project-passed').catch(() => undefined);
  });
});
