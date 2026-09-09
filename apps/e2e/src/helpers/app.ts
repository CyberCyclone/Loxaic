/**
 * App-level steps shared by every spec, expressed in the product's own terms
 * ("sign in", "send a message") rather than in clicks. Specs read as behaviour;
 * anything platform- or layout-specific is absorbed here.
 */
import { browser } from '@wdio/globals';
import { byTestId, isVisible, platform, tap, typeInto, waitForTextIn, waitForVisible } from './selectors.ts';
import { adminCreds, apiToken, type Credentials } from './auth.ts';
import path from 'node:path';
import { BASE_URL } from '../../scripts/standup.ts';

/** Text the mock inference provider echoes back for a plain chat turn. */
export function mockEcho(prompt: string): string {
  return `[Mock] Echo: ${prompt}`;
}

/** Prefix of the mock's post-tool wrap-up, after a tool call has run. */
export const MOCK_TOOL_DONE = '[Mock] Done. The tool returned:';

/**
 * A prompt the mock provider answers with an fs_write tool call. fs_write
 * requires approval in manual mode, which is what makes it the lever for
 * exercising the permission flow. See apps/server/src/inference/provider.ts.
 */
export const TOOL_PROMPT = 'write a file called notes';

/**
 * A prompt the mock provider deliberately takes several seconds to answer.
 *
 * The run queue only shows itself when two runs overlap, and every other mock
 * response lands in milliseconds — so a spec that wants to *see* a queue has
 * to be able to ask for a slow one rather than race the harness against
 * itself. See MOCK_SLOW_MATCH in apps/server/src/inference/provider.ts.
 */
export const SLOW_PROMPT = 'take your time and think about this';

/**
 * Matches the `scenarios.json` fixture's bugfix scenario: run the tests (they
 * fail on the fixture's real off-by-one), fix it for real with `fs_edit`, and
 * rerun them (they pass) — three genuine tool calls in one turn, driven by
 * the mock scenario engine rather than a single trigger. See
 * apps/e2e/fixtures/scenarios.json and apps/server/src/inference/mock-scenarios.ts.
 */
export const BUGFIX_SCENARIO_PROMPT = 'The tests are failing — please find and fix the bug, then confirm they pass.';

/** Substring of the bugfix scenario's own wrap-up text, once all three of its
 * steps have run. */
export const BUGFIX_SCENARIO_DONE = 'node --test now passes';

/**
 * Matches the `scenarios.json` fixture's new-project scenario: three real
 * `fs_write` calls (a package.json, a source file, a passing test for it)
 * followed by a `bash` call that actually runs `node --test` — a scratch
 * workspace with no repo, built from nothing by the scenario itself.
 */
export const NEW_PROJECT_SCENARIO_PROMPT = 'Create a new project with three files, then run its tests.';

/** Substring of the new-project scenario's wrap-up text, once its four steps
 * have run. */
export const NEW_PROJECT_SCENARIO_DONE = 'node --test passes';

/** A prompt the mock provider answers with a `bash` tool call — the probe
 * used to check that a sandbox actually executes, in whichever mode is
 * currently configured (container or host). See MOCK_TOOL_TRIGGERS in
 * apps/server/src/inference/provider.ts. */
export const BASH_PROMPT = 'run a bash command';

/** Substring of the bash trigger's stdout, echoed back inside the mock's
 * `[Mock] Done. The tool returned: …` wrap-up once the tool call resolves.
 *
 * **Not sufficient on its own to prove the tool ran.** It is also part of the
 * command the tool-call card displays (`echo hello from the sandbox`), which
 * is on screen from the moment approval is *requested* — so a wait for this
 * alone can pass while the run is still sitting at the permission bar. Wait
 * for {@link MOCK_TOOL_DONE} first; that text exists only after a tool result
 * comes back. */
export const MOCK_BASH_OUTPUT = 'hello from the sandbox';

/** Waits for a tool call to have actually executed, then for its output.
 * The ordering is the point — see MOCK_BASH_OUTPUT. */
export async function waitForToolResult(output: string): Promise<void> {
  await waitForTextIn('chat.messageList', MOCK_TOOL_DONE);
  await waitForTextIn('chat.messageList', output);
}

