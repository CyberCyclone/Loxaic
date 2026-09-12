/**
 * Electron-only: the Host onboarding form (name/port/bind/public address)
 * had never been driven end to end — onboarding.spec.ts only exercises Solo
 * and Client. This drives Host through a real bind + advertise-URL choice,
 * confirms both persist to config.json, then edits the running host from
 * Settings and confirms the edit actually round-trips through a real
 * stop-and-restart of the embedded stack rather than just updating a form.
 *
 * Runs in self-contained mode only, same reasons as onboarding.spec.ts, and
 * skips (rather than fails) on a machine with no container engine — Host
 * mode's own submit button is gated on that probe, so there is nothing to
 * drive without one.
 */
import { browser } from '@wdio/globals';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { SELF_CONTAINED, selfContainedDataDir } from '../../../scripts/electron-env.ts';
import { shot } from '../../helpers/screenshot.ts';
import {
  instanceState,
  openSettings,
  probeEngine,
  returnToOnboarding,
  setMode,
  signUp,
} from '../../helpers/app.ts';
import { uniqueCreds } from '../../helpers/auth.ts';
import { testIdSelector, typeInto, waitForVisible, tap } from '../../helpers/selectors.ts';

/**
 * Host name and port both arrive pre-filled (the machine's own hostname, the
 * default port) — unlike every other field `typeInto` has driven before this
 * spec, which all started empty.
 *
 * Neither `typeInto`'s plain `setValue` nor an explicit `clearValue()` first
 * clears a pre-filled value here: both leave the DOM showing "" for a
 * moment, but the field is a React-controlled input, and whatever cleared
 * it doesn't update React's own state — so the very next render (or the
 * next real keystroke) snaps the DOM back to what React still thinks the
 * value is, and typing then appends onto *that* ("Mac.internal" + "E2E Test
 * Host"). A select-all-then-Backspace via real key presses fixes it for a
 * single modal, but `browser.keys()` targets whatever the browser's *global*
 * focus is, and a field inside a modal stacked on top of another (Settings →
 * Server settings) is exactly where that focus can land somewhere other than
 * intended — confirmed directly: it silently dropped two of four typed
 * digits there. Bypassing focus entirely — set the value through React's own
 * native input setter, then dispatch a real `input` event so React's tracker
 * sees it — is what every pre-filled field uses instead.
 */
async function retype(id: string, text: string): Promise<void> {
  await tap(id); // waits for it, and focuses it like a real user would.
  await browser.execute(
    (selector: string, value: string) => {
      const el = document.querySelector<HTMLInputElement>(selector);
      if (!el) throw new Error(`retype: no element matched ${selector}`);
      const descriptor = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
      descriptor?.set?.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    },
    testIdSelector(id),
    text,
  );
}

