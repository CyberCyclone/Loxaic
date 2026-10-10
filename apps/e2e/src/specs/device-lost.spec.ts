/**
 * The GPU reset under a host model.
 *
 * On Pheonix the amdgpu driver reset a card 31 minutes into re-reading a
 * 221K-token conversation, because one GPU job ran past the driver's 2-second
 * limit. The chat said `decode() failed: vk::Queue::submit: ErrorDeviceLost`,
 * nothing on the Host models screen had warned about the limit, and the
 * model's process stayed up with its device gone, so the next request failed
 * too. Each is held here:
 *
 *   - The runtime card warns about a short driver limit, and gives the line
 *     that raises it.
 *   - The chat says the GPU stopped responding and was reset, and what the next
 *     message will cost.
 *   - The model is unloaded, and the next message is answered.
 *
 * The fake router stands in for llama.cpp: "lose the device" in a message makes
 * it print what b11457's child printed and fail the request the same way, and
 * keep failing until the model is unloaded. `FAKE_AMDGPU_DIR` stands in for
 * `/sys/module/amdgpu/parameters`; the runtime reads it when it starts, as the
 * real one is read once per boot.
 */
import { rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { browser } from '@wdio/globals';
import { adminCreds, provisionAdmin } from '../helpers/auth.ts';
import { FAKE_AMDGPU_DIR } from '../../scripts/standup.ts';
import { shot } from '../helpers/screenshot.ts';
import { scrollTo, tap, waitForAbsent, waitForFreshText, waitForTextIn, waitForVisible } from '../helpers/selectors.ts';
import { goToSurface, openSettings, sendMessage, signIn, startNewThread } from '../helpers/app.ts';
import { downloadTinyModel, patchModel, removeMockModels, routerEvents, routerName } from '../helpers/hostModels.ts';

const LOCKUP_FILE = path.join(FAKE_AMDGPU_DIR, 'lockup_timeout');

async function openHostModels(): Promise<void> {
  await openSettings();
  await scrollTo('settings.nav.localModels');
  await tap('settings.nav.localModels');
  await waitForVisible('localModels.runtime');
}

/** Restart llama.cpp from the card, as an admin does after rebooting the host,
 * and wait for it to be back. */
async function restartRuntime(): Promise<void> {
  await scrollTo('localModels.runtime.restart');
  await tap('localModels.runtime.restart');
  await waitForAbsent('localModels.runtime.restarting', 60_000);
}

async function pickModel(id: string): Promise<void> {
  await tap('composer.model');
  await waitForVisible(`models.row.${id}`);
  await tap(`models.row.${id}`);
  await waitForAbsent('models.search', 10_000);
}

describe('the GPU reset under a host model', () => {
  let id = '';

  before(async function () {
    this.timeout(4 * 60_000);
    await provisionAdmin();
    await removeMockModels();
    id = await downloadTinyModel();
    await patchModel(id, { enabled: true });
    // Kernel 7.0's default, as Pheonix runs it.
    writeFileSync(LOCKUP_FILE, '2000\n');
    await signIn(adminCreds());
  });

  after(async function () {
    this.timeout(2 * 60_000);
    rmSync(LOCKUP_FILE, { force: true });
    // Leave the runtime as the next spec expects it: no limit read.
    await openHostModels();
    await restartRuntime();
    await removeMockModels();
  });

  it('warns on the runtime card about a short driver limit, with the line that raises it', async function () {
    this.timeout(2 * 60_000);
    await openHostModels();
    await restartRuntime();
    await scrollTo('localModels.runtime.gpuJobLimit');
    await waitForFreshText('localModels.runtime.gpuJobLimit.message', 'runs longer than 2 s', 30_000);
    await waitForTextIn('localModels.runtime.gpuJobLimit.fix', 'lockup_timeout=2000,60000,2000,2000');
    await shot('gpu-job-limit-warning');
  });

  it('explains a lost GPU, unloads the model, and answers the next message', async function () {
    this.timeout(3 * 60_000);
    await goToSurface('chat');
    await startNewThread('chat');
    await pickModel(id);
    await sendMessage('Please lose the device.');

    await waitForTextIn('chat.message.error', 'stopped responding', 60_000);
    await waitForTextIn('chat.message.error', 'longer than 2 s');
    await waitForTextIn('chat.message.error', 'The model has been unloaded');
    await shot('gpu-device-lost-explained');

    // Unloaded on the router, not just said to be.
    await browser.waitUntil(
      () => routerEvents().some((e) => e.event === 'unload' && e.model === routerName(id)),
      { timeout: 20_000, timeoutMsg: `[e2e] ${id} was never unloaded after its GPU was reset` },
    );

    // The fake fails every request on a lost device until it is unloaded, as
    // llama.cpp's child does; a fresh load answers.
    await sendMessage('hello again');
    await waitForTextIn('chat.messageList', `from ${routerName(id)}`, 60_000);
    await shot('gpu-device-lost-next-message');
  });
});
