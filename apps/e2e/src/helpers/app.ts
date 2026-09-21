/**
 * App-level steps shared by every spec, expressed in the product's own terms
 * ("sign in", "send a message") rather than in clicks. Specs read as behaviour;
 * anything platform- or layout-specific is absorbed here.
 */
import { browser } from '@wdio/globals';
import { byTestId, isVisible, platform, tap, typeInto, waitForGone, waitForTextIn, waitForVisible } from './selectors.ts';
import { adminCreds, apiToken, type Credentials } from './auth.ts';
import path from 'node:path';
import { BASE_URL } from '../../scripts/standup.ts';
import { rmSync } from 'node:fs';
import { selfContainedDataDir } from '../../scripts/electron-env.ts';

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
 * A slow prompt for which the mock also reports prompt-evaluation progress,
 * the way llama.cpp does with `return_progress`. Separate from SLOW_PROMPT so
 * the specs using that one keep seeing the estimate-only path. See
 * MOCK_PROGRESS_MATCH in apps/server/src/inference/provider.ts.
 */
export const PROGRESS_PROMPT = 'take a while and report your progress';

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

/**
 * Matches the `scenarios.json` fixture's check-in scenario: two `todo_write`
 * steps with *different* todos — ordinary progress, so nothing looks like a
 * loop and only the step budget can pause it. `todo_write` needs no sandbox
 * and no approval on either surface, which is what lets the same prompt drive
 * chat and agent alike.
 */
export const CHECKIN_SCENARIO_PROMPT = 'Plan the work, then check in after each step.';

/** Substring of the check-in scenario's wrap-up text, once both steps ran.
 * Case matters — `waitForTextIn` compares with `String.includes`. */
export const CHECKIN_SCENARIO_DONE = 'Planned it in two steps';

/**
 * Matches the `scenarios.json` fixture's loop scenario: four `todo_write`
 * steps with byte-identical arguments. The detector speaks at the third, well
 * inside any sane step budget — which is how a spec tells a loop check-in from
 * a budget one.
 */
export const LOOP_SCENARIO_PROMPT = 'Repeat yourself until someone stops you.';

/** What the mock answers with once it is told to stop using tools — the
 * evidence that "answer now" really did send `tool_choice: "none"`. */
export const ANSWER_NOW_TEXT = 'Answering now without tools';

/**
 * The instruction the server persists when a check-in is answered with
 * "answer now", as `CHECKIN_ANSWER_NUDGE` in `packages/types`.
 *
 * Copied rather than imported: this package deliberately has no workspace
 * dependencies and talks to the server over HTTP alone, the same way every
 * other mirrored string here does (MOCK_TOOL_DONE, the scenario wrap-ups). If
 * it drifts, the spec that reads it back fails — which is the point, because
 * that text is part of the conversation's replay and changing it silently
 * would break the prompt prefix for every existing thread.
 */
export const CHECKIN_ANSWER_NUDGE =
  'Please stop using tools and give your best final answer now from what you have so far.';

/** A prompt the mock provider answers with a `bash` tool call — the probe
 * used to check that a sandbox actually executes, in whichever mode is
 * currently configured (container or host). See MOCK_TOOL_TRIGGERS in
 * apps/server/src/inference/provider.ts. */
/** Calls `get_me` on the GitHub MCP server a GitHub connection sets up — see
 * MOCK_TOOL_TRIGGERS. `get_me` starts allowed, so it runs without an approval
 * prompt, and the harness's mock MCP server answers with this login only when
 * the connection's token reached it. */
export const GITHUB_MCP_PROMPT = 'github who am i';
export const GITHUB_MCP_LOGIN = 'e2e-bot';

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
      // Bounded, and allowed to miss. On a wide layout the sidebar is pinned
      // and `shell.menuButton` is never rendered at all, so this loop's only
      // real exit is the check above — and `tap`'s own wait is the config's
      // 20s, which is the whole outer budget. One attempt therefore consumed
      // every retry, and the helper failed with "menuButton still not
      // displayed" whenever the first check ran a moment too early: right
      // after a `browser.refresh()`, which is exactly where agent-checkin
      // uses it. Letting the tap miss keeps re-checking for the pinned
      // sidebar instead of committing to a button that will never appear.
      const menu = byTestId('shell.menuButton');
      const tapped = await menu
        .waitForDisplayed({ timeout: 2000 })
        .then(async () => {
          await menu.click();
          return true;
        }, () => false);
      if (!tapped) return false;
      return await byTestId('sidebar.signOut')
        .waitForDisplayed({ timeout: 3000 })
        .then(() => true, () => false);
    },
    { timeout: 20_000, interval: 250, timeoutMsg: 'sidebar did not open' },
  );
}

/** Opens the Settings modal from the sidebar. Leaves the caller on whatever
 * tab the modal opens to (its top level) — navigate on from there. */
