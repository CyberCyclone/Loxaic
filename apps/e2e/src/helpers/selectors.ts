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

/**
 * Long-press, which is how the thread list exposes its row actions on every
 * platform — web's hover-only actions have no touch fallback, so the app uses
 * long-press → actionsheet everywhere.
 *
 * Three implementations, because one does not work everywhere:
 *
 * - **iOS** needs XCUITest's own `mobile: touchAndHold`. A W3C pointer
 *   sequence is delivered, but XCUITest does not synthesise the long-press
 *   recogniser from it, so the actionsheet never opens and the failure looks
 *   like a missing element rather than an ignored gesture.
 * - **Android** works with the W3C sequence via WebdriverIO's action builder.
 * - **Web/Electron** have no gesture at all: a WebDriver click is
 *   instantaneous, so react-native-web's responder never reaches its
 *   long-press delay. The press is held open with a mouse pointer sequence.
 *
 * The builder is used rather than a hand-written `performActions` payload —
 * the raw protocol wants an element *reference* as its origin and rejects a
 * WDIO element object with "invalid argument".
 */
export async function longPress(id: string, durationMs = 800): Promise<void> {
  const el = byTestId(id);
  await el.waitForDisplayed();

  if (platform() === 'ios') {
    // Seconds, and deliberately generous: at 0.8s the hold was delivered but
    // React Native's responder still resolved it as a tap (the row selected,
    // no actionsheet). XCUITest's synthesized hold needs comfortably longer
    // than RN's own 500ms threshold to be recognised as a long press.
    await browser.execute('mobile: touchAndHold', {
      elementId: await el.elementId,
      duration: Math.max(2, durationMs / 1000),
    });
    return;
  }

  const pointerType = platform() === 'android' ? 'touch' : 'mouse';
  await browser
    .action('pointer', { parameters: { pointerType } })
    .move({ origin: el })
    .down()
    .pause(durationMs)
    .up()
    .perform();
}

export async function typeInto(id: string, text: string): Promise<void> {
  const el = byTestId(id);
  await el.waitForDisplayed();

  // On web and Electron, `setValue` types character by character into what is
  // usually a React-controlled input: the component re-renders between
  // keystrokes and quietly eats some of them ("https://typo.example.com"
  // arrived as "tp:/yoeapecm"). Retrying does not help and can make it worse —
  // `clearValue` blanks the DOM but not React's state, so the next render
  // restores the old value and the retype appends onto it. Setting the value
  // through React's own native input setter and dispatching a real `input`
  // event is the one approach that survives both.
  if (platform() === 'web' || platform() === 'electron') {
    await el.click();
    await browser.execute(
      (selector: string, value: string) => {
        const node = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector);
        if (!node) throw new Error(`typeInto: no element matched ${selector}`);
        const proto = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
        // Called straight off the descriptor rather than lifted into a
        // variable first: the setter is only meaningful bound to `node`.
        Object.getOwnPropertyDescriptor(proto.prototype, 'value')?.set?.call(node, value);
        node.dispatchEvent(new Event('input', { bubbles: true }));
      },
      testIdSelector(id),
      text,
    );
    return;
  }

  await el.setValue(text);
  // XCUITest typing on the iOS 26 simulator can drop characters (see the
  // maxTypingFrequency note in wdio.ios.ts). Read the field back and retype
  // when it disagrees — except secure fields, whose value reads as bullets.
  if (platform() !== 'ios') return;
  for (let attempt = 0; attempt < 3; attempt++) {
    const value = await el.getValue().catch(() => '');
    if (value === text || /^[•*]+$/.test(value)) return;
    await el.clearValue();
    await el.setValue(text);
  }
  throw new Error(`typeInto(${id}): field still disagrees with the intended text after 3 attempts`);
}

export async function waitForVisible(id: string, timeout = 20_000): Promise<void> {
  await byTestId(id).waitForDisplayed({ timeout });
}

export async function waitForGone(id: string, timeout = 60_000): Promise<void> {
  await byTestId(id).waitForDisplayed({ timeout, reverse: true });
}

/**
 * A selector matching any element whose visible text contains `text`.
 *
 * Native only — the web/Electron path doesn't need it (see waitForTextIn).
 */
function containsTextSelector(text: string): string {
  // JSON.stringify gives a correctly quoted-and-escaped string literal for
  // both the Java (UiSelector) and NSPredicate syntaxes.
  const quoted = JSON.stringify(text);
  switch (platform()) {
    case 'android':
      return `android=new UiSelector().textContains(${quoted})`;
    case 'ios':
      // Which attribute carries the string depends on how the element was
      // built, so accept any of the three rather than betting on one.
      return `-ios predicate string:label CONTAINS ${quoted} OR name CONTAINS ${quoted} OR value CONTAINS ${quoted}`;
    case 'web':
    case 'electron':
      return `//*[contains(text(), ${quoted})]`;
  }
}

/**
 * Asserts `text` appears nowhere on the current screen — the same
 * cross-platform text lookup as `waitForTextIn`, inverted.
 *
 * A text probe rather than a testID one, deliberately: proving a control is
 * *gone* means there is no testID left to select, so its rendered label is the
 * only thing left to look for.
 */
export async function expectTextAbsent(text: string): Promise<void> {
  // Iterated with `for await`, the same way firstGridCell() consumes `$$` —
  // the chainable array is not awaited directly.
  for await (const el of $$(containsTextSelector(text))) {
    if (await el.isDisplayed().catch(() => false)) {
      throw new Error(`expected no visible element containing "${text}", but one was rendered`);
    }
  }
}

/**
 * Waits for `text` to appear inside the element identified by `containerId`.
 *
 * Never indexes into the message list to find a reply: the list is inverted
 * *and* virtualised, so position is not a stable way to identify a message.
 *
 * The two branches exist because "the text under this container" means
 * genuinely different things per platform. On the web, `getText()` returns the
 * DOM's concatenated `textContent`, so a substring search over the container
 * holds even when the markdown renderer splits a reply across several nodes.
 * On native there is no such concatenation — `getText()` on a ViewGroup returns
 * that view's own (empty) text — so the search has to go to the leaf that
 * actually carries the string.
 */
export async function waitForTextIn(
  containerId: string,
  text: string,
  timeout = 60_000,
): Promise<void> {
  const container = byTestId(containerId);
  await container.waitForDisplayed({ timeout });

  const p = platform();
  if (p === 'web' || p === 'electron') {
    await browser.waitUntil(async () => (await container.getText()).includes(text), {
      timeout,
      interval: 500,
      timeoutMsg: `expected "${text}" to appear in [${containerId}] within ${String(timeout)}ms`,
    });
    return;
  }

  await $(containsTextSelector(text)).waitForDisplayed({
    timeout,
    timeoutMsg: `expected an element containing "${text}" within ${String(timeout)}ms`,
  });
}
