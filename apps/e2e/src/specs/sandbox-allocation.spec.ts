/**
 * Sandbox allocations (#254), as a person meets them.
 *
 * With room for one running sandbox, a second chat's tool call is refused and
 * its card offers Manage sandboxes; the Sandboxes screen shows the allocation
 * full, keeps Pause off while a run uses the sandbox, and pausing it makes
 * room so the second chat's retry starts its own. An admin sets the default
 * and one person's override; someone who is not an admin sees their own
 * allocation and none of those controls.
 *
 * Driven against the real server and real containers: the refusal is the
 * server's, the pause stops a real container, and the room it frees is what
 * lets the retry through.
 */
import { adminCreds, apiToken, provisionAdmin, provisionUser, uniqueCreds } from '../helpers/auth.ts';
import { shot } from '../helpers/screenshot.ts';
import {
  closeKeyboard,
  expectNeverPresent,
  scrollTo,
  scrollToMiddle,
  tap,
  typeInto,
  waitForAbsent,
  waitForFreshText,
  waitForTextIn,
  waitForVisible,
} from '../helpers/selectors.ts';
import {
  BASH_PROMPT,
  MOCK_BASH_OUTPUT,
  SLOW_PROMPT,
  getToolResults,
  goToSurface,
  listSandboxes,
  myAllocation,
  openSandboxes,
  openSandboxSettings,
  pauseAllMySandboxes,
  resetSandboxSettings,
  selectThread,
  sendInNewRun,
  sendMessage,
  sendOnSecondSocket,
  setUserAllocation,
  signIn,
  signOut,
  startNewAgentRun,
  userIdFor,
  waitForRunDone,
  waitForToolResult,
} from '../helpers/app.ts';
import { BASE_URL } from '../../scripts/standup.ts';

/** Polls the stored tool results until one matches. */
async function waitForResult(
  conversationId: string,
  match: (r: { call_id: string; ok?: boolean }) => boolean,
  label: string,
): Promise<string> {
  let callId = '';
  await browser.waitUntil(
    async () => {
      const found = (await getToolResults(adminCreds(), conversationId)).find(match);
      callId = found?.call_id ?? '';
      return callId !== '';
    },
    { timeout: 60_000, interval: 1_000, timeoutMsg: `[e2e] no ${label} in ${conversationId}` },
  );
  return callId;
}

async function defaultAllocation(): Promise<{ memoryMb: number; cpus: number; maxRunning: number }> {
  const token = await apiToken(adminCreds());
  const res = await fetch(`${BASE_URL}/v1/admin/settings/sandbox`, { headers: { authorization: `Bearer ${token}` } });
  return ((await res.json()) as { allocation: { memoryMb: number; cpus: number; maxRunning: number } }).allocation;
}

