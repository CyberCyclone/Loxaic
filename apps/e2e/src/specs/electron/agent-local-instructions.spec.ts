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
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { E2E_PICK_DIR } from '../../../scripts/electron-env.ts';
import { provisionUser, uniqueCreds } from '../../helpers/auth.ts';
import { shot } from '../../helpers/screenshot.ts';
import { isVisible, tap, waitForFreshText, waitForTextIn, waitForVisible } from '../../helpers/selectors.ts';
import {
  MOCK_TOOL_DONE,
  TOOL_PROMPT,
  chooseLocalWorkspace,
  getToolResults,
  goToSurface,
  listConversations,
  openInspector,
  sendMessage,
  signIn,
  signOut,
  startNewAgentRun,
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

    // Edited on this machine between messages: the next run tells the agent,
    // in the chat, without touching the system prompt.
    writeFileSync(ROOT_FILE, '# Local rules\n\nThis folder uses pnpm, never npm or yarn.\n');
    await sendMessage('say hello again');
    await waitForTextIn('chat.messageList', 'Project instructions updated: AGENTS.md.');
    await waitForRunDone(creds, conversation.id);
    await waitForFreshText('chat.message.instructionsUpdate', 'The agent was given the change with this message.');
    await shot('local-instructions-update-notice');
  });
});

/**
 * An untrusted folder whose AGENTS.md is a symlink to a file elsewhere on this
 * machine, beside a real CLAUDE.md. What the agent is given is the proof,
 * because the mock names the file its system prompt carried: CLAUDE.md, never
 * the symlink's target.
 *
 * - Direct: read on this machine, and passed over by real path.
 * - Container-isolated: never read on this machine at all. Nothing is read
 *   until the agent's first command has started the container, and inside it
 *   the symlink points at nothing.
 *
 * The container case needs a container engine, as the sibling container spec
 * does, and builds the sandbox image on a machine's first container run.
 */
/** The Inspector toggles, and stays open across conversations. */
async function inspectorOpen(): Promise<void> {
  if (!(await isVisible('agent.inspector.panel'))) await openInspector();
}

describe('electron local workspace: a symlinked AGENTS.md leading out of the folder', () => {
  const creds = uniqueCreds();
  const agentsLink = path.join(E2E_PICK_DIR, 'AGENTS.md');
  const claude = path.join(E2E_PICK_DIR, 'CLAUDE.md');
  const notes = path.join(E2E_PICK_DIR, 'notes.txt');
  let outside: string;

  before(async function () {
    this.timeout(60_000);
    outside = mkdtempSync(path.join(os.tmpdir(), 'loxaic-e2e-outside-'));
    writeFileSync(path.join(outside, 'id_ed25519'), 'SECRET KEY, never to be read\n');
    rmSync(agentsLink, { force: true });
    symlinkSync(path.join(outside, 'id_ed25519'), agentsLink);
    writeFileSync(claude, '# Inside rules\n\nThis folder uses pnpm.\n');
    await provisionUser(creds);
    // The block above left its own user signed in.
    await signOut();
    await signIn(creds);
  });

  after(() => {
    rmSync(agentsLink, { force: true });
    rmSync(claude, { force: true });
    rmSync(notes, { force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it('is passed over on this machine, and the folder\'s own CLAUDE.md is used', async function () {
    this.timeout(3 * 60_000);
    await executorOnline();
    await goToSurface('agent');
    await startNewAgentRun();
    await chooseLocalWorkspace(E2E_PICK_DIR);

    await sendMessage('say hello');
    await waitForTextIn('chat.messageList', 'Project instructions: CLAUDE.md (full).');
    const [conversation] = await listConversations(creds);
    await waitForRunDone(creds, conversation.id);
    await inspectorOpen();
    await waitForTextIn('agent.inspector.instructions', 'CLAUDE.md');
    await shot('local-instructions-symlink-direct');
  });

  it('is never read on this machine for a container-isolated folder, and inside the container leads nowhere', async function () {
    this.timeout(8 * 60_000);
    await executorOnline();
    await goToSurface('agent');
    await startNewAgentRun();
    await chooseLocalWorkspace(E2E_PICK_DIR, 'container');

    // No container yet, and nothing starts one to read the file.
    await sendMessage('say hello');
    const [conversation] = await listConversations(creds);
    await waitForRunDone(creds, conversation.id);
    await inspectorOpen();
    await waitForTextIn('agent.inspector.instructions', 'inside the container, once the agent has started it');
    await shot('local-instructions-container-waiting');

    // The agent's first command starts the container.
    await tap('agent.mode.manual');
    await sendMessage(TOOL_PROMPT);
    await waitForVisible('agent.permission.bar');
    await tap('agent.permission.allow');
    await waitForTextIn('chat.messageList', MOCK_TOOL_DONE, 5 * 60_000);
    await waitForRunDone(creds, conversation.id);

    // Read inside it: the symlink's target is not in the container.
    await sendMessage('say hello again');
    await waitForTextIn('chat.messageList', 'Project instructions: CLAUDE.md (full).');
    await waitForRunDone(creds, conversation.id);
    await waitForTextIn('agent.inspector.instructions', 'CLAUDE.md');
    await shot('local-instructions-symlink-container');
  });
});
