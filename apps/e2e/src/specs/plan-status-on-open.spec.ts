/**
 * An accepted plan stays accepted when its thread is opened while the socket
 * is still connecting.
 *
 * Found on the beta (#281's thread): a planning run, Accept, then a long
 * implementation run. Reopened the next morning, the thread ended with the
 * plan below everything, offering Accept again — which would have sent
 * "Go ahead and implement it" a second time.
 *
 * The order of arrival is what did it. Opening the Agent screen fetches the
 * thread's newest page while the socket opens and resubscribes the thread, and
 * the server replays its last three runs. The planning run is small, so its
 * replay landed first; the page (the accept and the long run) landed after it
 * and was put in front of whatever was loaded, as if that were always newer.
 * The plan was then the last thing in the thread, with no reply after it, so
 * it read as undecided. History is now merged in by position.
 *
 * Here the same order is forced in the page, rather than left to the sizes of
 * two runs: the socket's `open` is held until the thread has been chosen (so
 * the resubscribe races the fetch, as at a cold start), the newest page is
 * held a few seconds, and the replay of the run that answered the plan is held
 * until the page is in. Web and Electron only: the stubs are the page's own
 * `fetch` and `WebSocket`, and the merge they exercise is the same code on a
 * phone (`lib/historyPages.ts`, unit-tested for this order).
 */
import { browser } from '@wdio/globals';
import { uniqueCreds } from '../helpers/auth.ts';
import { shot } from '../helpers/screenshot.ts';
import { byTestId, platform, tap, waitForGone, waitForTextIn, waitForVisible } from '../helpers/selectors.ts';
import {
  chooseScratchWorkspace,
  getMessageTexts,
  goToSurface,
  listConversations,
  sendMessage,
  signUp,
  waitForRunDone,
} from '../helpers/app.ts';

/** The mock answers this with a `propose_plan` call in planning mode. */
const PLAN_PROMPT = 'Look around, then propose a plan.';
/** Mirrors PLAN_ACCEPTED_MESSAGE in @loxaic/types. */
const ACCEPTED = 'I accept this plan. Go ahead and implement it.';
/** How long the newest page is held: well past the socket's open. */
const PAGE_HOLD_MS = 3_000;
/** How long the socket's `open` is held: past the conversation list, so the
 * thread is chosen before the resubscribe, and well inside PAGE_HOLD_MS. */
const OPEN_HOLD_MS = 1_000;

interface ArrivalLog {
  order: string[];
  acceptSynced: boolean;
}

/**
 * Installs the hold on the page's `fetch` and `WebSocket`. Only sockets made
 * from here on are affected — the Agent screen's, once it mounts again.
 */
async function holdArrivals(): Promise<void> {
  await browser.execute(
    (pageHoldMs: number, openHoldMs: number, accepted: string) => {
      const w = window as unknown as {
        __planOrder: { order: string[]; acceptSynced: boolean };
        __realFetch?: typeof fetch;
        __RealWebSocket?: typeof WebSocket;
      };
      w.__planOrder = { order: [], acceptSynced: false };
      const log = w.__planOrder;
      w.__realFetch ??= window.fetch.bind(window);
      w.__RealWebSocket ??= window.WebSocket;
      const realFetch = w.__realFetch;
      const RealWebSocket = w.__RealWebSocket;

      let pageLanded!: () => void;
      const pageIn = new Promise<void>((r) => (pageLanded = r));

      window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        // The newest page only: a page back carries `before`.
        if (/\/v1\/conversations\/[^/]+\/messages(\?|$)/.test(url) && !url.includes('before=')) {
          await new Promise((r) => setTimeout(r, pageHoldMs));
          const res = await realFetch(input, init);
          log.order.push('page');
          // Applied in the same task as the response is read, so one more
          // turn of the loop before the held replay goes in.
          setTimeout(pageLanded, 300);
          return res;
        }
        return realFetch(input, init);
      };

      class Held extends RealWebSocket {
        set onopen(handler: ((this: WebSocket, ev: Event) => unknown) | null) {
          super.onopen = handler ? (ev: Event) => { setTimeout(() => handler.call(this, ev), openHoldMs); } : null;
        }
        get onopen() {
          return super.onopen;
        }
        set onmessage(handler: ((this: WebSocket, ev: MessageEvent) => unknown) | null) {
          super.onmessage = handler
            ? (ev: MessageEvent) => {
                const data = typeof ev.data === 'string' ? ev.data : '';
                if (!data.includes('"stream.sync"')) return handler.call(this, ev);
                if (data.includes(accepted)) {
                  // The run that answered the plan: after the page, as the
                  // long run's replay did on the beta.
                  void pageIn.then(() => {
                    log.order.push('sync:accept');
                    handler.call(this, ev);
                    log.acceptSynced = true;
                  });
                  return;
                }
                if (data.includes('propose_plan')) log.order.push('sync:plan');
                return handler.call(this, ev);
              }
            : null;
        }
        get onmessage() {
          return super.onmessage;
        }
      }
      window.WebSocket = Held;
    },
    PAGE_HOLD_MS,
    OPEN_HOLD_MS,
    ACCEPTED,
  );
}

