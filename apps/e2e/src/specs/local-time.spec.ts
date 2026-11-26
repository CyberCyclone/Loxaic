/**
 * Every message carries the time it was sent in the sending device's zone,
 * and the model is told it ahead of the message. The mock answers "what time
 * is it" with what its prompt carried, so the reply shows the device's zone
 * reached the model; the stored row shows it was kept.
 *
 * The device is put in a zone unlike the server's on every lane, so a server
 * that dated the message in its own zone could not pass: DevTools' time zone
 * override on web and Electron, the system zone on the Android emulator, and
 * the app's own `TZ` on the iOS simulator (which otherwise shares the host's).
 *
 * A person who turns off "Send my time zone with messages" (Account) gets
 * messages dated in UTC instead, from the same device in the same zone.
 */
import { execFileSync } from 'node:child_process';
import { browser } from '@wdio/globals';
import { uniqueCreds } from '../helpers/auth.ts';
import { shot } from '../helpers/screenshot.ts';
import { platform, scrollTo, tap, waitForSwitch, waitForTextIn } from '../helpers/selectors.ts';
import {
  getPrefsViaApi,
  getStoredBlocks,
  goToSurface,
  listConversations,
  openSettings,
  patchPrefs,
  relaunchApp,
  sendMessage,
  signUp,
  startNewThread,
  waitForComposerReady,
} from '../helpers/app.ts';
import { adbPath } from '../../scripts/native.ts';

/** Far from any server this runs on: UTC+12:45, or +13:45 in its summer. */
const DEVICE_ZONE = 'Pacific/Chatham';

async function devtools() {
  const url = await browser.getUrl();
  const page = (await (await browser.getPuppeteer()).pages()).find((p) => p.url() === url);
  if (!page) throw new Error(`[e2e] no DevTools page for the window at ${url}`);
  return page.createCDPSession();
}

function adb(...args: string[]): string {
  return execFileSync(adbPath(), ['shell', ...args], { encoding: 'utf8' }).trim();
}

/** Puts the device in DEVICE_ZONE; returns how to undo it. A phone app reads
 * its zone as it starts, so native lanes cold-start it in the new one. */
async function inDeviceZone(): Promise<() => Promise<void>> {
  const p = platform();
  if (p === 'web' || p === 'electron') {
    const session = await devtools();
    await session.send('Emulation.setTimezoneOverride', { timezoneId: DEVICE_ZONE });
    return async () => {
      await session.send('Emulation.setTimezoneOverride', { timezoneId: '' });
    };
  }
  if (p === 'android') {
    const was = adb('getprop', 'persist.sys.timezone');
    adb('cmd', 'alarm', 'set-timezone', DEVICE_ZONE);
    await relaunchApp();
    await waitForComposerReady(60_000);
    return async () => {
      if (was) adb('cmd', 'alarm', 'set-timezone', was);
      await relaunchApp();
    };
  }
  await relaunchApp({ TZ: DEVICE_ZONE });
  await waitForComposerReady(60_000);
  return () => relaunchApp();
}

describe('the time a message was sent', () => {
  const creds = uniqueCreds();

  /** Sends in a new chat; returns the stored `local_time` block of the
   * thread the send made (the one not listed before it). */
  async function sendAndRead(expectInReply: string): Promise<{ kind: string; tz?: string; source?: string; at?: string }> {
    await goToSurface('chat');
    await startNewThread('chat');
    const before = new Set((await listConversations(creds)).map((c) => c.id));
    await sendMessage('what time is it');
    await waitForTextIn('chat.messageList', expectInReply, 30_000);
    const made = (await listConversations(creds)).filter((c) => !before.has(c.id));
    expect(made).toHaveLength(1);
    // The listing's type leaves `tz` out; the block carries it.
    const sent = (await getStoredBlocks(creds, made[0].id)).find((b) => b.kind === 'local_time');
    if (!sent) throw new Error('the message carries no local_time block');
    return sent;
  }

  before(async () => {
    await signUp(creds);
  });

  it("reaches the model in this device's zone, and is kept with the message", async () => {
    const restore = await inDeviceZone();
    try {
      const sent = await sendAndRead(`(${DEVICE_ZONE}, UTC`);
      await shot('local-time-reply');
      expect(sent).toMatchObject({ kind: 'local_time', tz: DEVICE_ZONE, source: 'device' });

      // Turned off on the Account screen: the same device, in the same zone,
      // now sends messages dated in UTC with no zone.
      await openSettings();
      await tap('settings.nav.account');
      await scrollTo('settings.shareTimeZone.toggle');
      await tap('settings.shareTimeZone.toggle');
      await waitForSwitch('settings.shareTimeZone.toggle', false);
      await shot('local-time-share-off');
      await browser.waitUntil(async () => (await getPrefsViaApi(creds)).shareTimeZone === false, {
        timeout: 10_000,
        timeoutMsg: 'the setting never reached the server',
      });
      const hidden = await sendAndRead('keeps their time zone private (UTC+00:00)');
      expect(hidden).toMatchObject({ kind: 'local_time', source: 'device' });
      expect(hidden.tz).toBeUndefined();
      expect(hidden.at).toMatch(/\+00:00$/);
    } finally {
      await patchPrefs(creds, { shareTimeZone: true });
      await restore();
    }
  });
});
