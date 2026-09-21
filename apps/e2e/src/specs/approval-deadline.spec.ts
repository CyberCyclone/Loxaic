/**
 * A tool approval says what happens if nobody answers, and when — on both
 * surfaces, and somewhere the person can actually get to.
 *
 * The chat dialog is the case that needs care. Its body is height-capped, and
 * the vendored ModalBody does not scroll unless told to — so the countdown,
 * the last row in it, is the first thing pushed below a fold nothing can
 * reach. WebDriver calls such an element "displayed", so this asserts
 * reachability (a scrolling ancestor, then a bounding-rect check), the same
 * way mcp-servers.spec.ts and checkin-settings.spec.ts do. Found in review of
 * #198, which added the row without the scroll.
 */
import { browser } from '@wdio/globals';
import { uniqueCreds } from '../helpers/auth.ts';
import { shot } from '../helpers/screenshot.ts';
import { platform, tap, testIdSelector, waitForGone, waitForTextIn, waitForVisible } from '../helpers/selectors.ts';
import { TOOL_PROMPT, goToSurface, sendMessage, signUp, startNewAgentRun } from '../helpers/app.ts';

const WONT_RUN = "this call won't run";

describe('a tool approval shows its deadline', () => {
  const creds = uniqueCreds();

  before(async () => {
    await signUp(creds);
  });

  it("on the agent's permission bar", async function () {
    this.timeout(2 * 60_000);
    await goToSurface('agent');
    await startNewAgentRun();
    await tap('agent.mode.manual');
    await sendMessage(TOOL_PROMPT);
    await waitForVisible('agent.permission.bar');
    await waitForTextIn('agent.permission.deadline', WONT_RUN);
    await shot('approval-deadline-agent');
    await tap('agent.permission.deny');
    await waitForGone('agent.permission.bar');
  });

  it("in chat's approval dialog, reachable on a short window", async function () {
    this.timeout(2 * 60_000);
    // Overlay testIDs are not visible to the iOS driver (a known harness
    // limit), and window sizing is a browser notion.
    const p = platform();
    if (p !== 'web' && p !== 'electron') this.skip();

    await goToSurface('chat');
    await sendMessage(TOOL_PROMPT);
    await waitForVisible('chat.approval.dialog', 60_000);
    await waitForTextIn('chat.approval.deadline', WONT_RUN);
    await shot('approval-deadline-chat');

    const before = await browser.getWindowSize();
    try {
      // Stepped down rather than fixed: how tall the dialog is depends on the
      // call being approved, and a window it still fits in proves nothing.
      let verdict = { found: false, overflowing: false, scrollable: false, inView: false };
      for (const height of [420, 340, 280]) {
        await browser.setWindowSize(before.width, height);
        verdict = await browser.execute((selector: string) => {
          const el = document.querySelector<HTMLElement>(selector);
          if (!el) return { found: false, overflowing: false, scrollable: false, inView: false };
          let node = el.parentElement;
          let overflowing = false;
          let scrollable = false;
          while (node) {
            if (node.scrollHeight > node.clientHeight) overflowing = true;
            const overflow = getComputedStyle(node).overflowY;
            if ((overflow === 'auto' || overflow === 'scroll') && node.scrollHeight > node.clientHeight) {
              scrollable = true;
              break;
            }
            node = node.parentElement;
          }
          el.scrollIntoView({ block: 'nearest' });
          const r = el.getBoundingClientRect();
          return { found: true, overflowing, scrollable, inView: r.top >= 0 && r.bottom <= window.innerHeight };
        }, testIdSelector('chat.approval.deadline'));
        if (!verdict.found || verdict.overflowing) break;
      }

      if (!verdict.found) throw new Error('the approval countdown is not rendered');
      if (!verdict.overflowing) throw new Error('no window was short enough to put the countdown past the fold');
      if (!verdict.scrollable) throw new Error('the countdown is past the fold with nothing able to scroll to it');
      if (!verdict.inView) throw new Error('the countdown could not be brought into view');
      await shot('approval-deadline-chat-scrolled');
    } finally {
      await browser.setWindowSize(before.width, before.height);
    }

    await tap('chat.approval.reject');
    await waitForGone('chat.approval.dialog');
  });
});
