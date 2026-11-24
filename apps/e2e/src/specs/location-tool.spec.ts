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
import { apiToken, uniqueCreds } from '../helpers/auth.ts';
import { shot } from '../helpers/screenshot.ts';
import { byTestId, platform, tap, waitForAbsent, waitForFreshText, waitForTextIn, waitForVisible } from '../helpers/selectors.ts';
import {
  getToolResults,
  goToSurface,
  listConversations,
  listFavouriteQuestions,
  MOCK_TOOL_DONE,
  openSettings,
  patchPrefs,
  relaunchApp,
  revealInSettings,
  signUp,
  startNewThread,
  waitForComposerReady,
} from '../helpers/app.ts';
import { cutServer, restoreServer } from '../helpers/outage.ts';
import { BRISBANE, placeDeviceAt, refuseBrowserLocation } from '../helpers/location.ts';
import { BASE_URL } from '../../scripts/standup.ts';

const WEATHER = "What's the weather like today?";

describe('the location tool', () => {
  const creds = uniqueCreds();

  before(async () => {
    await signUp(creds);
    await placeDeviceAt(BRISBANE);
  });

  async function sharing(): Promise<string> {
    const res = await fetch(`${BASE_URL}/v1/prefs`, { headers: { authorization: `Bearer ${await apiToken(creds)}` } });
    return ((await res.json()) as { locationSharing: string }).locationSharing;
  }

  /** Taps the weather favourite on a new chat; resolves with its conversation
   * once the send has started. */
  async function askForTheWeather(): Promise<string> {
    await goToSurface('chat');
    await startNewThread('chat');
    const weather = (await listFavouriteQuestions(creds)).find((q) => q.text === WEATHER);
    if (!weather) throw new Error('the weather favourite is gone');
    const before = new Set((await listConversations(creds)).map((c) => c.id));
    await tap(`favourites.question.${weather.id}`);
    let convId = '';
    await browser.waitUntil(
      async () => {
        convId = (await listConversations(creds)).find((c) => !before.has(c.id))?.id ?? '';
        return convId !== '';
      },
      { timeout: 20_000, timeoutMsg: 'the weather question never started a conversation' },
    );
    return convId;
  }

  async function resultOf(convId: string): Promise<string> {
    let output = '';
    await browser.waitUntil(
      async () => {
        output = (await getToolResults(creds, convId)).at(0)?.output ?? '';
        return output !== '';
      },
      { timeout: 40_000, interval: 500, timeoutMsg: 'no location result was stored' },
    );
    return output;
  }

  it('asks first, and with "Allow once" tells the model the nearest town', async () => {
    const convId = await askForTheWeather();
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
    const convId = await askForTheWeather();
    await tap('chat.location.deny');
    expect(await resultOf(convId)).toMatch(/^The user chose not to share their location/);
    expect(await sharing()).toBe('ask');
  });

  it('asks again after a cold start while the question is up', async () => {
    await askForTheWeather();
    await waitForVisible('chat.location.bar');
    // Only a cold start proves the snapshot carries the request.
    await relaunchApp();
    await waitForComposerReady(60_000);
    await waitForFreshText('chat.location.title', 'Share your location?', 30_000);
    await tap('chat.location.deny');
    await waitForAbsent('chat.location.bar', 30_000);
  });

  it('turns to Always with "Always allow", and then answers without asking', async () => {
    const first = await askForTheWeather();
    await tap('chat.location.allowAlways');
    expect(await resultOf(first)).toContain('Brisbane, Queensland, Australia');
    expect(await sharing()).toBe('always');

    const second = await askForTheWeather();
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

    const convId = await askForTheWeather();
    expect(await resultOf(convId)).toMatch(/^The user has turned location sharing off/);
    await waitForAbsent('chat.location.bar');
    await patchPrefs(creds, { locationSharing: 'ask' });
  });

  it('cannot be answered while the server is away', async function () {
    const p = platform();
    if (p !== 'web' && p !== 'electron') this.skip(); // the page is patched; native has no page
    await askForTheWeather();
    await waitForVisible('chat.location.bar');
    await cutServer();
    try {
      await waitForTextIn('shell.offlineBanner', "Can't reach your server", 30_000);
      for (const id of ['chat.location.allowOnce', 'chat.location.allowAlways', 'chat.location.deny']) {
        expect(await byTestId(id).getAttribute('aria-disabled')).toBe('true');
      }
    } finally {
      await restoreServer();
    }
    await tap('shell.offlineRetry');
    await tap('chat.location.deny');
    await waitForAbsent('chat.location.bar', 30_000);
  });

  it('tells the model why when the browser refuses the location', async function () {
    if (platform() !== 'web') this.skip(); // see refuseBrowserLocation
    await refuseBrowserLocation();
    const convId = await askForTheWeather();
    await tap('chat.location.allowOnce');
    expect(await resultOf(convId)).toContain('location permission is turned off for Loxaic on that device');
    await placeDeviceAt(BRISBANE);
  });
});
