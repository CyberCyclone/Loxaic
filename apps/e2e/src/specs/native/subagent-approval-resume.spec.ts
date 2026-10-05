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
 * switching away. Neither of those empties the app's memory, though: the bar,
 * its source line and the child's stream id are all still held in React state
 * when the socket is replaced, so those two cases show the answer still
 * *reaches* the child on the new socket and would pass with nothing folded
 * into the snapshot at all. The cold start is the case that starts from
 * nothing — the question, who is asking it, and which run to answer can only
 * have come from the server.
 */
import { browser } from '@wdio/globals';
import { uniqueCreds } from '../../helpers/auth.ts';
import {
  APPROVAL_SUBAGENT_PROMPT,
  MOCK_SUBAGENT_NAME,
  getToolResults,
  goToSurface,
  sendInNewRun,
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
const quitApp = () => browser.execute('mobile: terminateApp', appArg());

describe('a sub-agent’s approval and the phone leaving the app', () => {
  const creds = uniqueCreds();

  before(async function () {
    const p = platform();
    if (p !== 'ios' && p !== 'android') this.skip();
    await signUp(creds);
    // A waiting sub-agent's card counts its elapsed time ten times a second,
    // which UiAutomator2 never sees as idle — see subagents.spec.ts.
    if (p === 'android') await browser.updateSettings({ waitForIdleTimeout: 0 });
    await goToSurface('agent');
  });

  after(async () => {
    if (platform() === 'android') await browser.updateSettings({ waitForIdleTimeout: 10_000 });
  });

  afterEach(async () => {
    await unlock().catch(() => undefined);
    await returnToApp().catch(() => undefined);
  });

  /** A manual-mode run whose sub-agent is waiting to write a file. */
  async function parkOnChildApproval(): Promise<{ convId: string; childId: string }> {
    await startNewAgentRun();
    await tap('agent.mode.manual');
    // By difference from the runs that were there, never "the newest": asked a
    // moment early that is the previous case's run, whose sub-agent already
    // holds the very result this case goes on to assert.
    const convId = await sendInNewRun(creds, APPROVAL_SUBAGENT_PROMPT);
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

  it('asks again after the app was quit and opened from cold, and the answer reaches the sub-agent', async function () {
    this.timeout(4 * 60_000);
    const { convId, childId } = await parkOnChildApproval();

    await quitApp();
    await browser.pause(2_000);
    await returnToApp();
    // Nothing survives a quit but the session: the thread, its sub-agent and
    // the question it is waiting on are all read back from the server.
    await waitForVisible('composer.input', 60_000);
    await goToSurface('agent');
    await waitForVisible('agent.permission.bar', 60_000);
    await waitForTextIn('agent.permission.source', MOCK_SUBAGENT_NAME);
    await shot('native-subagent-approval-after-cold-start');
    await denyAndExpectTheChildToHearIt(convId, childId);
  });
});