/**
 * The sidebar is permanently visible on wide layouts and a slide-over
 * everywhere else, so reaching a nav item means "open it first, but only if it
 * isn't already there". Deciding from what's actually on screen keeps this
 * working on a phone, a tablet and a desktop window without per-platform config.
 */
export async function openSidebar(): Promise<void> {
  // Retry loop rather than a single tap: right after a navigation the screen
  // may still be animating, and a tap that lands mid-transition is silently
  // swallowed (seen on iOS immediately after sign-up). Re-checking before
  // each tap keeps this idempotent — if the drawer opened meanwhile, no
  // second tap fires to toggle it shut.
  await browser.waitUntil(
    async () => {
      if (await byTestId('sidebar.signOut').isDisplayed()) return true;
      await tap('shell.menuButton');
      return await byTestId('sidebar.signOut')
        .waitForDisplayed({ timeout: 3000 })
        .then(() => true, () => false);
    },
    { timeout: 20_000, interval: 250, timeoutMsg: 'sidebar did not open' },
  );
}

/**
 * Waits for the authenticated shell to be usable.
 *
 * Not simply `composer.input`: a user whose only conversation is shared
 * read-only gets `composer.readOnly` in its place, so keying on the input
 * alone would hang for exactly the user the sharing spec signs in. Either
 * element means the app is past login and has rendered a conversation.
 */
export async function waitForComposerReady(timeout = 20_000): Promise<void> {
  await browser.waitUntil(
    async () => (await isVisible('composer.input')) || (await isVisible('composer.readOnly')),
    {
      timeout,
      interval: 300,
      timeoutMsg: `neither composer.input nor composer.readOnly appeared within ${String(timeout)}ms`,
    },
  );
}

export async function signUp(creds: Credentials): Promise<void> {
  await waitForVisible('login.submit');
  await tap('login.toggleMode'); // sign-in is the default mode
  await waitForVisible('login.name');
  await typeInto('login.name', creds.name);
  await typeInto('login.email', creds.email);
  await typeInto('login.password', creds.password);
  await tap('login.submit');
  await waitForComposerReady();
  await dismissIosSavePasswordPrompt();
}

export async function signIn(creds: Credentials): Promise<void> {
  await waitForVisible('login.submit');
  await typeInto('login.email', creds.email);
  await typeInto('login.password', creds.password);
  await tap('login.submit');
  await waitForComposerReady();
  await dismissIosSavePasswordPrompt();
}

/**
 * iOS 26's Passwords app raises a "Save Password?" sheet over the app right
 * after a credential submit (the login fields are `textContentType="password"`,
 * which is correct for real users). It is not a UIAlertController, so
 * `autoDismissAlerts` never sees it, and the next tap the spec makes lands on
 * the sheet instead of the app — the composer's attach sheet "never opened"
 * for exactly this reason on the first iOS 26 run. Only iOS 26+ raises it
 * (iOS 17 simulators never do), so this is conditional.
 */
async function dismissIosSavePasswordPrompt(): Promise<void> {
  if (platform() !== 'ios') return;
  // The sheet is raised with the credential submit, and waitForComposerReady
  // has already absorbed that latency, so a short wait is enough — and it is
  // the price paid on every sign-in where the sheet does *not* appear.
  const notNow = $('~Not Now');
  const appeared = await notNow.waitForExist({ timeout: 1_500 }).catch(() => false);
  if (appeared) {
    await notNow.click();
    await browser.pause(300);
  }
}

export async function signOut(): Promise<void> {
  await openSidebar();
  await tap('sidebar.signOut');
  await waitForVisible('login.submit');
}

export async function sendMessage(text: string): Promise<void> {
  await typeInto('composer.input', text);
  await tap('composer.send');
}

/** Sends a prompt and waits for the reply to land in the message list. */
export async function sendAndAwaitReply(prompt: string, expected: string): Promise<void> {
  await sendMessage(prompt);
  await waitForTextIn('chat.messageList', expected);
}

export async function goToSurface(surface: 'chat' | 'agent' | 'routines' | 'stats'): Promise<void> {
  await openSidebar();
  await tap(`sidebar.nav.${surface}`);
  await waitForVisible('composer.input');
}

/**
 * Reveals the thread list, on any layout.
 *
 * It is pinned open only at >=1024px; narrower, it is an overlay behind a
 * per-surface toggle — so reaching into it directly works on a desktop
 * browser and times out on a phone. Mirrors openSidebar()'s approach of
 * deciding from what is actually on screen rather than from a breakpoint the
 * spec would have to know.
 */
