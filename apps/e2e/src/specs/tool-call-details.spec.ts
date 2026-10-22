/**
 * A tool call can be seen in full, before and after it runs — #267.
 *
 * - The card's dropdown shows every argument while the call waits for
 *   approval (and says there is no result yet), then the result once it ran,
 *   fitted to it: the line height is real pixels on web, not 18 × the font
 *   size, and a long unbroken token wraps instead of running off the side.
 * - The agent's permission bar keeps one line of the call; its Details pulls
 *   up a sheet with the whole of it and the same answers.
 * - Chat's request is that sheet, opened by itself, which only an answer
 *   ends: a tap on the backdrop leaves it up. It waits for an overlay that
 *   is already open (Settings, or the composer's `+` on a phone) rather than
 *   stacking on it.
 * - A character that changes what is displayed (a right-to-left override)
 *   is shown as an escape, on the bar and in the sheet.
 *
 * The command is a scenario (fixtures/scenarios.json) longer than the bar's
 * line, ending in a marker only the full command contains.
 */
import { browser } from '@wdio/globals';
import { uniqueCreds } from '../helpers/auth.ts';
import { shot } from '../helpers/screenshot.ts';
import {
  closeKeyboard,
  isVisible,
  platform,
  scrollTo,
  tap,
  testIdSelector,
  waitForAbsent,
  waitForFreshText,
  waitForVisible,
} from '../helpers/selectors.ts';
import {
  TOOL_PROMPT,
  getToolCalls,
  goToSurface,
  closePlusMenu,
  listConversations,
  openPlusMenu,
  openSettings,
  sendInNewRun,
  sendMessage,
  signUp,
  startNewAgentRun,
  startNewThread,
  tapOverlayBackdrop,
  waitForRunDone,
} from '../helpers/app.ts';

const PROMPT = 'show the call in full';
/** The end of the scenario's 125-character command: past where the bar's
 * one line stops. */
const TAIL = 'echo tail-of-a-long-command-for-267';
const OUTPUT_TAIL = 'tail-of-a-long-command-for-267';
/** Its command ends in U+202E, which would show "exe.txt" reversed. */
const HIDDEN_PROMPT = 'show the hidden characters';
/** The mock waits eight seconds before asking: time to open Settings. */
const SLOW_TOOL_PROMPT = `take your time and ${TOOL_PROMPT}`;

