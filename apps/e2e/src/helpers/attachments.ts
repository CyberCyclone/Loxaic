/**
 * Getting an image into the composer, on each platform.
 *
 * This is the one place in the suite that reaches outside the app's own
 * testIDs. On web and Electron it drives the composer's real
 * `<input type="file">` directly, which is why AttachButton.web.tsx renders a
 * persistent input rather than using expo-image-picker's transient shim.
 *
 * On iOS and Android the picker is **system UI we don't own** — PHPicker and
 * the Android photo picker — so those two branches select by OS-specific
 * accessibility traits instead of testIDs. That is a deliberate exception to
 * the rule in AGENTS.md ("never by CSS class, text position, or list index"),
 * the same category as `appium:autoDismissAlerts`: the rule protects us from
 * brittle selectors on markup we control, and this is markup Apple and Google
 * control. Keeping it to this single function means the whole suite's
 * exposure to those selectors is these few lines — a picker redesign breaks
 * one helper, not every spec.
 *
 * The image itself is seeded into the device's photo library at onPrepare
 * (see seedIosPhoto / seedAndroidPhoto in scripts/native.ts).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { $, browser } from '@wdio/globals';
import { platform, tap, waitForVisible } from './selectors.ts';

const E2E_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** The one image fixture the suite uploads. 64x64 solid crimson: unmistakable
 * in a screenshot, and small enough to be an unremarkable git blob. */
export const IMAGE_FIXTURE = path.join(E2E_DIR, 'fixtures/images/red-square.png');

/**
 * What the mock provider prepends when a turn carried images — the proof the
 * attachment survived upload, the wire, and prompt assembly, rather than just
 * rendering locally. See mockStream in apps/server/src/inference/provider.ts.
 */
export function mockImageAck(count: number): string {
  return `Received ${String(count)} image(s).`;
}

/** Attaches one image to the composer, leaving it pending (not yet sent). */
export async function attachImage(fixture: string = IMAGE_FIXTURE): Promise<void> {
  switch (platform()) {
    case 'web':
    case 'electron':
      await attachViaFileInput(fixture);
      break;
    case 'ios':
      await attachViaIosPicker();
      break;
    case 'android':
      await attachViaAndroidPicker();
      break;
  }
  // Every branch converges here: the preview chip appearing is what "attached"
  // actually means, whichever route got us there.
  await waitForVisible('composer.attachment.preview');
}

/**
 * `browser.uploadFile` ships the local file to wherever the browser session is
 * running and returns the path to use there; for a local Chrome that is a
 * temp copy, and for a remote grid it is the only way the file gets across at
 * all. `addValue` rather than `setValue`: setValue clears first, and
 * clearValue on a file input throws `invalid element state`.
 */
async function attachViaFileInput(fixture: string): Promise<void> {
  const remotePath = await browser.uploadFile(fixture);
  const input = $('input[data-testid="composer.attach.input"]');
  await input.addValue(remotePath);
}

async function attachViaIosPicker(): Promise<void> {
  await tap('composer.attach');
  await tap('composer.attach.library');
  // PHPicker presents out-of-process; its grid cells are exposed as images
  // whose label starts with "Photo". Waiting on the first cell rather than
  // tapping blind also absorbs the sheet's present animation.
  const firstPhoto = $('-ios predicate string:type == "XCUIElementTypeImage" AND name BEGINSWITH "Photo"');
  await firstPhoto.waitForDisplayed({ timeout: 30_000 });
  await firstPhoto.click();
  // Multi-select pickers need an explicit confirm; single-select dismisses
  // itself. Only tap Add if it actually rendered.
  const add = $('~Add');
  if (await add.isDisplayed().catch(() => false)) await add.click();
}

async function attachViaAndroidPicker(): Promise<void> {
  await tap('composer.attach');
  await tap('composer.attach.library');
  // The system photo picker labels each thumbnail with its date/description
  // via content-desc; matching on the resource-id of the grid item is the
  // stabler of the two, and is the same across the photo picker and the
  // older ACTION_GET_CONTENT documents UI.
  const firstPhoto = $(
    'android=new UiSelector().resourceIdMatches(".*(icon_thumbnail|thumbnail|preview_image).*").instance(0)',
  );
  await firstPhoto.waitForDisplayed({ timeout: 30_000 });
  await firstPhoto.click();
  const done = $('android=new UiSelector().textMatches("(?i)(add|done|select)")');
  if (await done.isDisplayed().catch(() => false)) await done.click();
}
