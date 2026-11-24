/**
 * The server's half of the location tool, against the real server over real
 * sockets: a device that says it can share a location (`caps=location`) is
 * asked, and its answer reaches the model as the nearest town; an app too old
 * to say so is never waited on. The apps' prompt follows in the next change;
 * until then this is the whole round trip. Web only: it drives no UI.
 *
 * "weather" makes the mock call `get_location` (inference/provider.ts), and
 * its reply quotes what the tool returned.
 */
import { browser } from '@wdio/globals';
import { uniqueCreds } from '../../helpers/auth.ts';
import { getMessageTexts, getToolResults, MOCK_TOOL_DONE, patchPrefs, sendFromDevice, signUp } from '../../helpers/app.ts';

const BRISBANE = { lat: -27.4679, lon: 153.0281 };

describe('the location tool, server side', () => {
  const creds = uniqueCreds();

  before(async () => {
    await signUp(creds);
  });

  async function resultOf(conversationId: string): Promise<string> {
    let output = '';
    await browser.waitUntil(
      async () => {
        output = (await getToolResults(creds, conversationId)).at(0)?.output ?? '';
        return output.length > 0;
      },
      { timeout: 30_000, interval: 250, timeoutMsg: 'no get_location result was stored' },
    );
    return output;
  }

  it('never waits on an app that cannot share a location', async () => {
    const device = await sendFromDevice(creds, "What's the weather like today?", { caps: false });
    try {
      expect(await resultOf(device.conversationId)).toMatch(/^None of the user's devices that can share a location is connected/);
      expect(device.requests).toEqual([]);
    } finally {
      device.close();
    }
  });

  it("asks a device that can, and names the town it answers from", async () => {
    const device = await sendFromDevice(creds, "What's the weather like today?", {
      caps: true,
      answer: { outcome: 'shared', location: BRISBANE, tz: 'Australia/Brisbane' },
    });
    try {
      const output = await resultOf(device.conversationId);
      expect(output).toMatch(/^Approximate location: Brisbane, Queensland, Australia \(latitude -27\.47, longitude 153\.03/);
      expect(output).toMatch(/Local time: .* \(Australia\/Brisbane, UTC\+10:00\)\.$/);
      expect(device.requests).toMatchObject([{ kind: 'device.request', request: 'location', ask: true }]);
      // The model was told it: the mock's wrap-up quotes the result.
      await browser.waitUntil(
        async () =>
          (await getMessageTexts(creds, device.conversationId)).some((t) =>
            t.startsWith(`${MOCK_TOOL_DONE} Approximate location: Brisbane`),
          ),
        { timeout: 30_000, interval: 250, timeoutMsg: "the mock's reply never quoted the location" },
      );
    } finally {
      device.close();
    }
  });

  it('with Always allow, has the device answer without asking', async () => {
    await patchPrefs(creds, { locationSharing: 'always' });
    const device = await sendFromDevice(creds, "What's the top news for my area and around the world?", {
      caps: true,
      answer: { outcome: 'shared', location: BRISBANE, tz: 'Australia/Brisbane' },
    });
    try {
      expect(await resultOf(device.conversationId)).toContain('Brisbane, Queensland, Australia');
      expect(device.requests).toMatchObject([{ ask: false }]);
    } finally {
      device.close();
      await patchPrefs(creds, { locationSharing: 'ask' });
    }
  });
});
