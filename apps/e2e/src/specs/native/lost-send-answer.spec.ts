/**
 * Locking the phone straight after starting a new chat, while the server is
 * slow to answer.
 *
 * A new thread learns its real id only from `turn.started`, sent to the socket
 * that sent the message, and unlocking replaces that socket. With the server
 * slow, the answer arrives after the replacement and is lost: the run finished
 * on the server, but the thread never showed its reply, and the new socket
 * subscribed with the thread's local id — `invalid input syntax for type uuid`
 * on screen. Now the new socket asks what became of the send (`send.status`).
 *
 * The server is frozen for real (helpers/server.ts), so the message sits in its
 * socket buffer, unread, while the phone locks and unlocks; the lock is the real
 * OS event. Nothing in the app is patched. The web lane's
 * lost-send-answer.spec.ts has the case where the send never arrives at all,
 * which only a page can arrange.
 */
import { browser } from '@wdio/globals';
import { uniqueCreds } from '../../helpers/auth.ts';
import { mockEcho, sendMessage, signUp } from '../../helpers/app.ts';
import { shot } from '../../helpers/screenshot.ts';
import { platform, waitForTextIn } from '../../helpers/selectors.ts';
import { pauseServer, resumeServer } from '../../helpers/server.ts';

const unlock = () => browser.execute('mobile: unlock');

async function lock(): Promise<void> {
  await browser.execute('mobile: lock');
  await browser.waitUntil(async () => (await browser.execute('mobile: isLocked')) === true, {
    timeout: 5_000,
    timeoutMsg: 'the device did not lock',
  });
}

describe('locking the phone before a new chat hears back', () => {
  const creds = uniqueCreds();

  before(async function () {
    const p = platform();
    if (p !== 'ios' && p !== 'android') this.skip();
    // A new account opens on an empty chat: the next send starts a new thread.
    await signUp(creds);
  });

  afterEach(async () => {
    resumeServer();
    await unlock().catch(() => undefined);
  });

  it('shows the reply once it is back, in the conversation the send made', async () => {
    const prompt = 'hello from before the lock';
    pauseServer();
    await sendMessage(prompt);
    await lock();
    await browser.pause(1_000);
    await unlock();
    // The unlock has replaced the socket; only now does the server read the
    // message, and its answer goes to the socket that is gone.
    await browser.pause(1_000);
    resumeServer();
    await waitForTextIn('chat.messageList', mockEcho(prompt), 60_000);
    await shot('native-lost-answer-recovered');
  });
});
