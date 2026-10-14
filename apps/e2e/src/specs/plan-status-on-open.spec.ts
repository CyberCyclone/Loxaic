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
 *
 * The second case is the page failing outright (found in review): the thread
 * then holds only the planning run's replay, the plan reads as pending, and a
 * panel that opened by itself offered Accept on a plan already accepted —
 * with nothing ever fetching the page again. It must not open; the bar may
 * offer the plan, and selecting the thread again fetches the page.
 */
import { browser } from '@wdio/globals';
import { type Credentials, uniqueCreds } from '../helpers/auth.ts';
import { shot } from '../helpers/screenshot.ts';
import { byTestId, platform, tap, waitForGone, waitForTextIn, waitForVisible } from '../helpers/selectors.ts';
import {
  chooseScratchWorkspace,
  getMessageTexts,
  goToSurface,
  listConversations,
  selectThread,
  sendMessage,
  signUp,
  startNewThread,
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
 *
 * `failPage` answers the first newest-page request with a 500 instead of
 * holding it, and drops the replay of the run that answered the plan, so that
 * run is in no page and no snapshot — what a thread whose answer is older
 * than its last three runs looks like after a failed fetch. Later requests
 * go through.
 */
async function holdArrivals(opts: { failPage?: boolean } = {}): Promise<void> {
  await browser.execute(
    (pageHoldMs: number, openHoldMs: number, accepted: string, fail: boolean) => {
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
          if (fail && !log.order.includes('page:failed')) {
            log.order.push('page:failed');
            return new Response(JSON.stringify({ error: 'held back by the test' }), {
              status: 500,
              headers: { 'content-type': 'application/json' },
            });
          }
          if (fail) {
            log.order.push('page');
            return realFetch(input, init);
          }
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
                if (data.includes(accepted) && fail) {
                  log.order.push('sync:accept:dropped');
                  return;
                }
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
    opts.failPage ?? false,
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

/** A new planning run, its plan accepted and the run that started finished.
 * Returns the conversation's id. */
async function planAndAccept(creds: Credentials): Promise<string> {
  await goToSurface('agent');
  // The screen opens on the newest thread once there is one.
  await startNewThread('agent');
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
  return conversation.id;
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

    await planAndAccept(creds);

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
    await tap('agent.plan.close');
    await waitForGone('agent.plan.panel');
  });

  it('does not open the panel on a plan it could not judge, and fetches again on reselect', async function () {
    this.timeout(4 * 60_000);
    const p = platform();
    if (p !== 'web' && p !== 'electron') this.skip();

    const conversationId = await planAndAccept(creds);

    await goToSurface('chat');
    await holdArrivals({ failPage: true });
    await goToSurface('agent');
    await browser.waitUntil(
      async () => {
        const { order } = await arrivals();
        return order.includes('page:failed') && order.includes('sync:plan') && order.includes('sync:accept:dropped');
      },
      { timeout: 30_000, interval: 250, timeoutMsg: 'the page did not fail with only the planning run replayed' },
    );
    // Let anything the replay sets off render.
    await browser.pause(1_000);

    // All the thread holds is the plan with nothing after it, so the client
    // reads it as pending. Opening the panel on that offered Accept on an
    // accepted plan; the bar is the most it may do.
    if (await byTestId('agent.plan.panel').isDisplayed().catch(() => false)) {
      throw new Error('the panel opened on a plan whose history never loaded');
    }
    await waitForVisible('agent.plan.bar');
    await shot('plan-bar-after-failed-history');

    // Selecting the thread again fetches the page this time.
    await selectThread(conversationId, 'agent');
    await browser.waitUntil(async () => (await arrivals()).order.includes('page'), {
      timeout: 15_000,
      interval: 250,
      timeoutMsg: 'selecting the thread again did not fetch its history',
    });
    await waitForGone('agent.plan.bar');
    await browser.waitUntil(acceptFollowsPlan, {
      timeout: 15_000,
      interval: 250,
      timeoutMsg: 'the thread does not show the accept below the plan after the refetch',
    });
    if (await byTestId('agent.plan.panel').isDisplayed().catch(() => false)) {
      throw new Error('the panel opened on an accepted plan after the refetch');
    }
    await shot('plan-accepted-after-refetch');
  });
});
