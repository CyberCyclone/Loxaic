/**
 * A compaction this device did not start — the shape of an automatic one,
 * which the server begins by itself after a turn — as the page watching the
 * conversation sees it.
 *
 * On the beta this was a card that read "Compacting…" with a free-looking
 * composer and no Stop, which then turned into the chat's typing indicator
 * minutes in ("Compacting… 84s", six minutes after it began) whenever a
 * resync finally told the device the run was going. The run is started here
 * from a second connection, as another device would, and slowed with the
 * mock's "take your time" (a compaction's guidance rides in its prompt).
 */
import { browser } from '@wdio/globals';
import { apiToken, provisionUser, uniqueCreds } from '../helpers/auth.ts';
import { BASE_URL } from '../../scripts/standup.ts';
import { shot } from '../helpers/screenshot.ts';
import { isVisible, platform, waitForTextIn, waitForVisible } from '../helpers/selectors.ts';
import {
  listConversations,
  mockEcho,
  selectThread,
  sendAndAwaitReply,
  signIn,
  startNewThread,
  waitForComposerReady,
} from '../helpers/app.ts';

/** Starts `/compact` on a conversation from a connection of its own. */
async function compactFromElsewhere(token: string, conversationId: string, args: string): Promise<WebSocket> {
  const ws = new WebSocket(`${BASE_URL.replace(/^http/, 'ws')}/ws/chat?token=${encodeURIComponent(token)}`);
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => { resolve(); });
    ws.addEventListener('error', () => { reject(new Error('[e2e] second connection failed to open')); });
  });
  ws.send(JSON.stringify({ type: 'command.run', command: 'compact', conversation_id: conversationId, args }));
  return ws;
}

const APP_ID = 'com.loxaic.app';

/** A fresh start with a fresh socket — a reload on the web and Electron, a
 * cold start on a phone. Opens on the newest conversation. */
async function relaunch(): Promise<void> {
  if (platform() === 'web' || platform() === 'electron') {
    await browser.refresh();
  } else {
    const app = platform() === 'ios' ? { bundleId: APP_ID } : { appId: APP_ID };
    await browser.execute('mobile: terminateApp', app);
    await browser.execute('mobile: activateApp', app);
  }
  await waitForComposerReady(60_000);
}

async function expectLiveThenLanded(name: string): Promise<void> {
  // Known to be running at once — not minutes later on some resync.
  await waitForTextIn('chat.compaction.live', 'Compacting…', 15_000);
  await waitForVisible('composer.stop', 15_000);
  // The card is the compaction's only face: no typing indicator beside
  // or instead of it.
  expect(await isVisible('chat.status')).toBe(false);
  await shot(`${name}-live-card`);

  await waitForTextIn('chat.messageList', 'Compacted', 60_000);
  expect(await isVisible('chat.compaction.live')).toBe(false);
  await shot(`${name}-landed`);
}

describe('a compaction started elsewhere', () => {
  const creds = uniqueCreds();

  before(async function () {
    this.timeout(60_000);
    await provisionUser(creds);
    await signIn(creds);
    // UiAutomator2 waits for the UI to go idle before every query, and the
    // live card's spinner never lets it: each lookup took ~11 s, longer than
    // the whole slow compaction, so the card was on screen (its id and text
    // were in the page source) and still never found.
    if (platform() === 'android') await browser.updateSettings({ waitForIdleTimeout: 0 });
  });

  after(async () => {
    // UiAutomator2's default, so later specs in the session see what they always have.
    if (platform() === 'android') await browser.updateSettings({ waitForIdleTimeout: 10_000 });
  });

  it('reaches the thread this page created, as the live card with Stop, until it lands', async function () {
    this.timeout(2 * 60_000);
    await sendAndAwaitReply('first thing to remember', mockEcho('first thing to remember'));
    await sendAndAwaitReply('second thing to remember', mockEcho('second thing to remember'));
    const [conversation] = await listConversations(creds);

    // Created by this page's own sends, so the watch comes from those.
    const ws = await compactFromElsewhere(await apiToken(creds), conversation.id, 'take your time');
    try {
      await expectLiveThenLanded('compaction-new-thread');
    } finally {
      ws.close();
    }
  });

  it('reaches a thread opened from the list, which this connection had not been watching', async function () {
    this.timeout(3 * 60_000);
    // The thread to compact, then a newer one, so a fresh start opens the
    // newer and the first is reached only by choosing it from the list.
    await startNewThread();
    await sendAndAwaitReply('third thing to remember', mockEcho('third thing to remember'));
    await sendAndAwaitReply('fourth thing to remember', mockEcho('fourth thing to remember'));
    const [older] = await listConversations(creds);
    await startNewThread();
    await sendAndAwaitReply('a newer thread', mockEcho('a newer thread'));
    await relaunch();
    await selectThread(older.id);
    await waitForTextIn('chat.messageList', 'fourth thing to remember', 20_000);

    const ws = await compactFromElsewhere(await apiToken(creds), older.id, 'take your time');
    try {
      await expectLiveThenLanded('compaction-opened-thread');
    } finally {
      ws.close();
    }
  });
});