export async function openSettings(): Promise<void> {
  await openSidebar();
  await tap('sidebar.settings');
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

/** What proves each surface has actually arrived. Chat and Agent both open on
 * a composer; Routines is a list and has never rendered one, so waiting for
 * `composer.input` there timed out rather than landing. */
const SURFACE_ANCHOR = {
  chat: 'composer.input',
  agent: 'composer.input',
  routines: 'routines.new',
  stats: 'composer.input',
} as const;

export async function goToSurface(surface: keyof typeof SURFACE_ANCHOR): Promise<void> {
  await openSidebar();
  await tap(`sidebar.nav.${surface}`);
  await waitForVisible(SURFACE_ANCHOR[surface]);
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
export async function openThreadList(surface: 'chat' | 'agent' | 'routineChat' = 'chat'): Promise<void> {
  // A routine's list has no new-chat button — its runs are what make its
  // chats — so the corner holds Run now instead, and that is what says the
  // list is open there.
  const anchor = surface === 'routineChat' ? 'threadList.runNow' : 'threadList.newChat';
  if (await byTestId(anchor).isDisplayed().catch(() => false)) return;
  await tap(`${surface}.threadList.toggle`);
  await waitForVisible(anchor);
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

// ── Routines ──────────────────────────────────────────────
//
// Seeded through the API rather than the UI wherever the spec is about
// something *else* — and on iOS, where the create form is a Modal overlay
// XCUITest cannot resolve testIDs inside (see delete-conversation.spec.ts).

export interface E2ERoutine {
  id: string;
  name: string;
  cron: string;
  prompt: string;
  model: string | null;
}

async function routineFetch(
  creds: Pick<Credentials, 'email' | 'password'>,
  path: string,
  init?: RequestInit,
): Promise<unknown> {
  const token = await apiToken(creds);
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, ...(init?.body ? { 'content-type': 'application/json' } : {}) },
  });
  if (!res.ok) {
    throw new Error(`[e2e] ${init?.method ?? 'GET'} ${path} failed (${String(res.status)}): ${await res.text()}`);
  }
  return res.json();
}

export async function createRoutine(
  creds: Pick<Credentials, 'email' | 'password'>,
  input: { name: string; cron?: string; prompt: string; model?: string | null },
): Promise<E2ERoutine> {
  return (await routineFetch(creds, '/v1/routines', {
    method: 'POST',
    // 04:00 on the 1st of January: valid, and far enough off that nothing
    // fires during a run — a spec that wants one starts it itself.
    body: JSON.stringify({ cron: '0 4 1 1 *', ...input }),
  })) as E2ERoutine;
}

export async function listRoutines(
  creds: Pick<Credentials, 'email' | 'password'>,
): Promise<E2ERoutine[]> {
  return (await routineFetch(creds, '/v1/routines')) as E2ERoutine[];
}

/** Starts a run and returns it — the row comes back `running`, so a caller
 * that wants the answer follows with `waitForRunDone`. */
export async function runRoutine(
  creds: Pick<Credentials, 'email' | 'password'>,
  id: string,
): Promise<{ id: string; conversationId: string; status: string }> {
  return (await routineFetch(creds, `/v1/routines/${id}/run`, { method: 'POST' })) as {
    id: string;
    conversationId: string;
    status: string;
  };
}

export async function listRoutineConversations(
  creds: Pick<Credentials, 'email' | 'password'>,
  id: string,
): Promise<{ id: string; title: string; run: { status: string } }[]> {
  return (await routineFetch(creds, `/v1/routines/${id}/conversations`)) as {
    id: string;
    title: string;
    run: { status: string };
  }[];
}

/** The model each assistant message was answered on — how a spec proves a
 * routine ran on the model it was given and not on something else. */