export async function openThreadList(surface: 'chat' | 'agent' = 'chat'): Promise<void> {
  if (await byTestId('threadList.newChat').isDisplayed().catch(() => false)) return;
  await tap(`${surface}.threadList.toggle`);
  await waitForVisible('threadList.newChat');
}

/** Starts a new thread on the given surface, on any layout. */
export async function startNewThread(surface: 'chat' | 'agent' = 'chat'): Promise<void> {
  await openThreadList(surface);
  await tap('threadList.newChat');
}

/** Back-compat alias — the agent specs read better with the surface in the name. */
export async function startNewAgentRun(): Promise<void> {
  await startNewThread('agent');
}

/**
 * Selects an existing thread by its server conversation id.
 *
 * By id, not by list position: the id is the list's own React key, so this
 * survives reordering (the list is most-recent-first, and sending anything
 * reorders it) in a way an index never could.
 */
export async function selectThread(
  conversationId: string,
  surface: 'chat' | 'agent' = 'chat',
): Promise<void> {
  await openThreadList(surface);
  await tap(`threadList.item.${conversationId}`);
}

/** The signed-in user's conversations, newest first — straight from the API,
 * for specs that need a real conversation id to select or assert against. */
export async function listConversations(
  creds: Pick<Credentials, 'email' | 'password'>,
): Promise<{ id: string; title: string; kind?: 'chat' | 'agent' }[]> {
  const token = await apiToken(creds);
  const res = await fetch(`${BASE_URL}/v1/conversations`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`[e2e] listing conversations failed (${String(res.status)})`);
  // `kind` is on the wire already; typed here so a spec can tell an agent run
  // from a chat thread without matching on titles. Optional because rows
  // predating the column don't carry one.
  return (await res.json()) as { id: string; title: string; kind?: 'chat' | 'agent' }[];
}

/**
 * The text of every message in a conversation, straight from the API.
 *
 * For assertions about *where a message landed*, which the screen cannot
 * settle: a misrouted message renders perfectly well in the thread it was
 * wrongly written to (#117).
 */
export async function getMessageTexts(
  creds: Pick<Credentials, 'email' | 'password'>,
  conversationId: string,
): Promise<string[]> {
  const token = await apiToken(creds);
  const res = await fetch(`${BASE_URL}/v1/conversations/${conversationId}/messages`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`[e2e] getting messages failed (${String(res.status)})`);
  const body = (await res.json()) as { messages: { content: { kind: string; text?: string }[] }[] };
  return body.messages.flatMap((m) =>
    m.content.filter((b) => b.kind === 'text').map((b) => b.text ?? ''),
  );
}

/** Opens Settings and navigates to the Agent Sandbox screen, for admin and
 * non-admin sessions alike — the screen itself branches on role. */
export async function openSandboxSettings(): Promise<void> {
  await openSidebar();
  await tap('sidebar.settings');
  await tap('settings.nav.sandbox');
  await waitForVisible('sandbox.status');
}

/** Selects a sandbox mode from the Agent Sandbox screen (caller must already
 * be there — see openSandboxSettings()), confirming host mode's warning
 * dialog when that's the target. Waits for the status card to reflect it,
 * which is also the proof the change round-tripped through the server. */
export async function setSandboxMode(mode: 'container' | 'host' | 'off'): Promise<void> {
  await tap(`sandbox.mode.${mode}`);
  if (mode === 'host') {
    await waitForVisible('sandbox.hostWarning.confirm');
    await tap('sandbox.hostWarning.confirm');
  }
  await waitForTextIn('sandbox.status', `(${mode})`);
}

/** Patches sandbox settings straight through the admin API. The UI has no
 * control for a one-second idle window (deliberately — the picker offers hours),
 * so a spec that needs to *observe* a pause has to ask for one this way. */
export async function patchSandboxSettings(patch: Record<string, unknown>): Promise<void> {
  const token = await apiToken(adminCreds());
  const res = await fetch(`${BASE_URL}/v1/admin/settings/sandbox`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    throw new Error(`[e2e] sandbox settings patch failed (${String(res.status)}): ${await res.text()}`);
  }
}

