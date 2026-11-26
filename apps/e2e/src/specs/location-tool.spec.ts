/**
 * The location tool end to end, on every platform: the default "What's the
 * weather like today?" favourite makes the model ask for the location (the
 * mock calls `get_location` for "weather"), the app asks "Share your
 * location?", and the device's own position — set the way each platform
 * learns one (helpers/location.ts) — reaches the model as the nearest town.
 *
 * What the model was told is read from the stored result and from the mock's
 * reply, which quotes it; the setting from the API.
 */
import { uniqueCreds } from '../helpers/auth.ts';
import { shot } from '../helpers/screenshot.ts';
import { byTestId, isVisible, platform, tap, waitForAbsent, waitForFreshText, waitForGone, waitForTextIn, waitForVisible } from '../helpers/selectors.ts';
import {
  createRoutine,
  goToSurface,
  MOCK_TOOL_DONE,
  openSettings,
  patchPrefs,
  relaunchApp,
  revealInSettings,
  runRoutine,
  sendMessage,
  signUp,
  waitForComposerReady,
  waitForRunDone,
} from '../helpers/app.ts';
import { pauseServer, resumeServer } from '../helpers/server.ts';
import { askForTheWeather, BRISBANE, locationResultOf, locationSharing, placeDeviceAt, WEATHER } from '../helpers/location.ts';

describe('the location tool', () => {
  const creds = uniqueCreds();

  before(async () => {
    await signUp(creds);
    await placeDeviceAt(BRISBANE);
  });

  afterEach(() => {
    resumeServer();
  });

  const sharing = () => locationSharing(creds);
  const resultOf = (convId: string) => locationResultOf(creds, convId);

  it('asks first, and with "Allow once" tells the model the nearest town', async () => {
    const convId = await askForTheWeather(creds);
    await waitForFreshText('chat.location.title', 'Share your location?');
    await waitForVisible('chat.location.reason');
    await shot('location-prompt');
    await tap('chat.location.allowOnce');
    await waitForAbsent('chat.location.bar', 30_000);
    expect(await resultOf(convId)).toMatch(/^Approximate location: Brisbane, Queensland, Australia/);
    // The model was told it, and the thread says so.
    await waitForTextIn('chat.messageList', `${MOCK_TOOL_DONE} Approximate location: Brisbane`, 30_000);
    await shot('location-answered');
    expect(await sharing()).toBe('ask');
  });

  it('passes on "Don\'t allow" without changing the setting', async () => {
    const convId = await askForTheWeather(creds);
    await tap('chat.location.deny');
    expect(await resultOf(convId)).toMatch(/^The user chose not to share their location/);
    expect(await sharing()).toBe('ask');
  });

  it('asks again after a cold start while the question is up', async () => {
    await askForTheWeather(creds);
    await waitForVisible('chat.location.bar');
    // Only a cold start proves the snapshot carries the request.
    await relaunchApp();
    await waitForComposerReady(60_000);
    await waitForFreshText('chat.location.title', 'Share your location?', 30_000);
    await tap('chat.location.deny');
    await waitForAbsent('chat.location.bar', 30_000);
  });

  it('turns to Always with "Always allow", and then answers without asking', async () => {
    const first = await askForTheWeather(creds);
    await tap('chat.location.allowAlways');
    expect(await resultOf(first)).toContain('Brisbane, Queensland, Australia');
    expect(await sharing()).toBe('always');

    const second = await askForTheWeather(creds);
    expect(await resultOf(second)).toContain('Brisbane, Queensland, Australia');
    await waitForAbsent('chat.location.bar');
  });

  it('says sharing is off, without asking, when it is set off in Settings', async () => {
    await openSettings();
    await revealInSettings('settings.nav.location');
    await tap('settings.nav.location');
    await waitForVisible('location.sharing.off');
    await waitForFreshText('location.attribution', 'GeoNames');
    await tap('location.sharing.off');
    await browser.waitUntil(async () => (await sharing()) === 'off', { timeout: 15_000, timeoutMsg: 'the setting never became off' });
    await waitForFreshText('location.sharing.help', 'location sharing is off');
    await shot('location-settings');

    const convId = await askForTheWeather(creds);
    expect(await resultOf(convId)).toMatch(/^The user has turned location sharing off/);
    await waitForAbsent('chat.location.bar');
    await patchPrefs(creds, { locationSharing: 'ask' });
  });

  it('cannot be answered while the server is away', async () => {
    const convId = await askForTheWeather(creds);
    await waitForVisible('chat.location.bar');
    pauseServer();
    // Nothing to return from: only the heartbeat notices a frozen server.
    await waitForTextIn('shell.offlineBanner', "Can't reach your server", 60_000);
    const p = platform();
    if (p === 'web' || p === 'electron') {
      for (const id of ['chat.location.allowOnce', 'chat.location.allowAlways', 'chat.location.deny']) {
        expect(await byTestId(id).getAttribute('aria-disabled')).toBe('true');
      }
    }
    // A press goes nowhere, on every platform: had "Allow once" been sent,
    // the server would read it on waking and share.
    await tap('chat.location.allowOnce');
    await browser.pause(1_000);
    resumeServer();
    await waitForGone('shell.offlineBanner', 60_000);
    await tap('chat.location.deny');
    expect(await resultOf(convId)).toMatch(/^The user chose not to share their location/);
  });

  it("asks in a routine's thread too, where a follow-up is a chat", async () => {
    const routine = await createRoutine(creds, { name: `Weather ${String(Date.now())}`, prompt: 'summarise yesterday', model: 'llama-3.1-8b-instruct' });
    const run = await runRoutine(creds, routine.id);
    await waitForRunDone(creds, run.conversationId);
    await goToSurface('routines');
    await tap(`routines.open.${routine.id}`);
    await waitForVisible('routineChat.back');
    await waitForComposerReady();
    await sendMessage(WEATHER);
    await waitForFreshText('chat.location.title', 'Share your location?', 30_000);
    await shot('location-prompt-routine');
    await tap('chat.location.allowOnce');
    await waitForAbsent('chat.location.bar', 30_000);
    await browser.waitUntil(async () => (await locationResultOf(creds, run.conversationId)).startsWith('Approximate location: Brisbane'), {
      timeout: 40_000,
      timeoutMsg: "the routine's thread never shared the location",
    });
    // On a phone a routine's chat has a back arrow where the menu button goes.
    if (await isVisible('routineChat.back')) await tap('routineChat.back');
    await goToSurface('chat');
  });
});