export async function assistantModels(
  creds: Pick<Credentials, 'email' | 'password'>,
  conversationId: string,
): Promise<string[]> {
  const token = await apiToken(creds);
  const res = await fetch(`${BASE_URL}/v1/conversations/${conversationId}/messages`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`[e2e] GET messages failed (${String(res.status)})`);
  const body = (await res.json()) as { messages: { authorType: string; model: string | null }[] };
  return body.messages.filter((m) => m.authorType === 'assistant').map((m) => m.model ?? '');
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

/**
 * The tool results a conversation has *stored*, straight from the API.
 *
 * Deliberately not "what the card shows": a call's verdict rides the live
 * stream as an event, so a spec watching only the rendered card during a run
 * cannot tell a verdict that was persisted from one that was merely
 * broadcast. These are the blocks a reopened thread is rebuilt from, and
 * `ok` was absent from them until failures started surviving a reload.
 */
export async function getToolResults(
  creds: Pick<Credentials, 'email' | 'password'>,
  conversationId: string,
): Promise<{ call_id: string; output: string; ok?: boolean }[]> {
  const token = await apiToken(creds);
  const res = await fetch(`${BASE_URL}/v1/conversations/${conversationId}/messages`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`[e2e] getting tool results failed (${String(res.status)})`);
  const body = (await res.json()) as {
    messages: { content: { kind: string; call_id?: string; output?: string; ok?: boolean }[] }[];
  };
  return body.messages.flatMap((m) =>
    m.content
      .filter((b) => b.kind === 'tool_result')
      .map((b) => ({ call_id: b.call_id ?? '', output: b.output ?? '', ok: b.ok })),
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

/**
 * Patches a user's own prefs straight through the API.
 *
 * The settings screen offers presets (20/50/100/200), and a spec that wants to
 * *see* a check-in cannot wait for twenty real tool calls — so the cadence it
 * needs is set here rather than clicked. Per-user, so it takes that user's own
 * session rather than the admin's, unlike patchSandboxSettings above.
 */
export async function patchPrefs(
  creds: Pick<Credentials, 'email' | 'password'>,
  patch: Record<string, unknown>,
): Promise<void> {
  const token = await apiToken(creds);
  const res = await fetch(`${BASE_URL}/v1/prefs`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    throw new Error(`[e2e] prefs patch failed (${String(res.status)}): ${await res.text()}`);
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
  // The modal is still mounted while its exit animation runs, and its
  // backdrop covers the screen for that window — so a tap issued straight
  // after confirm (the mode selector, in agent-new-project) could land on
  // the backdrop and be lost, which then presented as a four-minute scenario
  // timeout in manual mode. Its siblings wait on the pill; this waits on
  // the dialog itself.
  await waitForGone('agent.workspace.dialog');
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

/**
 * Opens the MCP Servers screen from the sidebar, on any layout.
 *
 * Waits on the header's Add control, because it is the one element common to
 * all three of the screen's branches — loading, empty, and populated.
 *
 * Deliberately not `mcp.list`: that would work today but for the wrong reason.
 * `mcp.tsx` builds its rows as unconfigured catalogue entries *followed by*
 * servers, and `BUILTIN_CATALOG` always holds the Brave Search entry — so a
 * brand-new account has one row, the list renders, and the empty state is
 * never reached. The catalogue lives *inside* the list, not in its place. Key
 * a future catalogue assertion on `mcp.list` accordingly; the genuinely-empty
 * branch only appears if that catalogue is ever emptied.
 */
export async function openMcpServers(): Promise<void> {
  await openSidebar();
  await tap('sidebar.nav.mcp');
  await waitForVisible('mcp.addServer');
}

/**
 * The caller's MCP servers, straight from the API.
 *
 * The encrypted blob never comes back — the route strips `secrets` and
 * reports `secretKeys` in its place. That is what makes this the right probe
 * for *where* a credential landed, rather than merely whether one saved: a
 * key under `secretKeys` went through encryptSecrets, while a value still in
 * `env` is sitting in the clear. The screen cannot show that difference, and
 * it is the whole distinction the Secrets field exists to draw.
 */
export async function listMcpServers(
  creds: Pick<Credentials, 'email' | 'password'>,
): Promise<{ id: string; name: string; builtinKey: string | null; env: Record<string, string> | null; secretKeys: string[] }[]> {
  const token = await apiToken(creds);
  const res = await fetch(`${BASE_URL}/v1/mcp/servers`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`[e2e] listing MCP servers failed (${String(res.status)})`);
  return (await res.json()) as {
    id: string;
    name: string;
    builtinKey: string | null;
    env: Record<string, string> | null;
    secretKeys: string[];
  }[];
}

// ── Desktop instance bridge (Electron, self-contained runs) ─────────────

/** State the main process reports — the same shape preload.cjs exposes. One
 * definition, shared by every spec that drives the bridge, so a change to the
 * shape has one place to land instead of diverging copies. */
export interface InstanceState {
  mode: string | null;
  storedMode: string | null;
  apiBaseUrl: string | null;
  needsOnboarding: boolean;
  defaultHostName: string;
  defaultPort: number;
  host: { name: string; port: number; bind: string; advertiseUrl: string | null } | null;
  listenPort: number | null;
  error?: string;
}

export async function instanceState(): Promise<InstanceState | null> {
  return browser.execute(async () => {
    const bridge = (window as unknown as {
      loxaic?: { instance?: { getState: () => Promise<InstanceState> } };
    }).loxaic;
    return (await bridge?.instance?.getState()) ?? null;
  });
}

export async function probeEngine(): Promise<{ ok: boolean }> {
  return browser.execute(async () => {
    const bridge = (window as unknown as {
      loxaic?: { instance?: { probeEngine: () => Promise<{ ok: boolean }> } };
    }).loxaic;
    return (await bridge?.instance?.probeEngine()) ?? { ok: false };
  });
}

export async function setMode(config: unknown): Promise<void> {
  await browser.execute(async (input: unknown) => {
    const bridge = (window as unknown as {
      loxaic?: { instance?: { setMode: (config: unknown) => Promise<unknown> } };
    }).loxaic;
    await bridge?.instance?.setMode(input);
  }, config);
}

/**
 * Returns the app to a genuine first run: drop the stored config and ask the
 * main process to forget its stack. Whatever "back to a first run" has to do
 * lives here once — a future extra step (clearing an endpoint override, say)
 * must not have to be found in every spec that needs it.
 */
export async function returnToOnboarding(): Promise<void> {
  rmSync(path.join(selfContainedDataDir ?? '', 'config.json'), { force: true });
  await browser.execute(async () => {
    const bridge = (window as unknown as {
      loxaic?: { instance?: { detach: () => Promise<unknown> } };
    }).loxaic;
    await bridge?.instance?.detach();
  });
  await browser.url('app://-/onboarding');
}

// ── Model providers ─────────────────────────────────────────────

/**
 * Opens the Model Providers screen through Settings.
 *
 * Admin-only, unlike `openSandboxSettings`: the nav row is not rendered for
 * anyone else, so a non-admin has to be checked by asking the route directly
 * (see `providerListStatus`) rather than by navigating here and reading the
 * screen. Waits on the built-in card, which is the one element present in
 * every branch — it is described even when no provider has been added.
 */
export async function openProviders(): Promise<void> {
  await openSidebar();
  await tap('sidebar.settings');
  await tap('settings.nav.providers');
  await waitForVisible('providers.builtin');
}

/**
 * What the provider list route answers for these credentials.
 *
 * Hiding the nav row is presentation; `requireAdmin` on the route is the
 * boundary, and only a direct call can tell the two apart.
 */
export async function providerListStatus(
  creds: Pick<Credentials, 'email' | 'password'>,
): Promise<number> {
  const token = await apiToken(creds);
  const res = await fetch(`${BASE_URL}/v1/admin/providers`, {
    headers: { authorization: `Bearer ${token}` },
  });
  return res.status;
}

/**
 * The providers as the API describes them — never the API key, which no route
 * returns. `hasApiKey` is the whole of what a client is told, which makes this
 * the right probe for whether a key was stored at all.
 */
export async function listProviders(): Promise<
  { id: string; name: string; slug: string; hasApiKey: boolean; baseUrl: string }[]
> {
  const token = await apiToken(adminCreds());
  const res = await fetch(`${BASE_URL}/v1/admin/providers`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`[e2e] listing providers failed (${String(res.status)})`);
  const body = (await res.json()) as {
    providers: { id: string; name: string; slug: string; hasApiKey: boolean; baseUrl: string }[];
  };
  return body.providers;
}

/**
 * Removes every provider row this run created.
 *
 * Provider rows are deployment-wide and the database is shared, so this is
 * scoped by base URL to the mock this run started — never "delete them all",
 * which would take another suite's rows out from under it.
 */
export async function deleteProvidersWithBaseUrl(baseUrl: string): Promise<void> {
  const token = await apiToken(adminCreds());
  for (const provider of await listProviders()) {
    if (provider.baseUrl !== baseUrl) continue;
    await fetch(`${BASE_URL}/v1/admin/providers/${provider.id}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}` },
    });
  }
}

/** What the mock provider actually received — the bearer it was sent and the
 * model id it was asked for. The `slug::` prefix is ours and must never
 * appear here. */
export async function mockProviderRequests(
  apiBase: string,
): Promise<{ path: string; authorization: string | null; model: string | null }[]> {
  const origin = new URL(apiBase).origin;
  const res = await fetch(`${origin}/__e2e/requests`);
  if (!res.ok) throw new Error(`[e2e] reading mock provider requests failed (${String(res.status)})`);
  return (await res.json()) as { path: string; authorization: string | null; model: string | null }[];
}

/**
 * Strips a conversation's stored model, leaving it as every thread from before
 * `model_pref` was written looks: an id, a history, and no model of its own.
 *
 * This client always records a model on a conversation's first send, so that
 * state cannot be reached through the UI — and it is exactly the state in which
 * "open on the last model used anywhere" would move an old thread onto a
 * different, possibly paid, backend.
 */
export async function clearConversationModel(
  creds: Pick<Credentials, 'email' | 'password'>,
  conversationId: string,
): Promise<void> {
  const token = await apiToken(creds);
  const res = await fetch(`${BASE_URL}/v1/conversations/${conversationId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ model_pref: {} }),
  });
  if (!res.ok) throw new Error(`[e2e] clearing the conversation's model failed (${String(res.status)})`);
}
