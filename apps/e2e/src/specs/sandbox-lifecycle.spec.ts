/**
 * A workspace survives being paused.
 *
 * This is what the whole stop/destroy split exists for, and it is only
 * observable end to end: the claim is that a file written before an idle pause
 * is still there after it, which no unit test on either side of the provider
 * boundary can establish on its own.
 *
 * The pause is performed by the **real reaper**, on its real timer — the
 * harness shortens the tick (SANDBOX_REAP_INTERVAL_MS) rather than the spec
 * reaching past it to stop a container itself, which would assert nothing
 * about the thing under test. Contents are then read back through the sandbox
 * exec API, not inferred from anything the model said.
 */
import { adminCreds, apiToken, provisionAdmin } from '../helpers/auth.ts';
import { shot } from '../helpers/screenshot.ts';
import { tap, waitForTextIn, waitForVisible } from '../helpers/selectors.ts';
import {
  BASH_PROMPT,
  MOCK_BASH_OUTPUT,
  execInSandbox,
  goToSurface,
  listConversations,
  listSandboxes,
  openSandboxSettings,
  patchSandboxSettings,
  resetSandboxSettings,
  sendMessage,
  signIn,
  startNewAgentRun,
  waitForToolResult,
} from '../helpers/app.ts';

/** Where a container sandbox's working directory lives. */
const WORKDIR = '/home/loxaic/repo';
const MARKER = 'survived-the-pause';
/** The API's floor for an idle window, so this is as fast as the real path
 * can be driven. The harness's 2s reaper tick does the rest. */
const IDLE_STOP_MS = 60_000;

/** Polls the sandbox row until the reaper has paused it. */
async function waitForStatus(
  token: string,
  sandboxId: string,
  status: string,
  timeoutMs = 120_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = await listSandboxes(token);
    const row = rows.find((r) => r.id === sandboxId);
    if (row?.status === status) return;
    if (Date.now() > deadline) {
      throw new Error(`[e2e] sandbox ${sandboxId} was "${row?.status ?? 'gone'}", expected "${status}"`);
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }
}

describe('sandbox lifecycle', () => {
  before(async () => {
    await provisionAdmin();
    // Retention is persisted server state, so start from a known policy
    // rather than trusting the previous run's cleanup — the same reasoning
    // sandbox-bash.spec.ts has for mode.
    await resetSandboxSettings();
    await signIn(adminCreds());
  });

  after(async () => {
    await resetSandboxSettings();
  });

  it('pauses an idle workspace and resumes it with the files still there', async function () {
    // Bounded by the idle window (60s, the API's floor) plus the reaper's own
    // tick, so it needs more than the suite's default.
    this.timeout(5 * 60_000);

    await goToSurface('agent');
    await startNewAgentRun();
    await tap('agent.mode.manual');
    await sendMessage(BASH_PROMPT);
    await waitForVisible('agent.permission.bar');
    await tap('agent.permission.allow');
    // Waits for the tool to have actually run, not merely for the approval
    // prompt to be on screen — see MOCK_BASH_OUTPUT.
    await waitForToolResult(MOCK_BASH_OUTPUT);

    const token = await apiToken(adminCreds());
    const [conversation] = await listConversations(adminCreds());
    const [sandbox] = await listSandboxes(token, conversation.id);
    expect(sandbox.status).toBe('running');

    // Something to lose. A real session's equivalent is an hour of edits.
    const write = await execInSandbox(token, sandbox.id, `echo ${MARKER} > ${WORKDIR}/work.txt`, WORKDIR);
    expect(write.exitCode).toBe(0);

    // The Inspector states the terms while the work is still safe, which is
    // the only moment they are any use.
    await tap('agent.inspector.toggle');
    await waitForTextIn('agent.inspector.workspace.retention', 'pause');
    await shot('sandbox-lifecycle-inspector');

    await patchSandboxSettings({ idleStopMs: IDLE_STOP_MS });
    await waitForStatus(token, sandbox.id, 'stopped');
    await shot('sandbox-lifecycle-paused');

    // The whole point: paused, not gone. Exec resumes it the same way a
    // user's next message would.
    const read = await execInSandbox(token, sandbox.id, `cat ${WORKDIR}/work.txt`, WORKDIR);
    expect(read.exitCode).toBe(0);
    expect(read.stdout).toContain(MARKER);
  });

  it('shows an admin both retention timers, and what turning deletion off costs', async () => {
    await patchSandboxSettings({
      idleStopMs: 4 * 60 * 60 * 1000,
      reapEnabled: true,
      reapAfterMs: 30 * 24 * 60 * 60 * 1000,
    });
    await openSandboxSettings();

    await waitForVisible('sandbox.idleStop.4h');
    await waitForTextIn('sandbox.reap.explainer', 'deleted');
    await shot('sandbox-lifecycle-settings');

    // The inactive branch has to say something rather than go blank: an admin
    // choosing between "loses work" and "grows forever" can only choose if
    // both costs are on screen.
    await tap('sandbox.reap.enabled');
    await waitForTextIn('sandbox.reap.explainer', 'kept until');
    await shot('sandbox-lifecycle-reaping-off');

    await patchSandboxSettings({ reapEnabled: true });
  });
});
