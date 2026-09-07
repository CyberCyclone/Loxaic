/**
 * Electron-only: an agent conversation working in a folder on *this*
 * machine, through the desktop app's local executor.
 *
 * Nothing about this is reachable from web or native — the folder comes from
 * the desktop's native dialog (stood in for by LOXAIC_E2E_PICK_DIR under
 * test), the executor is a child process of the desktop app, and the proof
 * is a file on this machine's real filesystem, read by the harness process
 * rather than by anything inside the app. The second half takes the machine
 * away — the executor is stopped through the same bridge sign-out uses —
 * and shows the run failing *with a reason*, not hanging.
 */
import { browser } from '@wdio/globals';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { E2E_PICK_DIR } from '../../../scripts/electron-env.ts';
import { provisionUser, uniqueCreds } from '../../helpers/auth.ts';
import { shot } from '../../helpers/screenshot.ts';
import { tap, waitForTextIn, waitForVisible } from '../../helpers/selectors.ts';
import {
  BASH_PROMPT,
  MOCK_TOOL_DONE,
  TOOL_PROMPT,
  chooseLocalWorkspace,
  goToSurface,
  listConversations,
  sendMessage,
  signIn,
  waitForRunDone,
  waitForToolResult,
} from '../../helpers/app.ts';

/** The executor's state as the main process reports it — see preload.cjs. */
interface ExecutorState {
  state: string;
  reason: string | null;
  executorId: string;
  roots: string[];
}

async function executorState(): Promise<ExecutorState | null> {
  return browser.execute(async () => {
    const bridge = (window as unknown as {
      loxaic?: { executor?: { getState: () => Promise<ExecutorState> } };
    }).loxaic;
    return (await bridge?.executor?.getState()) ?? null;
  });
}

async function waitForExecutor(state: (s: ExecutorState) => boolean, timeoutMs = 30_000): Promise<ExecutorState> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const current = await executorState();
    if (current && state(current)) return current;
    if (Date.now() > deadline) {
      throw new Error(`[e2e] executor never reached the expected state; last: ${JSON.stringify(current)}`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

describe('electron local workspace', () => {
  const creds = uniqueCreds();

  // No admin needed: nothing here touches the server's sandbox settings —
  // that is the point of a local workspace — which also keeps this spec
  // runnable in self-contained mode, where no harness-minted admin exists.
  before(async function () {
    this.timeout(60_000);
    await provisionUser(creds);
    await signIn(creds);
  });

  it('runs a tool call directly in a folder on this machine', async function () {
    this.timeout(3 * 60_000);

    // Signing in handed the session to the executor (useLocalExecutorSync);
    // it has to be registered with the server before Local is offered.
    const online = await waitForExecutor((s) => s.state === 'online');
    expect(online.executorId).toBeTruthy();

    await goToSurface('agent');
    await chooseLocalWorkspace(E2E_PICK_DIR);
    await shot('local-dir-chosen');

    await tap('agent.mode.manual');
    await sendMessage(TOOL_PROMPT);
    await waitForVisible('agent.permission.bar');
    await tap('agent.permission.allow');
    await waitForTextIn('chat.messageList', MOCK_TOOL_DONE);

    const [conversation] = await listConversations(creds);
    await waitForRunDone(creds, conversation.id);

    // The whole point: a real file, in the real folder, on this machine —
    // asserted from the harness process, not through the app.
    const written = path.join(E2E_PICK_DIR, 'notes.txt');
    expect(existsSync(written)).toBe(true);
    expect(readFileSync(written, 'utf8')).toBe('written by the mock agent\n');

    await tap('agent.inspector.toggle');
    await waitForTextIn('agent.inspector.workspace.kind', E2E_PICK_DIR);
    await shot('local-dir-written');
  });

  it('fails the next tool call with a reason, not a hang, once this machine is gone', async function () {
    this.timeout(3 * 60_000);

    // The same path sign-out takes: the executor is stopped and the server
    // sees the socket close.
    await browser.execute(async () => {
      const bridge = (window as unknown as {
        loxaic?: { executor?: { setSession: (t: string | null) => Promise<unknown> } };
      }).loxaic;
      await bridge?.executor?.setSession(null);
    });
    await waitForExecutor((s) => s.state !== 'online');

    await sendMessage(BASH_PROMPT);
    await waitForVisible('agent.permission.bar');
    await tap('agent.permission.allow');
    await waitForToolResult('is offline — open the Loxaic desktop app there and try again');

    const [conversation] = await listConversations(creds);
    await waitForRunDone(creds, conversation.id);
    await shot('local-dir-offline');
  });
});
