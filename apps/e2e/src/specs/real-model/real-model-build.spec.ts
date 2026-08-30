/**
 * The real thing: a live inference endpoint reads INSTRUCTIONS.md in the
 * seeded fixture (apps/e2e/fixtures/seeded-app), installs dependencies over
 * the network the sandbox was given for this run, fixes the intentionally
 * broken src/App.tsx, and gets `npm run build` to pass — with no scripted
 * tool-call sequence standing in for it. Guarded by wdio.web.real-model.ts on
 * E2E_REAL_MODEL=1; never runs in CI. See the README.
 *
 * The pass/fail bar is the build's own exit code, resolved through the same
 * sandbox exec API a client would use — not the model's account of what it
 * did, and not scraping its (non-deterministic) wording for a specific
 * phrase the way the mock-driven specs can.
 *
 * Completion is polled through the server API with plain `fetch`, not by
 * holding the webdriver session in a `browser.waitUntil` DOM-poll loop —
 * a real run's actual work reliably finishes in well under a minute (see the
 * PR this shipped in), but a headless browser tab left idle in the
 * background for the rest of a long timeout window is a real, observed
 * failure mode of its own: the session can go unresponsive to further
 * WebDriver queries even though the app underneath has long since finished
 * correctly. Polling the API sidesteps that class of flake entirely — the
 * browser is only touched to kick the run off and to grab evidence after.
 */
import { apiToken, uniqueCreds } from '../../helpers/auth.ts';
import { shot } from '../../helpers/screenshot.ts';
import { tap } from '../../helpers/selectors.ts';
import { goToSurface, sendMessage, signUp } from '../../helpers/app.ts';
import { BASE_URL } from '../../../scripts/standup.ts';

const PROMPT = 'Read INSTRUCTIONS.md in your working directory and complete the task described there.';
/** Real ceiling for a slow/local model — both LM Studio verification runs
 * this suite shipped with actually finished in well under a minute. */
const RUN_TIMEOUT_MS = 25 * 60_000;
const POLL_INTERVAL_MS = 10_000;

interface SandboxRow { id: string; createdAt: string; provider: string; containerId: string }

/**
 * Where the seeded fixture lives inside a given sandbox.
 *
 * Not hardcoded, because the two providers differ and their exec defaults
 * differ too: a container's workdir is `/home/shannon/repo` while its exec
 * defaults to the parent, and a host sandbox's workdir is `<dir>/repo` while
 * its exec defaults to that same repo dir. Hardcoding the container path made
 * every poll fail with `cd: no such file or directory` under host mode — and
 * report it as a failing build. For host sandboxes `containerId` *is* the
 * sandbox directory, so the path is derivable from the row either way.
 */
function workdirFor(row: SandboxRow): string {
  return row.provider === 'host' ? `${row.containerId}/repo` : '/home/shannon/repo';
}

/** This account is fresh (uniqueCreds()), so its first sandbox is the run's. */
async function waitForSandbox(token: string, deadline: number): Promise<SandboxRow> {
  for (;;) {
    const res = await fetch(`${BASE_URL}/v1/sandboxes`, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`GET /v1/sandboxes failed (${String(res.status)}): ${await res.text()}`);
    const sandboxes = (await res.json()) as SandboxRow[];
    if (sandboxes.length > 0) return sandboxes[0];
    if (Date.now() > deadline) {
      throw new Error('agent run created no sandbox before the deadline — did it ever call a tool?');
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

interface ExecResult { exitCode: number; stdout: string; stderr: string }

/** Retries the build until it passes or the deadline hits — a real model may
 * still be mid-edit the first few times this is tried. */
async function waitForBuild(token: string, sandbox: SandboxRow, deadline: number): Promise<ExecResult> {
  let last: ExecResult = { exitCode: -1, stdout: '', stderr: 'never attempted' };
  for (;;) {
    const res = await fetch(`${BASE_URL}/v1/sandboxes/${sandbox.id}/exec`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ command: 'npm run build', workdir: workdirFor(sandbox) }),
    });
    // The route answers a failed exec with a non-2xx and `{ error }` — no
    // exitCode. Parsing that as an ExecResult made every poll compare
    // `undefined === 0`, so a dead sandbox or a transient socket error spun
    // for the full 25 minutes and then reported `exited undefined` with the
    // real error discarded. Fail fast and keep the message.
    if (!res.ok) {
      throw new Error(`exec failed (${String(res.status)}): ${await res.text()}`);
    }
    last = (await res.json()) as ExecResult;
    if (last.exitCode === 0) return last;
    if (Date.now() > deadline) return last;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

describe('real-model task: build the seeded app', () => {
  it('reads INSTRUCTIONS.md, fixes the app, and gets it building', async function () {
    // Belt-and-braces alongside wdio.web.real-model.ts's mochaOpts.timeout —
    // mocha ignores a per-test timeout larger than the suite's, but a smaller
    // one here would silently override it, so keep this one no tighter.
    this.timeout(30 * 60_000);

    const creds = uniqueCreds();
    await signUp(creds);
    await goToSurface('agent');
    // Auto mode: builtin write tools (bash, fs_write, fs_edit) run without a
    // per-call approval prompt — required for an autonomous multi-step task
    // to finish unattended. See toolRequiresApproval() in packages/agent.
    await tap('agent.mode.auto');
    await sendMessage(PROMPT);
    await shot('real-model-run-started');

    const token = await apiToken(creds);
    const deadline = Date.now() + RUN_TIMEOUT_MS;
    const sandbox = await waitForSandbox(token, deadline);
    const build = await waitForBuild(token, sandbox, deadline);

    if (build.exitCode !== 0) {
      // The fallback the plan calls for: even without a clean build, show
      // what's actually in the workdir rather than just failing blind.
      const treeRes = await fetch(`${BASE_URL}/v1/sandboxes/${sandbox.id}/files`, {
        headers: { authorization: `Bearer ${token}` },
      });
      const tree: unknown = await treeRes.json().catch(() => null);
      throw new Error(
        `npm run build exited ${String(build.exitCode)}\n--- stdout ---\n${build.stdout}\n--- stderr ---\n${build.stderr}\n--- workdir ---\n${JSON.stringify(tree)}`,
      );
    }

    // Best-effort: the browser tab may have gone idle-stale over however long
    // the polling above took, and that's not a reason to fail an otherwise
    // conclusively-passed build — see the module doc comment.
    await shot('real-model-build-passed').catch(() => undefined);
  });
});
