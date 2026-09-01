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

/** A small real CSV — its header line is asserted verbatim in the model's
 * mock echo, proving the server's actual extracted text (not just a chip)
 * reached the prompt. */
export const CSV_FIXTURE = path.join(E2E_DIR, 'fixtures/documents/budget.csv');

/** A small plain-text file with a distinctive phrase asserted the same way. */
export const TEXT_FIXTURE = path.join(E2E_DIR, 'fixtures/documents/notes.txt');

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

/** What the mock provider prepends when a turn carried documents — the
 * server-side analog of mockImageAck, and the same reasoning: it only fires
 * when the assembled prompt genuinely contained a provenance-wrapped
 * <attached-file> text part, proving upload → extraction → history loader →
 * content parts all held, not just that a chip rendered locally. */
export function mockDocumentAck(count: number): string {
  return `Received ${String(count)} document(s).`;
}

/**
 * Attaches one document to the composer, leaving it pending. Reuses exactly
 * the image path's mechanism on web/Electron — the file input's accept list
 * was widened to cover documents, so no new selector is needed there. Native
 * document picking goes through a different OS surface entirely (the system
 * Files app via expo-document-picker, opened by the composer.attach.file
 * actionsheet item) which has no accessibility path comparable to the photo
 * picker's — that native gap is deliberately out of e2e scope, same
 * treatment as the camera path, and is why this function only implements
 * the web/electron branch and throws clearly on ios/android rather than
 * silently no-op-ing.
 */
export async function attachDocument(fixture: string): Promise<void> {
  switch (platform()) {
    case 'web':
    case 'electron':
      await attachViaFileInput(fixture);
      break;
    case 'ios':
    case 'android':
      throw new Error(
        'attachDocument is not implemented for native — the system Files picker has no stable ' +
          'accessibility path; composer.attach.file is verified by hand, matching composer.attach.camera.',
      );
  }
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

  // Modern PHPicker opens on a "Private Access to Photos" onboarding banner
  // that sits over the grid. It has to be dismissed before any cell can be
  // reached, and it only appears the first time for a given app install — so
  // this is conditional rather than assumed.
  const close = $('~Close');
  if (await close.isDisplayed().catch(() => false)) {
    await close.click();
    await browser.pause(500);
  }

  // The grid cells are XCUIElementTypeImage named "PXGGridLayout-Info" — not
  // the "Photo…"-labelled images this used to look for, which no longer exist
  // and are why it timed out rather than mismatching.
  //
  // Waited on with waitForExist, not waitForDisplayed: XCUITest reports these
  // cells `visible="false"` even while they are plainly on screen and
  // tappable, so waiting for "displayed" would never return. Confirmed by
  // dumping the live hierarchy — a 3-column grid of 133x133 cells, every one
  // of them visible="false".
  const firstPhoto = $('-ios predicate string:type == "XCUIElementTypeImage" AND name == "PXGGridLayout-Info"');
  await firstPhoto.waitForExist({ timeout: 30_000 });

  // Tapped by coordinate rather than `.click()`. XCUITest gates element clicks
  // on its own visibility calculation, which reports these cells not visible —
  // so a plain click is accepted and then quietly does nothing, leaving the
  // picker open with no selection (confirmed: the server saw no upload at all).
  // The cell's geometry is still reported correctly, so a pointer action at its
  // centre lands where the user's finger would.
  const { x, y } = await firstPhoto.getLocation();
  const { width, height } = await firstPhoto.getSize();
  await browser.performActions([
    {
      type: 'pointer',
      id: 'finger1',
      parameters: { pointerType: 'touch' },
      actions: [
        { type: 'pointerMove', duration: 0, x: Math.round(x + width / 2), y: Math.round(y + height / 2) },
        { type: 'pointerDown', button: 0 },
        { type: 'pause', duration: 100 },
        { type: 'pointerUp', button: 0 },
      ],
    },
  ]);
  await browser.releaseActions();
  await browser.pause(500);

  // Multi-select needs an explicit confirm; single-select dismisses itself.
  // "Add" on older iOS, "Done" on newer — try whichever actually rendered.
  for (const selector of ['~Add', '~Done']) {
    const confirm = $(selector);
    if (await confirm.isDisplayed().catch(() => false)) {
      await confirm.click();
      break;
    }
  }
}

/** Smallest edge, in px, a node has to have to be a photo-grid cell rather
 * than a header control. The grid is 3 columns on a phone, so a cell is
 * roughly a third of the screen width. */
const MIN_GRID_CELL_PX = 200;

/**
 * The first photo in the system picker's grid, or null if the grid hasn't
 * rendered yet.
 *
 * Selected by **geometry**, which needs justifying: Android 16's picker
 * (`com.google.android.photopicker`) is a Jetpack Compose surface, and every
 * grid cell comes through the accessibility tree as a bare
 * `android.view.View` with an empty resource-id, content-desc, and text.
 * There is nothing semantic to match on at all — the `icon_thumbnail`-style
 * ids this helper used to look for belong to the *older*
 * `com.google.android.providers.media.module` picker and no longer exist on a
 * modern device, which is why it timed out rather than mismatching.
 *
 * So: the cells are the large, square, clickable views; the header controls
 * are small or oblong. That is a positional heuristic of exactly the kind
 * AGENTS.md forbids — for markup we own. This is Google's, and it is already
 * the sanctioned exception documented at the top of this file.
 */
async function firstGridCell(): Promise<WebdriverIO.Element | null> {
  const nodes = $$('android=new UiSelector().className("android.view.View").clickable(true)');
  for await (const node of nodes) {
    const size = await node.getSize().catch(() => null);
    if (!size || size.width < MIN_GRID_CELL_PX) continue;
    // Square-ish: a thumbnail cell, not a wide banner or a pill-shaped chip.
    if (Math.abs(size.width - size.height) > size.width * 0.2) continue;
    return node;
  }
  return null;
}

async function attachViaAndroidPicker(): Promise<void> {
  await tap('composer.attach');
  await tap('composer.attach.library');

  await browser.waitUntil(async () => (await firstGridCell()) !== null, {
    timeout: 30_000,
    timeoutMsg:
      'no photo-grid cell appeared in the Android system picker — is a photo seeded into the ' +
      'device library? (see seedAndroidPhoto in scripts/native.ts)',
  });
  const cell = await firstGridCell();
  await cell?.click();

  // Multi-select pickers need an explicit confirm; single-select dismisses
  // itself. Buttons still expose their label, unlike the grid cells.
  const done = $('android=new UiSelector().textMatches("(?i)(add|done|select)")');
  if (await done.isDisplayed().catch(() => false)) await done.click();
}
