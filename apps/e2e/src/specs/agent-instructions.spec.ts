/**
 * A repository's own AGENTS.md, in front of the agent.
 *
 * Everything on the server side is real: the file is read through the mock
 * GitHub API's contents route before the first request, the nested one in
 * pkg/sub is read from the real clone inside a real sandbox, and what the
 * model was given is proved by the mock, which reads it off the system
 * message it was actually sent (`Project instructions: … (mode)`), and by the
 * stored tool results, not by the UI's own account.
 *
 * The fixture's AGENTS.md is ~2.7k tokens. The mock's default model runs a
 * 4k window, which can spare 1,024 tokens for it, so it gets an outline; the
 * other mock model has 32k, which can spare ~4.9k, so the same file goes in
 * whole. That switch is the feature: how much of the file the agent sees
 * follows the model's window.
 */
import { apiToken, provisionAdmin, provisionUser, uniqueCreds } from '../helpers/auth.ts';
import { VALID_TOKEN } from '../../scripts/mock-github.ts';
import { BASE_URL } from '../../scripts/standup.ts';
import { shot } from '../helpers/screenshot.ts';
import { platform, tap, waitForGone, waitForTextIn, waitForVisible } from '../helpers/selectors.ts';
import {
  chooseGithubWorkspace,
  connectGithub,
  getToolResults,
  goToSurface,
  listConversations,
  selectThread,
  openInspector,
  patchSandboxSettings,
  resetSandboxSettings,
  sendMessage,
  signIn,
  startNewAgentRun,
  waitForRunDone,
} from '../helpers/app.ts';

const NESTED_MARKER = '<project-instructions path="pkg/sub/AGENTS.md"';

async function pickModel(id: string): Promise<void> {
  await tap('composer.model');
  await waitForVisible(`models.row.${id}`);
  await tap(`models.row.${id}`);
  await waitForGone('models.dialog', 10_000);
}

/**
 * Starts an agent conversation in a GitHub repo. Through the real chooser on
 * web and Electron. On a phone the chooser's branch field sits below the
 * dialog's fold, where XCUITest cannot reach it — agent-github-workspace.spec
 * fails there at the same step — so native creates the conversation through
 * the same API the chooser calls and opens it from the thread list; everything
 * after that is the UI.
 */
async function startInRepo(creds: { email: string; password: string }, repoId: number, repo: string, search: string): Promise<void> {
  if (platform() !== 'ios' && platform() !== 'android') {
    await chooseGithubWorkspace(repoId, search);
    return;
  }
  const token = await apiToken(creds);
  const res = await fetch(`${BASE_URL}/v1/conversations`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'agent', workspace: { kind: 'github', repo } }),
  });
  if (!res.ok) throw new Error(`[e2e] creating the conversation failed (${String(res.status)}): ${await res.text()}`);
  const { id } = (await res.json()) as { id: string };
  // Leave and come back so the thread list reloads with the new row.
  await goToSurface('chat');
  await goToSurface('agent');
  await selectThread(id, 'agent');
}

async function instructionsSummary(token: string, conversationId: string): Promise<unknown> {
  const res = await fetch(`${BASE_URL}/v1/conversations/${conversationId}`, { headers: { authorization: `Bearer ${token}` } });
  const body = (await res.json()) as { instructions?: unknown };
  return body.instructions;
}

describe('agent: the project\'s own AGENTS.md', () => {
  const creds = uniqueCreds();

  before(async function () {
    this.timeout(60_000);
    await provisionAdmin();
    await resetSandboxSettings();
    // The nested case clones the repo, and cloning needs network.
    await patchSandboxSettings({ allowNetwork: true });
    await provisionUser(creds);
    await connectGithub(creds, VALID_TOKEN);
    await signIn(creds);
  });

  after(async () => {
    await resetSandboxSettings();
  });

  it('gives a small window an outline, then brings in a subdirectory\'s file when the agent reads there', async function () {
    this.timeout(4 * 60_000);
    await goToSurface('agent');
    await startInRepo(creds, 4, 'e2e/instructions-app', 'instructions');

    await sendMessage('say hello');
    await waitForTextIn('chat.messageList', 'Project instructions: AGENTS.md (outline).');
    const [conversation] = await listConversations(creds);
    await waitForRunDone(creds, conversation.id);
    const token = await apiToken(creds);
    // The text never leaves the server; the summary does.
    const summary = await instructionsSummary(token, conversation.id);
    expect(summary).toMatchObject({ status: 'found', path: 'AGENTS.md', mode: 'outline' });
    expect(JSON.stringify(summary)).not.toContain('Two-space indentation');

    await openInspector();
    await waitForTextIn('agent.inspector.instructions', 'opening and section headings');
    await shot('instructions-outline-inspector');
    await tap('agent.inspector.toggle');

    // The first read below pkg/sub brings its AGENTS.md along — this is the
    // read that creates the sandbox and so the clone.
    await sendMessage('read the sub package');
    await waitForTextIn('chat.messageList', '[Mock] Read the sub package.');
    await waitForRunDone(creds, conversation.id);
    await shot('instructions-nested-read');

    // A second read of the same package does not repeat it.
    await sendMessage('read the sub package');
    await waitForRunDone(creds, conversation.id);
    const reads = (await getToolResults(creds, conversation.id)).filter((r) => r.output.includes('return a - b'));
    expect(reads).toHaveLength(2);
    expect(reads[0].output).toContain(NESTED_MARKER);
    expect(reads[0].output).toContain('Use tabs for indentation in this package.');
    expect(reads[1].output).not.toContain(NESTED_MARKER);
  });

  it('includes the same file whole once the model has room for it', async function () {
    this.timeout(2 * 60_000);
    // Same conversation, a model with an eight-times larger window. A new
    // model is the one time the decision is taken again: it has no cached
    // prefix to lose.
    await pickModel('qwen2.5-14b-instruct');
    await sendMessage('say hello again');
    await waitForTextIn('chat.messageList', 'Project instructions: AGENTS.md (full).');
    const [conversation] = await listConversations(creds);
    await waitForRunDone(creds, conversation.id);
    expect(await instructionsSummary(await apiToken(creds), conversation.id)).toMatchObject({ mode: 'full' });

    await openInspector();
    await waitForTextIn('agent.inspector.instructions', 'is included in full');
    await shot('instructions-full-inspector');
    await tap('agent.inspector.toggle');
  });

  it('says there is none for a repository without one, and adds nothing', async function () {
    this.timeout(2 * 60_000);
    await startNewAgentRun();
    await startInRepo(creds, 1, 'e2e/bugfix-app', 'bugfix');
    await sendMessage('say hello');
    await waitForTextIn('chat.messageList', '[Mock] Echo: say hello');
    const [conversation] = await listConversations(creds);
    await waitForRunDone(creds, conversation.id);
    expect(await instructionsSummary(await apiToken(creds), conversation.id)).toEqual({ status: 'none' });

    await openInspector();
    await waitForTextIn('agent.inspector.instructions', 'No AGENTS.md or CLAUDE.md');
    await shot('instructions-none-inspector');
  });
});