describe('electron host settings', () => {
  let switchedToHost = false;

  before(async function skipUnlessSelfContainedWithEngine() {
    if (!SELF_CONTAINED) return this.skip();
    const engine = await probeEngine();
    if (!engine.ok) return this.skip();
  });

  // This suite is the only one that puts the shared self-contained install
  // into Host mode — every other spec (onboarding.spec.ts's first test,
  // notably) assumes the harness's own seeded Solo config is still in force.
  // Only restore when a test actually switched it, so a skip (no engine)
  // doesn't cost an unnecessary restart on a machine with no Docker/Podman.
  after(async function restoreSolo() {
    if (!switchedToHost) return;
    await setMode({ mode: 'solo' });
  });

  it('sets up a Host with an explicit bind and public address, and both persist', async () => {
    // Flipped the moment the shared install is touched, not once the Host is
    // confirmed up. A stack that fails to start in time is exactly the case
    // that must still be restored — otherwise onboarding.spec.ts and
    // offline.spec.ts run against an install with no config and no stack,
    // and one real failure becomes a cascade whose cause is files upstream.
    // Restoring a Solo config that is already Solo is harmless.
    switchedToHost = true;
    await returnToOnboarding();
    await waitForVisible('onboarding.mode.host');
    await tap('onboarding.mode.host');
    await waitForVisible('onboarding.host.engineOk', 20_000);

    await retype('onboarding.host.name', 'E2E Test Host');
    await retype('onboarding.host.port', '4177');
    await tap('onboarding.host.bind.localhost');
    // Plain http on purpose: this only proves the explicit value wins over
    // the derived one, and an https advertise URL against a plain-http local
    // connection would risk the Secure-cookie mismatch that's a real bug
    // elsewhere, not something this spec is testing.
    await typeInto('onboarding.host.advertiseUrl', 'http://loxaic.e2e.example.com');
    await shot('onboarding-host-form');

    await tap('onboarding.host.submit');
    await browser.waitUntil(
      async () => {
        const state = await instanceState();
        return state?.mode === 'host' && !!state.apiBaseUrl;
      },
      { timeout: 60_000, interval: 1000, timeoutMsg: 'stack did not start after choosing Host' },
    );

    const state = await instanceState();
    expect(state?.host?.name).toBe('E2E Test Host');
    // The *stored* port — never the one actually listening, see the next
    // test's comment on why that's a separate, harness-overridden thing.
    expect(state?.host?.port).toBe(4177);
    expect(state?.host?.bind).toBe('localhost');
    expect(state?.host?.advertiseUrl).toBe('http://loxaic.e2e.example.com');

    // On disk, not just held in the main process's memory — proves setMode
    // actually persisted rather than only starting a stack from the input.
    const onDisk = JSON.parse(readFileSync(path.join(selfContainedDataDir ?? '', 'config.json'), 'utf8')) as {
      host: { bind: string; advertiseUrl: string | null };
    };
    expect(onDisk.host.advertiseUrl).toBe('http://loxaic.e2e.example.com');
    expect(onDisk.host.bind).toBe('localhost');

    await waitForVisible('login.submit', 30_000);
    await shot('onboarding-host-started');

    // A fresh Host has no account yet, and reaching Settings in the next
    // test needs the authenticated shell (the sidebar's menu button only
    // renders past the auth gate).
    await signUp(uniqueCreds());
  });

  it('edits the running host from Settings, and the edit survives a real stack restart', async () => {
    const before = await instanceState();
    expect(before?.mode).toBe('host');

    await openSettings();
    await waitForVisible('settings.server.edit');
    await tap('settings.server.edit');
    await waitForVisible('settings.server.port');
    await shot('settings-server-edit');

    await retype('settings.server.name', 'E2E Test Host Renamed');
    // Not the port: E2E_SELF_CONTAINED mode launches the app with
    // --loxaic-port=<E2E_PORT> (scripts/electron-env.ts / wdio.electron.ts),
    // and that flag deliberately outranks config.json's stored port on every
    // start (main.js's resolveApi/startForConfig — the harness has to keep
    // knowing where to reach the app, restart or not). So the *stored* port
    // does change here, but the *listening* one — asserted separately below
    // — never will under this harness, by design; changing it is covered by
    // the previous test's onboarding flow instead. Name and public address
    // have no such override, so they're what actually proves a save. Unlike
    // onboarding's advertiseUrl field, this one arrives pre-filled too (an
    // edit seeds every field from the current config) — retype, not
    // typeInto, or the same stale-value garbling hits this field as well.
    await retype('settings.server.advertiseUrl', 'http://loxaic-renamed.e2e.example.com');
    await tap('settings.server.save');

    await browser.waitUntil(
      async () => {
        const state = await instanceState();
        return state?.host?.name === 'E2E Test Host Renamed';
      },
      { timeout: 60_000, interval: 1000, timeoutMsg: 'edited host settings never came back after the restart' },
    );

    const after = await instanceState();
    expect(after?.mode).toBe('host');
    expect(after?.host?.advertiseUrl).toBe('http://loxaic-renamed.e2e.example.com');
    expect(after?.host?.bind).toBe('localhost');
    // The flag-pinned port, unchanged by the edit — see the comment above.
    expect(after?.listenPort).toBe(before?.listenPort);

    // On disk too, and a live health check against the (still flag-pinned)
    // apiBaseUrl — proof the restart actually completed with a working
    // server on the other end, not just that the form updated.
    const onDisk = JSON.parse(readFileSync(path.join(selfContainedDataDir ?? '', 'config.json'), 'utf8')) as {
      host: { name: string; advertiseUrl: string | null };
    };
    expect(onDisk.host.name).toBe('E2E Test Host Renamed');
    expect(onDisk.host.advertiseUrl).toBe('http://loxaic-renamed.e2e.example.com');

    const health = await browser.execute(async (url: string) => {
      const res = await fetch(`${url}/health`);
      return res.ok;
    }, after?.apiBaseUrl ?? '');
    expect(health).toBe(true);
    await shot('settings-server-restarted');
  });
});
