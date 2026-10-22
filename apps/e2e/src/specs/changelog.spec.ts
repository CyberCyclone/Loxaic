/**
 * Settings → Changelog: what each release changed, read from the changelog
 * Metro wrote into this very bundle (apps/mobile/lib/changelog.generated.json,
 * from git history). The spec reads the same file, so what it expects on
 * screen is the build's real history, not a fixture.
 *
 * Full screen on a phone, a centred modal on anything wider. Links go to
 * GitHub, which no spec may reach: on the web lanes `window.open` is replaced
 * for the click and the URL it was handed is checked; on native the labels
 * are, since a tap would leave the app.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { browser } from '@wdio/globals';
import { provisionUser } from '../helpers/auth.ts';
import { shot } from '../helpers/screenshot.ts';
import {
  byTestId,
  isVisible,
  platform,
  scrollTo,
  tap,
  testIdSelector,
  waitForAbsent,
  waitForFreshText,
  waitForVisible,
} from '../helpers/selectors.ts';
import { getWindowSize } from '../helpers/window.ts';
import { openSettings, signIn } from '../helpers/app.ts';

interface Entry { sha: string; title: string; tickets: number[] }
interface Changelog {
  available: boolean;
  repoUrl: string | null;
  unreleased: Entry[];
  releases: { tag: string; date: string; entries: Entry[] }[];
}

const GENERATED = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../mobile/lib/changelog.generated.json',
);
const changelog = JSON.parse(readFileSync(GENERATED, 'utf8')) as Changelog;
const short = (sha: string) => sha.slice(0, 7);
const isWeb = () => platform() === 'web' || platform() === 'electron';

/** Every section in the order the modal shows them, Unreleased first when there is one. */
const sections = [
  ...(changelog.unreleased.length > 0 ? [{ id: 'unreleased', title: 'Unreleased', entries: changelog.unreleased }] : []),
  ...changelog.releases.map((r) => ({ id: r.tag, title: r.tag, entries: r.entries })),
];

async function openChangelog(): Promise<void> {
  await openSettings();
  await waitForVisible('settings.name');
  await scrollTo('settings.nav.changelog');
  await tap('settings.nav.changelog');
  // Swapped, not stacked: Settings is gone before the changelog is used.
  await waitForAbsent('settings.name');
  await waitForVisible('changelog.close');
}

async function closeChangelog(): Promise<void> {
  await tap('changelog.close');
  // Longer on Android: the modal is off screen within a second (timed with
  // `adb screencap`), but UiAutomator2 goes on reporting its close button for
  // up to ~20 s after a long list has been on screen.
  await waitForAbsent('changelog.close', platform() === 'android' ? 40_000 : 10_000);
}

/**
 * Flings the modal's list up until `id` shows, on native. The whole history is
 * hundreds of rows, past what `scrollTo`'s slow drags cover; a quick flick
 * carries momentum, as a thumb's does.
 */
async function flingToEnd(id: string): Promise<void> {
  const { width, height } = await browser.getWindowSize();
  const x = Math.round(width / 2);
  for (let i = 0; i < 80; i++) {
    if (await isVisible(id)) {
      // Let the last flick's momentum run out: on Android a tap on a list
      // still moving only stops it, so Close would not close.
      await browser.pause(1_500);
      return;
    }
    await browser
      .action('pointer', { parameters: { pointerType: 'touch' } })
      .move({ x, y: Math.round(height * 0.8) })
      .down()
      .move({ duration: 80, x, y: Math.round(height * 0.2) })
      .up()
      .perform();
  }
  await byTestId(id).waitForDisplayed({ timeout: 10_000 });
}

async function rectOf(id: string) {
  if (isWeb()) {
    return browser.execute((selector: string) => {
      const b = document.querySelector(selector)?.getBoundingClientRect();
      return b ? { x: b.left, y: b.top, width: b.width, height: b.height } : null;
    }, testIdSelector(id));
  }
  return byTestId(id).getElementRect(await byTestId(id).elementId);
}

async function viewport() {
  if (isWeb()) return browser.execute(() => ({ width: window.innerWidth, height: window.innerHeight }));
  return getWindowSize();
}

