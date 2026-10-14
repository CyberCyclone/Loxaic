/**
 * Electron-only: the skills of a folder on *this* machine (#283), read through
 * the desktop's executor with this machine's own shell tools, before any
 * sandbox exists. An edit on disk between messages reaches the model as a
 * notice. The files are written into the run's shared pick folder and removed
 * in `after`, as agent-local-instructions.spec does.
 */
import { browser } from '@wdio/globals';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { E2E_PICK_DIR } from '../../../scripts/electron-env.ts';
import { provisionUser, uniqueCreds } from '../../helpers/auth.ts';
import { shot } from '../../helpers/screenshot.ts';
import { waitForFreshText, waitForTextIn } from '../../helpers/selectors.ts';
import {
  chooseLocalWorkspace,
  getStoredBlocks,
  goToSurface,
  listConversations,
  sendMessage,
  signIn,
  waitForRunDone,
} from '../../helpers/app.ts';

const SKILLS = path.join(E2E_PICK_DIR, '.agents');
const SKILL_FILE = path.join(SKILLS, 'skills', 'local-check', 'SKILL.md');
const skill = (body: string) => `---\nname: local-check\ndescription: Check this folder.\n---\n${body}\n`;

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

describe('electron local workspace: the folder\'s skills', () => {
  const creds = uniqueCreds();

  before(async function () {
    this.timeout(60_000);
    mkdirSync(path.dirname(SKILL_FILE), { recursive: true });
    writeFileSync(SKILL_FILE, skill('Run the local checks.'));
    await provisionUser(creds);
    await signIn(creds);
  });

  after(() => {
    rmSync(SKILLS, { recursive: true, force: true });
  });

  it('runs one from the folder, and tells the agent when it changes on disk', async function () {
    this.timeout(3 * 60_000);
    await executorOnline();
    await goToSurface('agent');
    await chooseLocalWorkspace(E2E_PICK_DIR);

    await sendMessage('say hello');
    const [conversation] = await listConversations(creds);
    await waitForRunDone(creds, conversation.id);

    await sendMessage('/local-check now');
    await waitForTextIn('chat.messageList', 'Skill loaded: local-check.');
    await waitForRunDone(creds, conversation.id);
    const invoked = (await getStoredBlocks(creds, conversation.id)).find((b) => b.kind === 'skill');
    expect(invoked?.text).toContain('Run the local checks.');
    await shot('local-skills-invoked');

    writeFileSync(SKILL_FILE, skill('Run the local checks twice.'));
    await sendMessage('and again');
    await waitForTextIn('chat.messageList', 'Skills updated: local-check.');
    await waitForRunDone(creds, conversation.id);
    await waitForFreshText('chat.message.skillsUpdate', 'Skills changed: changed local-check');
    await shot('local-skills-update-notice');
  });
});