describe('sandbox allocations (#254)', () => {
  let adminId = '';
  const member = uniqueCreds();
  let memberId = '';

  before(async () => {
    await provisionAdmin();
    await provisionUser(member);
    await resetSandboxSettings();
    adminId = await userIdFor(adminCreds().email);
    memberId = await userIdFor(member.email);
    // Room for one running sandbox, starting from none: earlier specs leave
    // theirs running for the idle timer.
    await setUserAllocation(adminId, { maxRunning: 1 });
    await pauseAllMySandboxes(adminCreds());
    await signIn(adminCreds());
  });

  after(async () => {
    await setUserAllocation(adminId, null);
    await setUserAllocation(memberId, null);
    await resetSandboxSettings();
  });

  it('refuses a second sandbox, offers the Sandboxes screen, and Pause makes room', async function () {
    this.timeout(6 * 60_000);

    // Chat A takes the one place.
    await goToSurface('agent');
    await startNewAgentRun();
    await tap('agent.mode.manual');
    const chatA = await sendInNewRun(adminCreds(), BASH_PROMPT);
    await waitForVisible('agent.permission.bar');
    await tap('agent.permission.allow');
    await waitForToolResult(MOCK_BASH_OUTPUT);
    const token = await apiToken(adminCreds());
    const [sandboxA] = await listSandboxes(token, chatA);
    expect(sandboxA.status).toBe('running');

    // Chat B's sandbox is refused, and its card says what to do.
    await startNewAgentRun();
    await tap('agent.mode.manual');
    const chatB = await sendInNewRun(adminCreds(), BASH_PROMPT);
    await waitForVisible('agent.permission.bar');
    await tap('agent.permission.allow');
    const refused = await waitForResult(chatB, (r) => r.ok === false, 'refused call');
    // The mock's wrap-up lands under the card and pushes it towards the
    // header on a phone, where XCUITest will not tap it.
    await scrollToMiddle(`chat.toolCall.manageSandboxes.${refused}`);
    await waitForFreshText(`chat.toolCall.allocation.${refused}`, 'allocation is full');
    await shot('sandbox-allocation-card');
    expect(await listSandboxes(token, chatB)).toEqual([]);

    await tap(`chat.toolCall.manageSandboxes.${refused}`);
    await waitForFreshText('sandboxes.bar.running', '1 of 1');
    await waitForVisible('sandboxes.full');
    await waitForVisible(`sandboxes.row.${sandboxA.id}.pause`);
    await shot('sandbox-allocation-full');

    // While a run uses A, it cannot be paused: the row says so instead.
    const second = await sendOnSecondSocket(adminCreds(), SLOW_PROMPT, 'agent', chatA);
    try {
      await waitForFreshText(`sandboxes.row.${sandboxA.id}.status`, 'Running a task');
      await shot('sandbox-allocation-busy');
    } finally {
      second.stop();
      await waitForRunDone(adminCreds(), chatA);
      second.close();
    }
    await waitForVisible(`sandboxes.row.${sandboxA.id}.pause`);

    await tap(`sandboxes.row.${sandboxA.id}.pause`);
    await tap('sandboxes.pauseConfirm.confirm');
    await waitForFreshText(`sandboxes.row.${sandboxA.id}.status`, 'Paused');
    await waitForFreshText('sandboxes.bar.running', '0 of 1');
    await waitForAbsent('sandboxes.full');
    await shot('sandbox-allocation-paused');
    expect((await listSandboxes(token, chatA))[0].status).toBe('stopped');

    // The room is real: chat B's retry starts its sandbox.
    await goToSurface('agent');
    await selectThread(chatB, 'agent');
    await tap('agent.mode.manual');
    await sendMessage(BASH_PROMPT);
    await waitForVisible('agent.permission.bar');
    await tap('agent.permission.allow');
    await waitForResult(chatB, (r) => r.ok === true, 'successful retry');
    expect((await listSandboxes(token, chatB))[0]?.status).toBe('running');
  });

  it('lets an admin set the default allocation, and refuses one out of bounds', async () => {
    await openSandboxSettings();
    await scrollTo('sandbox.allocation.memoryGb');
    await typeInto('sandbox.allocation.memoryGb', '0.1');
    await closeKeyboard();
    await scrollTo('sandbox.allocation.save');
    await tap('sandbox.allocation.save');
    await waitForTextIn('sandbox.allocation.error', 'Memory must be between');

    await typeInto('sandbox.allocation.memoryGb', '3');
    await closeKeyboard();
    await scrollTo('sandbox.allocation.save');
    await tap('sandbox.allocation.save');
    await browser.waitUntil(async () => (await defaultAllocation()).memoryMb === 3072, {
      timeout: 15_000,
      timeoutMsg: '[e2e] the default allocation was not saved',
    });
    await waitForAbsent('sandbox.allocation.error');
    await shot('sandbox-allocation-admin-default');
    await resetSandboxSettings();
  });

  it("lets an admin override one person's allocation and put it back", async () => {
    await goToSurface('admin');
    await tap('admin.tab.users');
    await typeInto('admin.users.search', member.email);
    await closeKeyboard();
    await waitForTextIn(`admin.user.${memberId}.allocation.label`, '2.5 GB');
    await tap(`admin.user.${memberId}.allocation`);
    // XCUITest exposes no container's testID: anchor on the dialog's button.
    await waitForVisible('admin.allocation.save');
    await typeInto('admin.allocation.memoryGb', '16');
    await typeInto('admin.allocation.cpus', '8');
    await closeKeyboard();
    await shot('sandbox-allocation-admin-user');
    await tap('admin.allocation.save');
    await waitForAbsent('admin.allocation.save');
    await waitForFreshText(`admin.user.${memberId}.allocation.label`, '16 GB · 8 CPUs');
    await waitForTextIn(`admin.user.${memberId}.allocation.label`, 'set for them');

    await tap(`admin.user.${memberId}.allocation`);
    await waitForVisible('admin.allocation.reset');
    await tap('admin.allocation.reset');
    await waitForAbsent('admin.allocation.save');
    await waitForFreshText(`admin.user.${memberId}.allocation.label`, '2.5 GB · 5 CPUs');
    const resolved = await myAllocation(member);
    expect(resolved.allocation).toEqual({ memoryMb: 2560, cpus: 5, maxRunning: 5 });
  });

  it('shows someone who is not an admin their own allocation, and no admin controls', async () => {
    await signOut();
    await signIn(member);
    await openSandboxes();
    await waitForFreshText('sandboxes.bar.running', '0 of 5');
    await waitForTextIn('sandboxes.source', 'default allocation');
    await waitForVisible('sandboxes.empty');
    await shot('sandbox-allocation-member');

    await openSandboxSettings();
    await waitForVisible('sandbox.readOnly.notice');
    await expectNeverPresent(['sandbox.allocation.save']);
    await signOut();
    await signIn(adminCreds());
  });
});