async function releaseArrivals(): Promise<void> {
  await browser.execute(() => {
    const w = window as unknown as { __realFetch?: typeof fetch; __RealWebSocket?: typeof WebSocket };
    if (w.__realFetch) window.fetch = w.__realFetch;
    if (w.__RealWebSocket) window.WebSocket = w.__RealWebSocket;
  });
}

/**
 * Whether the message list's text holds the accept, *after* the plan.
 * `innerText` rather than WebDriver's getText, which leaves out a message
 * scrolled just out of the list's view — the accept usually is, with the run
 * it started below it. The list is inverted, so DOM order is not reading
 * order; each message's place on screen is.
 */
async function acceptFollowsPlan(): Promise<boolean> {
  return browser.execute((accepted: string) => {
    const list = document.querySelector('[data-testid="chat.messageList"]');
    if (!list) return false;
    const top = (text: string): number | null => {
      const walker = document.createTreeWalker(list, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (n.textContent?.includes(text) && n.parentElement) return n.parentElement.getBoundingClientRect().top;
      }
      return null;
    };
    const plan = top('Proposed plan');
    const accept = top(accepted);
    return plan !== null && accept !== null && plan < accept;
  }, ACCEPTED);
}

async function arrivals(): Promise<ArrivalLog> {
  return browser.execute(
    () => (window as unknown as { __planOrder: { order: string[]; acceptSynced: boolean } }).__planOrder,
  );
}

describe('an accepted plan, when its thread is opened mid-connect', () => {
  const creds = uniqueCreds();

  before(async () => {
    await signUp(creds);
  });

  afterEach(async () => {
    await releaseArrivals().catch(() => undefined);
  });

  it('stays accepted when the planning run is replayed before the newest page', async function () {
    this.timeout(4 * 60_000);
    const p = platform();
    if (p !== 'web' && p !== 'electron') this.skip();

    await goToSurface('agent');
    await chooseScratchWorkspace();
    await tap('agent.mode.planning');
    await sendMessage(PLAN_PROMPT);
    await waitForVisible('agent.plan.panel', 90_000);
    const [conversation] = await listConversations(creds);
    await waitForRunDone(creds, conversation.id);

    // Accepted in Auto, so the run it starts asks nothing.
    await tap('agent.plan.accept.more');
    await waitForVisible('agent.plan.accept.menu');
    await tap('agent.plan.accept.auto');
    await waitForGone('agent.plan.panel');
    await waitForRunDone(creds, conversation.id);
    const texts = await getMessageTexts(creds, conversation.id);
    if (!texts.includes(ACCEPTED)) throw new Error(`the acceptance was not sent: ${JSON.stringify(texts)}`);

    // Away and back: the Agent screen mounts again, picks the newest thread
    // and fetches its page while its new socket opens.
    await goToSurface('chat');
    await holdArrivals();
    await goToSurface('agent');
    await browser.waitUntil(async () => (await arrivals()).acceptSynced, {
      timeout: 30_000,
      interval: 250,
      timeoutMsg: 'the run that answered the plan was never replayed',
    });
    const { order } = await arrivals();
    // The case only means something if the planning run really came first.
    const plan = order.indexOf('sync:plan');
    if (!(plan >= 0 && plan < order.indexOf('page') && order.indexOf('page') < order.indexOf('sync:accept'))) {
      throw new Error(`the arrivals were not forced into the beta's order: ${order.join(', ')}`);
    }
    // Let anything the last replay sets off render.
    await browser.pause(1_000);

    // Undecided, the plan would open its panel by itself and keep a bar.
    if (await byTestId('agent.plan.panel').isDisplayed().catch(() => false)) {
      throw new Error('the accepted plan opened its panel again, as if nobody had decided');
    }
    if (await byTestId('agent.plan.bar').isDisplayed().catch(() => false)) {
      throw new Error('the accepted plan is offered for review again');
    }
    await browser.waitUntil(acceptFollowsPlan, {
      timeout: 15_000,
      interval: 250,
      timeoutMsg: 'the thread does not show the accept below the plan',
    });
    await shot('plan-accepted-after-mid-connect-open');
    await tap('agent.header.menu');
    await tap('agent.header.viewPlan');
    await waitForTextIn('agent.plan.status', 'accepted');
    await shot('plan-panel-accepted-after-mid-connect-open');
  });
});
