/**
 * Electron-only: a local workspace with **container isolation** — the agent
 * working in a folder on this machine, but from inside a container with only
 * that folder mounted.
 *
 * The pair of assertions is the point, and neither alone would do:
 *
 * - The file the agent writes appears in the real folder on the real
 *   filesystem, read by the harness process. That is the mount working.
 * - The shell's working directory is the *container's* `/home/loxaic/repo`,
 *   not the host path the direct-mode spec sees for the very same folder.
 *   That is the container being real rather than a relabelled direct run, and
 *   it is what someone choosing this over Direct is actually buying.
 *
 * The folder is the same one the direct-mode spec uses — the desktop's picker
 * hook is fixed at launch, so there is one per run — which is why the file is
 * removed first: otherwise that spec's own `notes.txt` would satisfy this
 * spec's assertion without a container ever having run.
 *
 * Needs a container engine on this machine, as the sibling sandbox specs do.
 * Without one the chooser does not offer the option at all, which is itself
 * the specified behaviour.
 */
import { browser } from '@wdio/globals';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { E2E_PICK_DIR } from '../../../scripts/electron-env.ts';
import { provisionUser, uniqueCreds } from '../../helpers/auth.ts';
import { shot } from '../../helpers/screenshot.ts';
import { tap, typeInto, waitForTextIn, waitForVisible } from '../../helpers/selectors.ts';
import {
  MOCK_TOOL_DONE,
  TOOL_PROMPT,
  chooseLocalWorkspace,
  goToSurface,
  listConversations,
  sendMessage,
  signIn,
  startNewAgentRun,
  waitForRunDone,
} from '../../helpers/app.ts';

/** Where the image puts the checkout, and so where a containerised local
 * workspace's commands run — the host path is nowhere in sight. */
const CONTAINER_WORKDIR = '/home/loxaic/repo';

/** The first container-isolated workspace on a machine builds the sandbox
 * image before anything can run in it. */
const FIRST_RUN_MS = 5 * 60_000;

interface ExecutorState {
  state: string;
}

async function waitForExecutorOnline(): Promise<void> {
  await browser.waitUntil(
    async () => {
      const state = await browser.execute(async () => {
        const bridge = (window as unknown as {
          loxaic?: { executor?: { getState: () => Promise<ExecutorState> } };
        }).loxaic;
        return (await bridge?.executor?.getState()) ?? null;
      });
      return state?.state === 'online';
    },
    { timeout: 30_000, interval: 250, timeoutMsg: 'the executor never came online' },
  );
}

describe('electron local workspace, container isolation', () => {
  const creds = uniqueCreds();

  before(async function () {
    this.timeout(60_000);
    await provisionUser(creds);
    await signIn(creds);
  });

  it('runs in a container on this machine, with only the chosen folder inside it', async function () {
    this.timeout(8 * 60_000);

    await waitForExecutorOnline();

    // See the module comment: the assertion below must be about *this* run.
    const written = path.join(E2E_PICK_DIR, 'notes.txt');
    rmSync(written, { force: true });

    await goToSurface('agent');
    await startNewAgentRun();
    // Tapping the container option only works when that machine reported a
    // container engine, so getting this far is itself part of the assertion.
    await chooseLocalWorkspace(E2E_PICK_DIR, 'container');
    await shot('local-container-chosen');

    await tap('agent.mode.manual');
    await sendMessage(TOOL_PROMPT);
    await waitForVisible('agent.permission.bar');
    await tap('agent.permission.allow');
    await waitForTextIn('chat.messageList', MOCK_TOOL_DONE, FIRST_RUN_MS);

    const [conversation] = await listConversations(creds);
    await waitForRunDone(creds, conversation.id);

    // The mount: a real file, in the real folder, on this machine.
    expect(existsSync(written)).toBe(true);
    expect(readFileSync(written, 'utf8')).toBe('written by the mock agent\n');

    // The container: the shell is inside one, at the image's own path rather
    // than the host directory the direct-mode spec reports for this folder.
    await tap('agent.terminal.toggle');
    await waitForVisible('agent.terminal.panel');
    await waitForTextIn('agent.terminal.status', CONTAINER_WORKDIR);
    await typeInto('agent.terminal.input', 'pwd');
    await browser.keys('Enter');
    await waitForTextIn('agent.terminal.view', CONTAINER_WORKDIR);
    await shot('local-container-terminal');
  });
});