describe('tool call details', () => {
  const creds = uniqueCreds();

  before(async () => {
    await signUp(creds);
  });

  it('shows the whole call on the card and in the Details sheet, then the result fitted to it', async function () {
    this.timeout(4 * 60_000);
    await goToSurface('agent');
    await startNewAgentRun();
    await tap('agent.mode.manual');
    const conversationId = await sendInNewRun(creds, PROMPT);
    await waitForVisible('agent.permission.bar', 60_000);

    let callId = '';
    await browser.waitUntil(
      async () => {
        callId = (await getToolCalls(creds, conversationId)).find((c) => c.tool === 'bash')?.call_id ?? '';
        return callId !== '';
      },
      { timeout: 20_000, timeoutMsg: 'the bash call was never stored' },
    );

    // The card, while the call waits: every argument, and no result yet.
    await scrollTo(`chat.toolCall.header.${callId}`);
    await tap(`chat.toolCall.header.${callId}`);
    await waitForFreshText(`chat.toolCall.arg.${callId}.command`, TAIL);
    await waitForFreshText(`chat.toolCall.pending.${callId}`, 'No result yet');
    await shot('tool-details-card-waiting');

    // The bar's Details: the whole command, and the answers under it.
    await tap('agent.permission.details');
    await waitForVisible('agent.permission.sheet.panel');
    await waitForFreshText('agent.permission.sheet.arg.command', TAIL);
    await shot('tool-details-sheet');
    await tap('agent.permission.sheet.allow');
    await waitForAbsent('agent.permission.sheet.panel');
    await waitForAbsent('agent.permission.bar');
    await waitForRunDone(creds, conversationId);

    // The same card, now with the result.
    await scrollTo(`chat.toolCall.resultText.${callId}`);
    await waitForFreshText(`chat.toolCall.resultText.${callId}`, OUTPUT_TAIL);
    expect(await isVisible(`chat.toolCall.pending.${callId}`)).toBe(false);

    const p = platform();
    if (p === 'web' || p === 'electron') {
      const fit = await browser.execute(
        (textSel: string, boxSel: string) => {
          const text = document.querySelector<HTMLElement>(textSel);
          const box = document.querySelector<HTMLElement>(boxSel);
          if (!text || !box) return null;
          return {
            lineHeight: getComputedStyle(text).lineHeight,
            textHeight: text.getBoundingClientRect().height,
            boxHeight: box.getBoundingClientRect().height,
            textOverflowsSideways: text.scrollWidth > text.clientWidth + 1,
            boxOverflowsSideways: box.scrollWidth > box.clientWidth + 1,
          };
        },
        testIdSelector(`chat.toolCall.resultText.${callId}`),
        testIdSelector(`chat.toolCall.result.${callId}`),
      );
      if (!fit) throw new Error('the result is not rendered');
      // Real pixels: a bare 18 on a web span is 18 × the font size.
      expect(fit.lineHeight).toBe('18px');
      // The box is the text's height, up to its cap — not a fixed box with
      // the text centred in it.
      expect(Math.abs(fit.boxHeight - Math.min(fit.textHeight, 200))).toBeLessThan(2);
      // The 400-character token wraps.
      expect(fit.textOverflowsSideways).toBe(false);
      expect(fit.boxOverflowsSideways).toBe(false);
    }
    await shot('tool-details-card-result');
  });

  it("puts chat's request in a sheet that only an answer ends", async function () {
    this.timeout(3 * 60_000);
    await goToSurface('chat');
    await sendMessage(TOOL_PROMPT);
    await waitForVisible('chat.approval.panel', 60_000);
    await waitForFreshText('chat.approval.arg.path', 'notes.txt');
    await waitForFreshText('chat.approval.arg.content', 'written by the mock agent');
    await shot('tool-details-chat-sheet');

    await tapOverlayBackdrop();
    await browser.pause(1_000);
    expect(await isVisible('chat.approval.panel')).toBe(true);
    expect(await isVisible('chat.approval.allowOnce')).toBe(true);

    await tap('chat.approval.allowOnce');
    await waitForAbsent('chat.approval.panel', 20_000);
  });

  it('shows a character that changes what is displayed as an escape', async function () {
    this.timeout(3 * 60_000);
    await goToSurface('agent');
    await startNewAgentRun();
    await tap('agent.mode.manual');
    await sendInNewRun(creds, HIDDEN_PROMPT);
    await waitForVisible('agent.permission.bar', 60_000);
    await waitForFreshText('agent.permission.summary', 'safe\\u202etxt.exe');
    await tap('agent.permission.details');
    await waitForFreshText('agent.permission.sheet.arg.command', 'echo safe\\u202etxt.exe');
    await shot('tool-details-hidden-character');
    await tap('agent.permission.sheet.deny');
    await waitForAbsent('agent.permission.bar');
  });

  it("holds chat's request while another overlay is open, then shows it", async function () {
    this.timeout(3 * 60_000);
    // Settings on a desktop. On a phone the mock's eight seconds go before
    // the sidebar and Settings are open, so the composer's `+` sheet stands
    // in: one tap, and held by the same gate.
    const desktop = platform() === 'web' || platform() === 'electron';
    // The running reply's counter keeps UiAutomator2 waiting for idle about
    // eleven seconds a query, longer than the mock's eight.
    if (platform() === 'android') await browser.updateSettings({ waitForIdleTimeout: 0 });
    try {
      await goToSurface('chat');
      // A send goes into the open thread: the case before left one open.
      await startNewThread('chat');
      const before = new Set((await listConversations(creds)).map((c) => c.id));
      await sendMessage(SLOW_TOOL_PROMPT);
      // A keyboard left up after the send can take the next tap.
      await closeKeyboard();
      const overlay = desktop ? 'settings.close' : 'composer.attach.library';
      if (desktop) await openSettings();
      else await openPlusMenu();
      await waitForVisible(overlay);

      // The request has arrived, and the call is stored, while the overlay is up.
      let conversationId = '';
      await browser.waitUntil(
        async () => {
          conversationId = (await listConversations(creds)).find((c) => c.kind === 'chat' && !before.has(c.id))?.id ?? '';
          return conversationId !== '' && (await getToolCalls(creds, conversationId)).some((c) => c.tool === 'fs_write');
        },
        { timeout: 60_000, timeoutMsg: 'the fs_write call never arrived' },
      );
      await browser.pause(1_500);
      expect(await isVisible('chat.approval.panel')).toBe(false);
      expect(await isVisible(overlay)).toBe(true);
      await shot('tool-details-chat-held-under-overlay');

      if (desktop) await tap('settings.close');
      else await closePlusMenu();
      await waitForVisible('chat.approval.panel', 20_000);
      await waitForFreshText('chat.approval.arg.path', 'notes.txt');
      await tap('chat.approval.reject');
      await waitForAbsent('chat.approval.panel', 20_000);
    } finally {
      if (platform() === 'android') await browser.updateSettings({ waitForIdleTimeout: 10_000 });
    }
  });
});
