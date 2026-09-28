/**
 * Electron-only: the AGENTS.md of a folder on *this* machine.
 *
 * A local workspace is read through the desktop's executor, before any
 * sandbox exists — the server asks the executor to read the folder with the
 * folder itself as the ref — and a nested file is read by the same executor
 * running this machine's own shell tools (bash, tail, head, base64 on macOS),
 * which no other lane exercises.
 *
 * The files are written into the run's shared pick folder and removed again
 * in `after`: the other local-workspace specs assert the mock's plain echo,
 * which an AGENTS.md left behind would change.
 */
import { browser } from '@wdio/globals';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { E2E_PICK_DIR } from '../../../scripts/electron-env.ts';
import { provisionUser, uniqueCreds } from '../../helpers/auth.ts';
import { shot } from '../../helpers/screenshot.ts';
import { waitForTextIn } from '../../helpers/selectors.ts';
import {
  chooseLocalWorkspace,
  getToolResults,
  goToSurface,
  listConversations,
  openInspector,
  sendMessage,
  signIn,
  waitForRunDone,
} from '../../helpers/app.ts';

const ROOT_FILE = path.join(E2E_PICK_DIR, 'AGENTS.md');
const SUB_DIR = path.join(E2E_PICK_DIR, 'pkg', 'sub');

async function executorOnline(timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const state = await browser.execute(async () => {
      const bridge = (window as unknown as { loxaic?: { executor?: { getState: () => Promise<{ state: string }> } } }).loxaic;
      return (await bridge?.executor?.getState())?.state ?? null;
    });
    if (state === 'online') return;
    if (Date.now() > deadline) throw new Error(`[e2e] executor never came online; last: ${String(state)}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

describe('electron local workspace: the folder\'s AGENTS.md', () => {
  const creds = uniqueCreds();

  before(async function () {
    this.timeout(60_000);
    writeFileSync(ROOT_FILE, '# Local rules\n\nThis folder uses pnpm, never npm.\n');
    mkdirSync(SUB_DIR, { recursive: true });
    writeFileSync(path.join(SUB_DIR, 'AGENTS.md'), '# pkg/sub\n\nUse tabs for indentation in this package.\n');
    writeFileSync(path.join(SUB_DIR, 'index.js'), 'export function sub(a, b) {\n\treturn a - b;\n}\n');
    await provisionUser(creds);
    await signIn(creds);
  });

  after(() => {
    rmSync(ROOT_FILE, { force: true });
    rmSync(path.join(E2E_PICK_DIR, 'pkg'), { recursive: true, force: true });
  });

  it('reads it on this machine, includes a short one whole, and brings in a nested one on a read', async function () {
    this.timeout(3 * 60_000);
    await executorOnline();
    await goToSurface('agent');
    await chooseLocalWorkspace(E2E_PICK_DIR);

    await sendMessage('say hello');
    await waitForTextIn('chat.messageList', 'Project instructions: AGENTS.md (full).');
    const [conversation] = await listConversations(creds);
    await waitForRunDone(creds, conversation.id);

    await openInspector();
    await waitForTextIn('agent.inspector.instructions', 'is included in full');
    await shot('local-instructions-inspector');

    // fs_read needs no approval in any mode, so the scenario runs unattended.
    await sendMessage('read the sub package');
    await waitForTextIn('chat.messageList', '[Mock] Read the sub package.');
    await waitForRunDone(creds, conversation.id);
    const [read] = (await getToolResults(creds, conversation.id)).filter((r) => r.output.includes('return a - b'));
    expect(read.output).toContain('<project-instructions path="pkg/sub/AGENTS.md"');
    expect(read.output).toContain('Use tabs for indentation in this package.');
    await shot('local-instructions-nested-read');
  });
});
