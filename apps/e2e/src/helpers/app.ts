/**
 * App-level steps shared by every spec, expressed in the product's own terms
 * ("sign in", "send a message") rather than in clicks. Specs read as behaviour;
 * anything platform- or layout-specific is absorbed here.
 */
import { browser } from '@wdio/globals';
import { byTestId, tap, typeInto, waitForTextIn, waitForVisible } from './selectors.ts';
import { adminCreds, apiToken, type Credentials } from './auth.ts';
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

/** A prompt the mock provider answers with a `bash` tool call — the probe
 * used to check that a sandbox actually executes, in whichever mode is
 * currently configured (container or host). See MOCK_TOOL_TRIGGERS in
 * apps/server/src/inference/provider.ts. */
export const BASH_PROMPT = 'run a bash command';

/** Substring of the bash trigger's stdout, echoed back inside the mock's
 * `[Mock] Done. The tool returned: …` wrap-up once the tool call resolves. */
export const MOCK_BASH_OUTPUT = 'hello from the sandbox';

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

export async function signUp(creds: Credentials): Promise<void> {
  await waitForVisible('login.submit');
  await tap('login.toggleMode'); // sign-in is the default mode
  await waitForVisible('login.name');
  await typeInto('login.name', creds.name);
  await typeInto('login.email', creds.email);
  await typeInto('login.password', creds.password);
  await tap('login.submit');
  await waitForVisible('composer.input');
}

export async function signIn(creds: Credentials): Promise<void> {
  await waitForVisible('login.submit');
  await typeInto('login.email', creds.email);
  await typeInto('login.password', creds.password);
  await tap('login.submit');
  await waitForVisible('composer.input');
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
 * Starts a new agent run, on any layout.
 *
 * The thread list is pinned open only at >=1024px; narrower, it is an overlay
 * behind a toggle — so tapping its "new" button directly works on a desktop
 * browser and times out on a phone. Mirrors openSidebar()'s approach of
 * deciding from what is actually on screen rather than from a breakpoint the
 * spec would have to know.
 */
export async function startNewAgentRun(): Promise<void> {
  if (!(await byTestId('threadList.newChat').isDisplayed().catch(() => false))) {
    await tap('agent.threadList.toggle');
    await waitForVisible('threadList.newChat');
  }
  await tap('threadList.newChat');
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
    body: JSON.stringify({ mode: 'container', engine: 'auto', allowNetwork: false }),
  });
  if (!res.ok) {
    throw new Error(
      `[e2e] sandbox settings reset failed (${String(res.status)}): ${await res.text()}`,
    );
  }
}
