/**
 * App-level steps shared by every spec, expressed in the product's own terms
 * ("sign in", "send a message") rather than in clicks. Specs read as behaviour;
 * anything platform- or layout-specific is absorbed here.
 */
import { browser } from '@wdio/globals';
import { byTestId, tap, typeInto, waitForTextIn, waitForVisible } from './selectors.ts';
import type { Credentials } from './auth.ts';

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
