/**
 * A sub-agent waiting on someone, across the phone leaving the app.
 *
 * A run parked on an approval is exactly when a phone gets locked or put
 * down, and every return from the background replaces the screen's socket
 * (lib/connectionMonitor.ts). The parent's own approval survives that because
 * its run's snapshot carries it (#231). A sub-agent's rides on the *parent's*
 * stream as `subagent.progress`, so it survives only if the snapshot folds it
 * too — and the answer, sent on the new socket, has to name the child's run,
 * which the client knows only from that same snapshot.
 *
 * Both ways out of the app, since they are different OS events: a lock, and
 * switching away.
 */
import { browser } from '@wdio/globals';
import { uniqueCreds, type Credentials } from '../../helpers/auth.ts';
import {
  APPROVAL_SUBAGENT_PROMPT,
  MOCK_SUBAGENT_NAME,
  getToolResults,
  goToSurface,
  listConversations,
  sendMessage,
  signUp,
  startNewAgentRun,
  waitForRunDone,
  waitForSubAgents,
} from '../../helpers/app.ts';
import { shot } from '../../helpers/screenshot.ts';
import { platform, tap, waitForAbsent, waitForTextIn, waitForVisible } from '../../helpers/selectors.ts';

const APP_ID = 'com.loxaic.app';
const appArg = () => (platform() === 'ios' ? { bundleId: APP_ID } : { appId: APP_ID });
const unlock = () => browser.execute('mobile: unlock');
/** Appium's app states: 4 is running in the foreground. */
const FOREGROUND = 4;

async function lock(): Promise<void> {
  await browser.execute('mobile: lock');
  await browser.waitUntil(async () => (await browser.execute('mobile: isLocked')) === true, {
    timeout: 5_000,
    timeoutMsg: 'the device did not lock',
  });
}

async function leaveApp(): Promise<void> {
  await browser.execute('mobile: backgroundApp', { seconds: -1 });
  await browser.waitUntil(async () => (await browser.execute('mobile: queryAppState', appArg())) !== FOREGROUND, {
    timeout: 5_000,
    timeoutMsg: 'the app is still in the foreground',
  });
}
const returnToApp = () => browser.execute('mobile: activateApp', appArg());

async function newestRun(creds: Credentials): Promise<string> {
  let id = '';
  await browser.waitUntil(
    async () => {
      const first = (await listConversations(creds)).find((c) => c.kind === 'agent');
      id = first ? first.id : '';
      return id !== '';
    },
    { timeout: 20_000, timeoutMsg: 'the agent run never appeared' },
  );
  return id;
}

describe('a sub-agent’s approval and the phone leaving the app', () => {
  const creds = uniqueCreds();

  before(async function () {
    const p = platform();
    if (p !== 'ios' && p !== 'android') this.skip();
    await signUp(creds);
    await goToSurface('agent');
  });

  afterEach(async () => {
    await unlock().catch(() => undefined);
    await returnToApp().catch(() => undefined);
  });

  /** A manual-mode run whose sub-agent is waiting to write a file. */
  async function parkOnChildApproval(): Promise<{ convId: string; childId: string }> {
    await startNewAgentRun();
    await tap('agent.mode.manual');
    await sendMessage(APPROVAL_SUBAGENT_PROMPT);
    const convId = await newestRun(creds);
    const [child] = await waitForSubAgents(creds, convId, 1);
    await waitForVisible('agent.permission.bar');
    await waitForTextIn('agent.permission.source', MOCK_SUBAGENT_NAME);
    return { convId, childId: child.conversation_id };
  }

  async function denyAndExpectTheChildToHearIt(convId: string, childId: string): Promise<void> {
    await tap('agent.permission.deny');
    await waitForAbsent('agent.permission.bar', 20_000);
    await waitForRunDone(creds, convId, 60_000);
    const [denied] = await getToolResults(creds, childId);
    expect(denied).toMatchObject({ ok: false, output: 'User denied this tool call.' });
  }

  it('still asks after the phone was locked, and the answer reaches the sub-agent', async function () {
    this.timeout(3 * 60_000);
    const { convId, childId } = await parkOnChildApproval();

    await lock();
    await browser.pause(5_000);
    await unlock();

    // A new socket: what is asked, and by whom, comes from the snapshot.
    await waitForVisible('agent.permission.bar', 30_000);
    await waitForTextIn('agent.permission.source', MOCK_SUBAGENT_NAME);
    await shot('native-subagent-approval-after-unlock');
    await denyAndExpectTheChildToHearIt(convId, childId);
  });

  it('still asks after switching away and back, and the answer reaches the sub-agent', async function () {
    this.timeout(3 * 60_000);
    const { convId, childId } = await parkOnChildApproval();

    await leaveApp();
    await browser.pause(5_000);
    await returnToApp();

    await waitForVisible('agent.permission.bar', 30_000);
    await waitForTextIn('agent.permission.source', MOCK_SUBAGENT_NAME);
    await shot('native-subagent-approval-after-return');
    await denyAndExpectTheChildToHearIt(convId, childId);
  });
});