/** Connects GitHub for `creds` straight through the API, with the token the
 * mock GitHub server accepts. For specs whose subject is what a connection
 * *enables*, not the connection screen itself (github-settings.spec.ts). */
export async function connectGithub(creds: Pick<Credentials, 'email' | 'password'>, token: string): Promise<void> {
  const session = await apiToken(creds);
  const res = await fetch(`${BASE_URL}/v1/github/connection`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${session}` },
    body: JSON.stringify({ token }),
  });
  if (!res.ok) throw new Error(`[e2e] connecting GitHub failed (${String(res.status)}): ${await res.text()}`);
}

/**
 * Polls until the conversation has no active run. The signal is the server's
 * own registry (`active_run` on GET /v1/conversations/:id), not a guess from
 * message statuses — and polled with plain fetch rather than a WebDriver loop,
 * for the reason real-model-build.spec.ts documents: a headless tab left idle
 * in a long waitUntil can stop answering.
 */
export async function waitForRunDone(
  creds: Pick<Credentials, 'email' | 'password'>,
  conversationId: string,
  timeoutMs = 120_000,
): Promise<void> {
  const session = await apiToken(creds);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await fetch(`${BASE_URL}/v1/conversations/${conversationId}`, {
      headers: { authorization: `Bearer ${session}` },
    });
    if (!res.ok) throw new Error(`[e2e] GET conversation failed (${String(res.status)})`);
    const row = (await res.json()) as { active_run?: boolean };
    if (row.active_run === false) return;
    if (Date.now() > deadline) throw new Error(`[e2e] run on ${conversationId} did not finish in ${String(timeoutMs)}ms`);
    await new Promise((r) => setTimeout(r, 1_000));
  }
}

/**
 * Confirms the workspace chooser on "Empty workspace" — the same scratch
 * workspace an implicit send already creates, but explicit and observable for
 * a spec that wants to assert the chooser itself works, not just infer scratch
 * from the absence of a repo.
 */
export async function chooseScratchWorkspace(): Promise<void> {
  await tap('agent.workspace.button');
  await waitForVisible('agent.workspace.dialog');
  await tap('agent.workspace.source.scratch');
  await tap('agent.workspace.confirm');
}

/**
 * Drives the workspace chooser on the agent screen to a GitHub repo. Assumes
 * no run is active (the pill is only a control before the first message) and
 * that GitHub is connected. Returns the branch name the chooser generated, so
 * the caller can assert the clone landed on it.
 */
export async function chooseGithubWorkspace(repoId: number): Promise<string> {
  await tap('agent.workspace.button');
  await waitForVisible('agent.workspace.dialog');
  await tap('agent.workspace.source.github');
  await waitForVisible(`agent.workspace.repo.${String(repoId)}`);
  await tap(`agent.workspace.repo.${String(repoId)}`);
  await waitForVisible('agent.workspace.branchName');
  const branch = await byTestId('agent.workspace.branchName').getValue();
  await tap('agent.workspace.confirm');
  await waitForTextIn('agent.workspace.button', branch);
  return branch;
}

/**
 * Drives the workspace chooser to a folder on *this* machine. Desktop only:
 * the Local option is disabled everywhere else, and "choose a folder" opens
 * the OS dialog — which under test is stood in for by LOXAIC_E2E_PICK_DIR
 * (scripts/electron-env.ts), so the folder that appears is `dir`. Assumes
 * the desktop's executor has already connected (the spec waits for that).
 */
export async function chooseLocalWorkspace(
  dir: string,
  isolation: 'direct' | 'container' = 'direct',
): Promise<void> {
  await tap('agent.workspace.button');
  await waitForVisible('agent.workspace.dialog');
  await waitForVisible('agent.workspace.local');
  await tap('agent.workspace.local');
  await waitForVisible('agent.workspace.pickDirectory');
  await tap('agent.workspace.pickDirectory');
  // The chooser selects the folder itself once the server has heard of it.
  await waitForVisible(`agent.workspace.root.${encodeURIComponent(dir)}`);
  await waitForTextIn('agent.workspace.dialog', dir);
  // Only offered when that machine reports a container engine, so tapping it
  // is itself the assertion that the capability reached the chooser.
  if (isolation === 'container') await tap('agent.workspace.isolation.container');
  await tap('agent.workspace.confirm');
  // The pill shows the folder's name, not its whole path — a temp directory
  // spelled out in full would crowd the mode selector off the row.
  await waitForTextIn('agent.workspace.button', path.basename(dir));
}

/** Opens the agent Inspector panel (todos, changed files, git, context) and
 * waits for it to actually be on screen — the toggle only appears once a run
 * has started, which is what makes waiting for the panel itself, not just the
 * tap, matter here. */
export async function openInspector(): Promise<void> {
  await tap('agent.inspector.toggle');
  await waitForVisible('agent.inspector.panel');
}

/** Opens Settings and navigates to the GitHub connection screen. Waits for
 * either state the screen can load into — connected (`github.status`) or not
 * (`github.token`, the connect form) — since which one appears depends on
 * whether an earlier step in the same spec already connected. */
export async function openGithubSettings(timeout = 20_000): Promise<void> {
  await openSidebar();
  await tap('sidebar.settings');
  await tap('settings.nav.github');
  await browser.waitUntil(
    async () => (await isVisible('github.status')) || (await isVisible('github.token')),
    { timeout, interval: 300, timeoutMsg: `neither github.status nor github.token appeared within ${String(timeout)}ms` },
  );
}

/** Restores run concurrency to "follow the backend". Global server state, so
 * a spec that pins it must reset in an `after()` hook — the same rule the
 * sandbox settings carry, and for the same reason: every later spec inherits
 * whatever this one left. */
export async function resetInferenceSettings(): Promise<void> {
  const token = await apiToken(adminCreds());
  const res = await fetch(`${BASE_URL}/v1/admin/settings/inference`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ maxConcurrentRuns: null }),
  });
  if (!res.ok) {
    throw new Error(`[e2e] inference settings reset failed (${String(res.status)}): ${await res.text()}`);
  }
}

/** The caller's sandboxes, newest first — the same rows the Inspector reads. */
export async function listSandboxes(
  token: string,
  conversationId?: string,
): Promise<{ id: string; status: string; containerId: string; provider: string; reap_at: string | null }[]> {
  const query = conversationId ? `?conversation_id=${encodeURIComponent(conversationId)}` : '';
  const res = await fetch(`${BASE_URL}/v1/sandboxes${query}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`[e2e] listing sandboxes failed (${String(res.status)})`);
  return (await res.json()) as { id: string; status: string; containerId: string; provider: string; reap_at: string | null }[];
}