describe('Changelog', () => {
  before(async () => {
    expect(changelog.available).toBe(true);
    expect(changelog.releases.length).toBeGreaterThan(0);
    await signIn(await provisionUser());
  });

  // A failed case must not leave the modal over the next one's menu button.
  afterEach(async () => {
    if (await isVisible('changelog.close')) await closeChangelog();
  });

  it("lists this build's releases from its commit messages, newest first", async () => {
    await openChangelog();
    const first = sections.at(0);
    if (!first) throw new Error('no sections in the generated changelog');
    await waitForFreshText(`changelog.release.${first.id}.title`, first.title);

    const newest = changelog.releases.at(0);
    if (!newest) throw new Error('no releases');
    await scrollTo(`changelog.release.${newest.tag}.title`);
    await waitForFreshText(`changelog.release.${newest.tag}.title`, newest.tag);
    const entry = newest.entries.at(0);
    if (entry) {
      const id = `changelog.entry.${newest.tag}.${short(entry.sha)}`;
      await scrollTo(`${id}.commit.label`);
      await waitForFreshText(`${id}.title`, entry.title);
      await waitForFreshText(`${id}.commit.label`, short(entry.sha));
    }
    await shot('changelog');
    await closeChangelog();
  });

  it('names the ticket a change refers to', async () => {
    const section = sections.find((s) => s.entries.some((e) => e.tickets.length > 0));
    const entry = section?.entries.find((e) => e.tickets.length > 0);
    if (!section || !entry) throw new Error('no change in this history names a ticket');
    const ticket = entry.tickets.at(0) ?? 0;
    await openChangelog();
    const id = `changelog.entry.${section.id}.${short(entry.sha)}.ticket.${String(ticket)}.label`;
    await scrollTo(id);
    await waitForFreshText(id, `#${String(ticket)}`);
    await closeChangelog();
  });

  it('opens a ticket and a commit on GitHub', async function () {
    if (!isWeb()) this.skip();
    const section = sections.find((s) => s.entries.some((e) => e.tickets.length > 0));
    const entry = section?.entries.find((e) => e.tickets.length > 0);
    if (!section || !entry || !changelog.repoUrl) throw new Error('need a ticketed change and a GitHub origin');
    const ticket = entry.tickets.at(0) ?? 0;
    const id = `changelog.entry.${section.id}.${short(entry.sha)}`;
    await openChangelog();
    await browser.execute(() => {
      const w = window as unknown as { __opened: string[] };
      w.__opened = [];
      window.open = (url?: string | URL) => {
        w.__opened.push(String(url));
        return null;
      };
    });
    await scrollTo(`${id}.commit`);
    await tap(`${id}.ticket.${String(ticket)}`);
    await tap(`${id}.commit`);
    const opened = await browser.execute(() => (window as unknown as { __opened: string[] }).__opened);
    expect(opened).toEqual([
      `${changelog.repoUrl}/issues/${String(ticket)}`,
      `${changelog.repoUrl}/commit/${entry.sha}`,
    ]);
    await closeChangelog();
  });

  it('brings the last change of the oldest release into reach', async () => {
    const oldest = changelog.releases.at(-1);
    const last = oldest?.entries.at(-1);
    if (!oldest || !last) throw new Error('no releases');
    // The very bottom of the list: the oldest release's last change.
    const id = `changelog.entry.${oldest.tag}.${short(last.sha)}.title`;
    await openChangelog();
    if (isWeb()) {
      // Scrolled by the list's own scroll container, not scrollIntoView (which
      // would bring it on screen whatever the modal does), to the end until the
      // virtualised list has mounted the row, then measured against both the
      // container and the window.
      const reach = { scrollable: false, inside: false };
      await browser.waitUntil(async () => {
        Object.assign(reach, await browser.execute((listSel: string, rowSel: string) => {
          const list = document.querySelector<HTMLElement>(listSel);
          if (!list) return { scrollable: false, inside: false };
          const overflow = getComputedStyle(list).overflowY;
          const scrollable = (overflow === 'auto' || overflow === 'scroll') && list.scrollHeight > list.clientHeight;
          list.scrollTop = list.scrollHeight;
          const row = document.querySelector<HTMLElement>(rowSel);
          if (!row) return { scrollable, inside: false };
          const b = row.getBoundingClientRect();
          const box = list.getBoundingClientRect();
          return { scrollable, inside: b.top >= box.top && b.bottom <= box.bottom && b.bottom <= window.innerHeight };
        }, testIdSelector('changelog.list'), testIdSelector(id)));
        return reach.inside;
      }, { timeout: 20_000, interval: 250 }).catch(() => undefined);
      expect(reach).toEqual({ scrollable: true, inside: true });
    } else {
      await flingToEnd(id);
    }
    await waitForFreshText(id, last.title);
    await shot('changelog-oldest');
    await closeChangelog();
  });

  it('fills a phone screen', async function () {
    const p = platform();
    if (p === 'electron') this.skip(); // no phone-sized window: Chrome-only viewport emulation
    const before = p === 'web' ? await viewport() : null;
    if (p === 'web') await browser.setViewport({ width: 375, height: 812 });
    try {
      await openChangelog();
      const rect = await rectOf('changelog.modal');
      const size = await viewport();
      if (!rect) throw new Error('no changelog modal');
      expect(rect.width).toBeGreaterThanOrEqual(size.width - 1);
      expect(rect.height).toBeGreaterThanOrEqual(size.height - 1);
      await shot('changelog-phone');
      await closeChangelog();
    } finally {
      if (before) await browser.setViewport(before);
    }
  });

  it('is a centred modal on a wide window', async function () {
    if (!isWeb()) this.skip();
    await openChangelog();
    const rect = await rectOf('changelog.modal');
    const size = await viewport();
    if (!rect) throw new Error('no changelog modal');
    expect(rect.width).toBeLessThanOrEqual(640);
    expect(rect.width).toBeLessThan(size.width);
    expect(Math.abs(rect.x + rect.width / 2 - size.width / 2)).toBeLessThan(2);
    await shot('changelog-desktop');
    await closeChangelog();
  });
});
