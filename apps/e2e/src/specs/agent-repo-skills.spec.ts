/**
 * A repository's own skills (#283), in `.agents/skills` and `.claude/skills`
 * as Claude Code, OpenCode and Codex keep them.
 *
 * Read through the mock GitHub's contents API before anything is cloned, then
 * from the real clone inside a real sandbox when one is used: the tool's
 * result names the skill's directory and its other files, which only the
 * checkout has. What the model was given is read from the stored rows and the
 * mock's echo, not from the screen alone.
 */
import { apiToken, provisionAdmin, provisionUser, uniqueCreds } from '../helpers/auth.ts';
import { VALID_TOKEN } from '../../scripts/mock-github.ts';
import { BASE_URL } from '../../scripts/standup.ts';
import { shot } from '../helpers/screenshot.ts';
import { platform, typeInto, waitForFreshText, waitForTextIn, waitForVisible } from '../helpers/selectors.ts';
import {
  chooseGithubWorkspace,
  connectGithub,
  getStoredBlocks,
  getToolResults,
  goToSurface,
  listConversations,
  patchSandboxSettings,
  resetSandboxSettings,
  selectThread,
  sendMessage,
  signIn,
  waitForRunDone,
} from '../helpers/app.ts';

/** The chooser on web and Electron; on a phone its branch field is below the
 * dialog's fold, so the same API the chooser calls (see agent-instructions). */
async function startInRepo(creds: { email: string; password: string }): Promise<void> {
  if (platform() !== 'ios' && platform() !== 'android') {
    await chooseGithubWorkspace(7, 'skills');
    return;
  }
  const res = await fetch(`${BASE_URL}/v1/conversations`, {
    method: 'POST',
    headers: { authorization: `Bearer ${await apiToken(creds)}`, 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'agent', workspace: { kind: 'github', repo: 'e2e/skills-app' } }),
  });
  if (!res.ok) throw new Error(`[e2e] creating the conversation failed (${String(res.status)})`);
  const { id } = (await res.json()) as { id: string };
  await goToSurface('chat');
  await goToSurface('agent');
  await selectThread(id, 'agent');
}

describe("agent: a repository's own skills", () => {
  const creds = uniqueCreds();
  let convId = '';

  before(async function () {
    this.timeout(60_000);
    await provisionAdmin();
    await resetSandboxSettings();
    // Using a skill reads it from the clone, and cloning needs network.
    await patchSandboxSettings({ allowNetwork: true });
    await provisionUser(creds);
    await connectGithub(creds, VALID_TOKEN);
    await signIn(creds);
  });

  after(async () => {
    await resetSandboxSettings();
  });

  it('finds them before the repository is cloned, and lists them in the palette', async function () {
    this.timeout(2 * 60_000);
    await goToSurface('agent');
    await startInRepo(creds);
    await sendMessage('say hello');
    [{ id: convId }] = await listConversations(creds);
    await waitForRunDone(creds, convId);

    const res = await fetch(`${BASE_URL}/v1/skills?conversation_id=${convId}`, {
      headers: { authorization: `Bearer ${await apiToken(creds)}` },
    });
    const { skills } = (await res.json()) as { skills: { name: string; source: string; description: string }[] };
    const repo = skills.filter((s) => s.source === 'workspace');
    // .agents/skills supersedes .claude/skills; the colon in deploy-notes'
    // description is the invalid YAML other tools accept.
    expect(repo.map((s) => s.name).sort()).toEqual(['deploy-notes', 'repo-lint']);
    expect(repo.find((s) => s.name === 'repo-lint')?.description).toBe('Lint this repository with its own rules. Use before committing.');
    expect(repo.find((s) => s.name === 'deploy-notes')?.description).toBe('Write deploy notes for this project. Use: when shipping a release.');

    await typeInto('composer.input', '/dep');
    await waitForVisible('composer.command.deploy-notes');
    await shot('repo-skills-palette');
    await typeInto('composer.input', '');
  });

  it('runs one with /name, reading its instructions from the repository', async function () {
    this.timeout(3 * 60_000);
    await sendMessage('/deploy-notes for v2');
    await waitForTextIn('chat.messageList', 'Skill loaded: deploy-notes.');
    await waitForRunDone(creds, convId);
    await waitForFreshText('chat.message.skill', 'Skill: deploy-notes (workspace)');
    const invoked = (await getStoredBlocks(creds, convId)).find((b) => b.kind === 'skill');
    expect(invoked).toMatchObject({ name: 'deploy-notes', source: 'workspace' });
    expect(invoked?.text).toContain('grouped by service');
    expect(invoked?.text).toContain("This skill comes from the workspace's repository");
    await shot('repo-skills-invoked');
  });

  it('loads one when the model asks, with its directory and files from the clone', async function () {
    this.timeout(4 * 60_000);
    await sendMessage('please use the repo-lint skill');
    await waitForRunDone(creds, convId);
    const loaded = (await getToolResults(creds, convId)).find((r) => r.output.startsWith('<skill-content name="repo-lint"'));
    expect(loaded?.ok).toBe(true);
    expect(loaded?.output).toContain('Run `scripts/check.sh`.');
    expect(loaded?.output).toContain('Skill directory: .agents/skills/repo-lint');
    expect(loaded?.output).toContain('- .agents/skills/repo-lint/scripts/check.sh');
    expect(loaded?.output).not.toContain('Never used.');
    await shot('repo-skills-loaded-by-the-model');
  });
});