/** Runs a command inside a sandbox through the same API a client would use.
 * The pass/fail bar for anything about a workspace's *contents*: it reads what
 * is actually on disk rather than what the model said about it. */
export async function execInSandbox(
  token: string,
  sandboxId: string,
  command: string,
  workdir?: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const res = await fetch(`${BASE_URL}/v1/sandboxes/${sandboxId}/exec`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ command, ...(workdir ? { workdir } : {}) }),
  });
  if (!res.ok) throw new Error(`[e2e] exec failed (${String(res.status)}): ${await res.text()}`);
  return (await res.json()) as { exitCode: number; stdout: string; stderr: string };
}

/**
 * Restores the sandbox settings a spec changed, straight through the API
 * rather than the UI — so cleanup still runs (and still works) if the test
 * itself failed partway through a UI flow. Every sandbox spec must leave
 * this in an `after()` hook: mode/engine/network are global server state,
 * and a later spec file otherwise inherits whatever the previous one left.
 */
export async function resetSandboxSettings(): Promise<void> {
  const creds = adminCreds();
  // Never silent: mode is server-wide, so a reset that quietly no-ops after a
  // spec switched to host leaves every later spec running agent tool calls
  // unisolated on the host with nothing to indicate it. apiToken() throws.
  const token = await apiToken(creds);
  const res = await fetch(`${BASE_URL}/v1/admin/settings/sandbox`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    // Retention is reset too: a spec that pins a one-second idle stop to
    // force a pause would otherwise leave every later spec's sandbox being
    // stopped out from under it mid-run.
    body: JSON.stringify({
      mode: 'container',
      engine: 'auto',
      allowNetwork: false,
      idleStopMs: 4 * 60 * 60 * 1000,
      reapEnabled: true,
      reapAfterMs: 30 * 24 * 60 * 60 * 1000,
    }),
  });
  if (!res.ok) {
    throw new Error(
      `[e2e] sandbox settings reset failed (${String(res.status)}): ${await res.text()}`,
    );
  }
}
