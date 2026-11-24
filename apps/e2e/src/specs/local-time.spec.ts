/**
 * Every message carries the time it was sent in the sending device's zone,
 * and the model is told it ahead of the message. The mock answers "what time
 * is it" with what its prompt carried, so the reply shows the device's zone
 * reached the model; the stored row shows it was kept.
 *
 * On web and Electron the page is put in a zone unlike the server's
 * (DevTools' time zone override), so a server that dated the message in its
 * own zone could not pass. iOS simulators share the host's zone; the Android
 * emulator has its own, read with adb.
 */
import { execFileSync } from 'node:child_process';
import { browser } from '@wdio/globals';
import { uniqueCreds } from '../helpers/auth.ts';
import { shot } from '../helpers/screenshot.ts';
import { platform, waitForTextIn } from '../helpers/selectors.ts';
import { getStoredBlocks, goToSurface, listConversations, sendMessage, signUp, startNewThread } from '../helpers/app.ts';
import { adbPath } from '../../scripts/native.ts';

/** Far from any server this runs on: UTC+12:45, or +13:45 in its summer. */
const PAGE_ZONE = 'Pacific/Chatham';

async function devtools() {
  const url = await browser.getUrl();
  const page = (await (await browser.getPuppeteer()).pages()).find((p) => p.url() === url);
  if (!page) throw new Error(`[e2e] no DevTools page for the window at ${url}`);
  return page.createCDPSession();
}

/** Puts the device in a zone the spec knows, where it can; returns the zone
 * and how to undo it. */
async function deviceZone(): Promise<{ zone: string; restore: () => Promise<void> }> {
  const p = platform();
  if (p === 'web' || p === 'electron') {
    const session = await devtools();
    await session.send('Emulation.setTimezoneOverride', { timezoneId: PAGE_ZONE });
    return {
      zone: PAGE_ZONE,
      restore: async () => {
        await session.send('Emulation.setTimezoneOverride', { timezoneId: '' });
      },
    };
  }
  if (p === 'android') {
    const zone = execFileSync(adbPath(), ['shell', 'getprop', 'persist.sys.timezone'], { encoding: 'utf8' }).trim();
    return { zone, restore: () => Promise.resolve() };
  }
  return { zone: Intl.DateTimeFormat().resolvedOptions().timeZone, restore: () => Promise.resolve() };
}

describe('the time a message was sent', () => {
  const creds = uniqueCreds();

  before(async () => {
    await signUp(creds);
  });

  it("reaches the model in this device's zone, and is kept with the message", async () => {
    const { zone, restore } = await deviceZone();
    if (!zone) throw new Error('could not read the device time zone');
    try {
      await goToSurface('chat');
      await startNewThread('chat');
      await sendMessage('what time is it');
      await waitForTextIn('chat.messageList', `(${zone}, UTC`, 30_000);
      await shot('local-time-reply');

      const [conv] = await listConversations(creds);
      // The listing's type leaves `tz` out; the block carries it.
      const sent: { kind: string; tz?: string; source?: string } | undefined = (await getStoredBlocks(creds, conv.id)).find(
        (b) => b.kind === 'local_time',
      );
      expect(sent).toMatchObject({ kind: 'local_time', tz: zone, source: 'device' });
    } finally {
      await restore();
    }
  });
});
