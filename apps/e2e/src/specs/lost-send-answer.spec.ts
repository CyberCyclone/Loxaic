/**
 * A new conversation whose socket dies between the send and the answer.
 *
 * A new thread learns its real id only from `turn.started`, sent to the socket
 * that sent the message. When that socket was replaced first — the app back
 * from the background, a Mac waking, a failed health probe — the answer was
 * lost. The run went on and finished on the server, but the thread kept its
 * optimistic id, no reply ever appeared, and the reconnect subscribed with the
 * local id, which reached the screen as `invalid input syntax for type uuid:
 * "c1790483463291"`. Now the new socket asks what became of the send
 * (`send.status`) and the server replays the answer — or says it never heard of
 * the send, and the message goes back to the message box.
 *
 * The socket is closed from inside the page right after the frame is written,
 * which is the failure itself: the server gets the message, and its answer
 * arrives at a socket already closing, which the browser discards. The hook
 * then reconnects on its own, as it would after any drop.
 */
import { browser } from '@wdio/globals';
import { uniqueCreds } from '../helpers/auth.ts';
import { shot } from '../helpers/screenshot.ts';
import { platform, testIdSelector, waitForTextIn, waitForVisible } from '../helpers/selectors.ts';
import { goToSurface, mockEcho, sendMessage, signUp, startNewThread } from '../helpers/app.ts';

/**
 * The next `<type>` frame closes its socket as it goes out. With `deliver`
 * false the frame is dropped as well — the send never reaches the server.
 */
async function dropSocketOnNext(type: 'chat.send' | 'agent.send', deliver: boolean): Promise<void> {
  await browser.execute(
    (frameType: string, send: boolean) => {
      const proto = WebSocket.prototype;
      // Read through the descriptor rather than `proto.send`, which lint
      // (rightly) reads as detaching a method from its object.
      const original = Object.getOwnPropertyDescriptor(proto, 'send')?.value as WebSocket['send'];
      proto.send = function (this: WebSocket, data: string | ArrayBufferLike | Blob | ArrayBufferView) {
        if (typeof data === 'string' && data.includes(`"type":"${frameType}"`)) {
          proto.send = original;
          if (send) original.call(this, data);
          this.close();
          return;
        }
        original.call(this, data);
      };
    },
    type,
    deliver,
  );
}

async function composerValue(): Promise<string> {
  return browser.execute(
    (selector: string) => document.querySelector<HTMLTextAreaElement | HTMLInputElement>(selector)?.value ?? '',
    testIdSelector('composer.input'),
  );
}

describe('a new conversation whose socket drops before the answer', () => {
  const creds = uniqueCreds();

  before(async function () {
    const p = platform();
    if (p !== 'web' && p !== 'electron') this.skip();
    await signUp(creds);
  });

  it('chat: learns its conversation after all, and shows the reply', async () => {
    await goToSurface('chat');
    await startNewThread('chat');
    const prompt = 'hello across a dropped socket';
    await dropSocketOnNext('chat.send', true);
    await sendMessage(prompt);
    await waitForTextIn('chat.messageList', mockEcho(prompt), 30_000);
    await shot('lost-answer-chat-recovered');
    // It is a real conversation now: the reply survives a reload.
    await browser.refresh();
    await waitForTextIn('chat.messageList', mockEcho(prompt), 30_000);
  });

  it('agent: the same, on the agent socket', async () => {
    await goToSurface('agent');
    await startNewThread('agent');
    const prompt = 'hello agent across a dropped socket';
    await dropSocketOnNext('agent.send', true);
    await sendMessage(prompt);
    await waitForTextIn('chat.messageList', mockEcho(prompt), 30_000);
    await shot('lost-answer-agent-recovered');
  });

  it('a send the server never got goes back to the message box and says so', async () => {
    await goToSurface('chat');
    await startNewThread('chat');
    const prompt = 'this one never arrives';
    await dropSocketOnNext('chat.send', false);
    await sendMessage(prompt);
    await waitForTextIn('shell.toast', 'may not have been sent', 30_000);
    await browser.waitUntil(async () => (await composerValue()) === prompt, {
      timeout: 10_000,
      timeoutMsg: 'the unsent message did not come back to the message box',
    });
    await waitForVisible('composer.input');
    const listText = await browser.execute(
      (selector: string) => document.querySelector(selector)?.textContent ?? '',
      testIdSelector('chat.messageList'),
    );
    if (listText.includes(prompt)) throw new Error('the unsent message is still in the thread');
    await shot('lost-send-returned');
  });
});
