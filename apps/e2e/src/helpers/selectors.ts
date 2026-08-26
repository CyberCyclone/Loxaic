/**
 * The one place that knows how a `testID` becomes a selector on each platform.
 *
 * React Native surfaces `testID` differently per target — react-native-web
 * renders it as `data-testid`, iOS maps it to `accessibilityIdentifier`, and
 * Android exposes it as an (unprefixed) `resource-id`. Keeping that mapping
 * here is what lets the smoke suite be written once against plain testIDs and
 * run unchanged on every platform.
 *
 * See AGENTS.md ("testIDs and e2e selectors") for the naming convention.
 */
import { $, browser } from '@wdio/globals';

export type E2EPlatform = 'web' | 'electron' | 'ios' | 'android';

export function platform(): E2EPlatform {
  const p = process.env.E2E_PLATFORM;
  if (p === 'web' || p === 'electron' || p === 'ios' || p === 'android') return p;
  throw new Error(`E2E_PLATFORM must be web|electron|ios|android (got: ${p ?? 'unset'})`);
}

export function testIdSelector(id: string): string {
  switch (platform()) {
    case 'web':
    case 'electron':
      return `[data-testid="${id}"]`;
    case 'ios':
      // XCUITest's "accessibility id" strategy, which reads accessibilityIdentifier.
      return `~${id}`;
    case 'android':
      // Not Appium's `id` strategy: that prepends "<appPackage>:id/", which
      // never matches a testID-derived resource-id.
      return `android=new UiSelector().resourceId("${id}")`;
  }
}

export function byTestId(id: string): ReturnType<typeof $> {
  return $(testIdSelector(id));
}

export async function isVisible(id: string): Promise<boolean> {
  return await byTestId(id).isDisplayed();
}

export async function tap(id: string): Promise<void> {
  const el = byTestId(id);
  await el.waitForDisplayed();
  await el.click();
}

export async function typeInto(id: string, text: string): Promise<void> {
  const el = byTestId(id);
  await el.waitForDisplayed();
  await el.setValue(text);
}

export async function waitForVisible(id: string, timeout = 20_000): Promise<void> {
  await byTestId(id).waitForDisplayed({ timeout });
}

export async function waitForGone(id: string, timeout = 60_000): Promise<void> {
  await byTestId(id).waitForDisplayed({ timeout, reverse: true });
}

/**
 * Waits for `text` to appear anywhere inside the element identified by
 * `containerId`.
 *
 * Deliberately a substring search over the container rather than a match on
 * one element: assistant replies are rendered through the markdown component,
 * which is free to split a single logical string across several nodes, so no
 * individual element is guaranteed to hold the whole thing. It also avoids
 * indexing into the message list, which is inverted and virtualised — position
 * is not a stable way to find a message.
 */
export async function waitForTextIn(
  containerId: string,
  text: string,
  timeout = 60_000,
): Promise<void> {
  const container = byTestId(containerId);
  await container.waitForDisplayed({ timeout });
  await browser.waitUntil(
    async () => (await container.getText()).includes(text),
    {
      timeout,
      interval: 500,
      timeoutMsg: `expected "${text}" to appear in [${containerId}] within ${String(timeout)}ms`,
    },
  );
}
