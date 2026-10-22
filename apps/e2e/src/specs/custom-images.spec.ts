/**
 * Custom sandbox images (#253), end to end against a real private registry
 * (scripts/mock-registry.ts): the admin policy, shared images loaded with a
 * deployment login, a person's own images with their own login, the new-chat
 * chooser, and an agent run that really happens inside the chosen image.
 *
 * What must never happen is checked as carefully as what must: a person
 * without a login cannot pull a private image another person already has on
 * the engine, and nobody's chooser offers anyone else's own images.
 *
 * Web and Electron run every case. On a phone the pull-progress and refusal
 * states are reached by the same server code, seeded through the API, since
 * typing a registry login into a sheet adds nothing the web case does not
 * already show; the screens, the chooser and a run in the image are driven
 * there too.
 */
import { BASE_URL, mockRegistry } from '../../scripts/standup.ts';
import { REGISTRY_PASSWORD, REGISTRY_USERNAME } from '../../scripts/mock-registry.ts';
import { adminCreds, apiToken, provisionAdmin, provisionUser, uniqueCreds, type Credentials } from '../helpers/auth.ts';
import { shot } from '../helpers/screenshot.ts';
import {
  expectNeverPresent,
  isSwitchOn,
  isVisible,
  platform,
  scrollTo,
  tap,
  typeInto,
  waitForAbsent,
  waitForFreshText,
  waitForSwitch,
  waitForTextIn,
  waitForVisible,
} from '../helpers/selectors.ts';
import {
  BASH_PROMPT,
  MOCK_BASH_OUTPUT,
  execInSandbox,
  getToolResults,
  goToSurface,
  listConversations,
  listSandboxes,
  openSettings,
  patchSandboxSettings,
  pauseAllMySandboxes,
  resetSandboxSettings,
  sendMessage,
  signIn,
  signOut,
  startNewAgentRun,
  waitForToolResult,
} from '../helpers/app.ts';

const native = () => platform() === 'ios' || platform() === 'android';

interface ImageRow { id: string; reference: string; status: string; error: string | null; usable: boolean }

async function api(creds: Pick<Credentials, 'email' | 'password'>, method: string, pathname: string, body?: unknown): Promise<unknown> {
  const token = await apiToken(creds);
  const res = await fetch(`${BASE_URL}${pathname}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`[e2e] ${method} ${pathname} failed (${String(res.status)}): ${text}`);
  return text ? JSON.parse(text) : null;
}

async function images(creds: Credentials, scope: 'shared' | 'personal'): Promise<ImageRow[]> {
  const base = scope === 'shared' ? '/v1/admin/images' : '/v1/images/mine';
  return ((await api(creds, 'GET', base)) as { images: ImageRow[] }).images;
}

/**
 * Waits, through the API, for an image's latest pull to finish. `want` waits
 * for that status instead: right after a Pull tap the row can still show the
 * previous pull's outcome, which "not pulling" alone would accept.
 */
async function settled(creds: Credentials, scope: 'shared' | 'personal', reference: string, want?: 'ready'): Promise<ImageRow> {
  let found: ImageRow | undefined;
  try {
    await browser.waitUntil(
      async () => {
        found = (await images(creds, scope)).find((i) => i.reference === reference);
        return found !== undefined && found.status !== 'pulling' && (want === undefined || found.status === want);
      },
      { timeout: 180_000, interval: 1_000 },
    );
  } catch {
    throw new Error(`${reference} never ${want ? `became ${want}` : 'finished pulling'}; last seen: ${JSON.stringify(found ?? null)}`);
  }
  if (!found) throw new Error('unreachable');
  return found;
}

async function choices(creds: Credentials): Promise<{ id: string; reference: string }[]> {
  return ((await api(creds, 'GET', '/v1/images')) as { images: { id: string; reference: string }[] }).images;
}

/** Opens the chooser and picks an image (by id) for an empty workspace. */
async function chooseImage(id: string): Promise<void> {
  await tap('agent.workspace.button');
  await waitForVisible('agent.workspace.dialog');
  await tap('agent.workspace.source.scratch');
  await scrollTo(`agent.workspace.image.${id}`);
  await tap(`agent.workspace.image.${id}`);
  await scrollTo('agent.workspace.confirm');
  await tap('agent.workspace.confirm');
  await waitForAbsent('agent.workspace.dialog', 10_000);
}

/** Runs the mock's bash call in the open agent chat and waits for it. */
async function runBash(): Promise<void> {
  await tap('agent.mode.manual');
  await sendMessage(BASH_PROMPT);
  await waitForVisible('agent.permission.bar', 120_000);
  await tap('agent.permission.allow');
  await waitForToolResult(MOCK_BASH_OUTPUT);
}

describe('custom sandbox images (#253)', function () {
  this.timeout(600_000);
  const registry = { host: '', marker: '', noSetsid: '' };
  let user: Credentials;
  let other: Credentials;
  let sharedId = '';

  before(async () => {
    Object.assign(registry, mockRegistry());
    await provisionAdmin();
    await resetSandboxSettings();
    user = await provisionUser(uniqueCreds());
    other = await provisionUser(uniqueCreds());
  });

  after(async () => {
    // Shared rows and logins are deployment-wide; take them out so a later
    // spec, or the next run, starts from none.
    const admin = adminCreds();
    for (const row of await images(admin, 'shared').catch(() => [])) {
      await api(admin, 'DELETE', `/v1/admin/images/${row.id}`).catch(() => undefined);
    }
    const logins = ((await api(admin, 'GET', '/v1/admin/images/logins').catch(() => ({ logins: [] }))) as { logins: { id: string }[] }).logins;
    for (const login of logins) await api(admin, 'DELETE', `/v1/admin/images/logins/${login.id}`).catch(() => undefined);
    await resetSandboxSettings();
  });

  it('offers nothing while custom images are off', async () => {
    await signIn(adminCreds());
    await openSettings();
    await scrollTo('settings.nav.sandbox');
    expect(await isVisible('settings.nav.containerImages')).toBe(false);
    expect(await isVisible('settings.nav.myImages')).toBe(false);
    await tap('settings.nav.sandbox');
    await scrollTo('sandbox.customImages.off');
    await waitForFreshText('sandbox.customImages.summary', "Loxaic's own image");
    await shot('custom-images-off');
  });

  it('lets an admin load a shared image, refused with a wrong login and pulled with the right one', async () => {
    const admin = adminCreds();
    await scrollTo('sandbox.customImages.shared');
    await tap('sandbox.customImages.shared');
    await waitForFreshText('sandbox.customImages.summary', 'an admin loads');

    if (native()) {
      await api(admin, 'PUT', '/v1/admin/images/logins', { registry: registry.host, username: REGISTRY_USERNAME, password: 'not-the-password' });
      await api(admin, 'POST', '/v1/admin/images', { reference: registry.marker, label: 'Marker' });
    } else {
      await openSettings();
      await scrollTo('settings.nav.containerImages');
      await tap('settings.nav.containerImages');
      await waitForVisible('images.intro');
      await typeInto('images.login.registry', registry.host);
      await typeInto('images.login.username', REGISTRY_USERNAME);
      await typeInto('images.login.password', 'not-the-password');
      await tap('images.login.save');
      await typeInto('images.add.reference', registry.marker);
      await typeInto('images.add.label', 'Marker');
      await tap('images.add.submit');
    }
    const refused = await settled(admin, 'shared', registry.marker);
    sharedId = refused.id;
    expect(refused.status).toBe('failed');
    expect(refused.error).toMatch(/refused/);
    expect(refused.error).not.toContain('not-the-password');

    if (native()) {
      await api(admin, 'PUT', '/v1/admin/images/logins', { registry: registry.host, username: REGISTRY_USERNAME, password: REGISTRY_PASSWORD });
      await api(admin, 'POST', `/v1/admin/images/${sharedId}/pull`);
      await openSettings();
      await scrollTo('settings.nav.containerImages');
      await tap('settings.nav.containerImages');
    } else {
      await waitForFreshText(`images.image.status.${sharedId}`, 'refused');
      await shot('custom-images-refused-login');
      await typeInto('images.login.registry', registry.host);
      await typeInto('images.login.username', REGISTRY_USERNAME);
      await typeInto('images.login.password', REGISTRY_PASSWORD);
      await tap('images.login.save');
      await scrollTo(`images.image.pull.${sharedId}`);
      await tap(`images.image.pull.${sharedId}`);
    }
    await settled(admin, 'shared', registry.marker, 'ready');
    await scrollTo(`images.image.status.${sharedId}`);
    await waitForFreshText(`images.image.status.${sharedId}`, 'Ready', 60_000);
    await shot('custom-images-shared-ready');
  });

  it("refuses an image that lacks what Loxaic's tools need, naming it", async () => {
    const admin = adminCreds();
    const added = (await api(admin, 'POST', '/v1/admin/images', { reference: registry.noSetsid, label: 'No setsid' })) as ImageRow;
    const row = await settled(admin, 'shared', registry.noSetsid);
    expect(row.status).toBe('failed');
    expect(row.error).toMatch(/setsid/);
    // Added behind the screen's back, so it is opened again to list it.
    await openSettings();
    await scrollTo('settings.nav.containerImages');
    await tap('settings.nav.containerImages');
    await scrollTo(`images.image.status.${added.id}`);
    await waitForFreshText(`images.image.status.${added.id}`, 'setsid', 60_000);
    await shot('custom-images-missing-tool');
    await api(admin, 'DELETE', `/v1/admin/images/${added.id}`);
  });

  it('runs a standard user’s agent chat in the shared image, with no My Images for them', async () => {
    await signOut();
    await signIn(user);
    await openSettings();
    await scrollTo('settings.nav.sandbox');
    expect(await isVisible('settings.nav.myImages')).toBe(false);
    expect(await isVisible('settings.nav.containerImages')).toBe(false);
    await shot('custom-images-user-settings');
    await tap('settings.close');
    await waitForAbsent('settings.nav.sandbox');

    await goToSurface('agent');
    await startNewAgentRun();
    await chooseImage(sharedId);
    await shot('custom-images-chosen');
    await runBash();

    const token = await apiToken(user);
    const [sandbox] = await listSandboxes(token);
    const marker = await execInSandbox(token, sandbox.id, 'cat /opt/marker && id -u && test ! -e /tmp/entrypoint-ran && echo no-entrypoint');
    expect(marker.stdout).toContain('custom-image-marker');
    expect(marker.stdout).toContain('1234');
    expect(marker.stdout).toContain('no-entrypoint');
  });

  it("keeps a person's own image theirs: no login, no pull; their own login, their own list", async () => {
    await patchSandboxSettings({ customImages: 'everyone' });
    // Nobody else's login helps: the shared one is the deployment's.
    await api(other, 'POST', '/v1/images/mine', { reference: registry.marker, label: 'Mine' });
    const refused = await settled(other, 'personal', registry.marker);
    expect(refused.status).toBe('failed');
    expect(refused.error).toMatch(/refused/);

    await api(other, 'PUT', '/v1/images/mine/logins', { registry: registry.host, username: REGISTRY_USERNAME, password: REGISTRY_PASSWORD });
    await api(other, 'POST', `/v1/images/mine/${refused.id}/pull`);
    await settled(other, 'personal', registry.marker, 'ready');

    // An admin's own image is as private as anyone's.
    const adminsOwn = (await api(adminCreds(), 'POST', '/v1/images/mine', { reference: registry.marker, label: 'Admin own' })) as ImageRow;

    const forOther = (await choices(other)).map((c) => c.id);
    const forUser = (await choices(user)).map((c) => c.id);
    expect(forOther).toContain(refused.id);
    expect(forOther).toContain(sharedId);
    expect(forUser).not.toContain(refused.id);
    expect(forUser).toEqual([sharedId]);
    expect(forOther).not.toContain(adminsOwn.id);

    // And on screen: the user's chooser offers the shared image only.
    await signOut();
    await signIn(user);
    await goToSurface('agent');
    await startNewAgentRun();
    await tap('agent.workspace.button');
    await waitForVisible('agent.workspace.dialog');
    await scrollTo(`agent.workspace.image.${sharedId}`);
    expect(await isVisible(`agent.workspace.image.${refused.id}`)).toBe(false);
    await shot('custom-images-chooser-others-hidden');
    await tap('agent.workspace.confirm');
    await waitForAbsent('agent.workspace.dialog', 10_000);

    if (!native()) {
      await signOut();
      await signIn(other);
      await openSettings();
      await scrollTo('settings.nav.myImages');
      await tap('settings.nav.myImages');
      await waitForFreshText(`images.image.status.${refused.id}`, 'Ready', 60_000);
      await shot('custom-images-my-images');
      await signOut();
      await signIn(user);
    }
  });

  it("applies an admin's limits to the shared image's sandboxes", async () => {
    await api(adminCreds(), 'PATCH', `/v1/admin/images/${sharedId}`, { limits: { memoryMb: 768, cpus: 0.5, pids: 200 } });
    await goToSurface('agent');
    await startNewAgentRun();
    await chooseImage(sharedId);
    await runBash();
    const token = await apiToken(user);
    const [sandbox] = await listSandboxes(token);
    const limits = await execInSandbox(token, sandbox.id, 'cat /sys/fs/cgroup/memory.max /sys/fs/cgroup/pids.max');
    expect(limits.stdout.split('\n').map((l) => l.trim())).toEqual(expect.arrayContaining([String(768 * 1024 * 1024), '200']));
  });

  it('lets an admin give a shared image KVM, kept when its sizes are saved, and says when a host lacks it (#320)', async () => {
    const admin = adminCreds();
    const { kvm } = (await api(admin, 'GET', '/v1/admin/images')) as { kvm?: { visible: boolean } };
    await signOut();
    await signIn(admin);
    await openSettings();
    await scrollTo('settings.nav.containerImages');
    await tap('settings.nav.containerImages');
    await scrollTo(`images.image.kvm.${sharedId}`);
    expect(await isSwitchOn(`images.image.kvm.${sharedId}`)).toBe(false);
    // Off, the image never needs the device: nothing to warn about yet.
    await expectNeverPresent([`images.image.kvm.warning.${sharedId}`]);
    await waitForTextIn(`images.image.kvm.risk.${sharedId}`, 'host kernel');
    await tap(`images.image.kvm.${sharedId}`);
    await waitForSwitch(`images.image.kvm.${sharedId}`, true);
    const kvmOf = async () =>
      ((await api(admin, 'GET', '/v1/admin/images')) as { images: { id: string; limits: { kvm?: boolean } | null }[] }).images.find(
        (i) => i.id === sharedId,
      )?.limits?.kvm;
    await browser.waitUntil(async () => (await kvmOf()) === true, { timeout: 15_000, timeoutMsg: '[e2e] KVM was not saved' });
    if (kvm?.visible === false) {
      // Under the switch, below a phone's fold.
      await scrollTo(`images.image.kvm.warning.${sharedId}`);
      await waitForFreshText(`images.image.kvm.warning.${sharedId}`, "can't see /dev/kvm");
    }
    else await expectNeverPresent([`images.image.kvm.warning.${sharedId}`]);
    await shot('custom-images-kvm');

    // Saving the sizes leaves it on: they are sent without it.
    await api(admin, 'PATCH', `/v1/admin/images/${sharedId}`, { limits: { memoryMb: 768, cpus: 0.5, pids: 200 } });
    expect(await kvmOf()).toBe(true);

    // A sandbox from it gets the device, or a refusal that names it. The
    // earlier cases' sandboxes are paused first, so the answer is about KVM
    // and not a full allocation (#254).
    await pauseAllMySandboxes(user);
    await signOut();
    await signIn(user);
    await goToSurface('agent');
    await startNewAgentRun();
    await chooseImage(sharedId);
    await tap('agent.mode.manual');
    await sendMessage(BASH_PROMPT);
    await waitForVisible('agent.permission.bar', 120_000);
    await tap('agent.permission.allow');
    const [conversation] = await listConversations(user);
    let result: { ok?: boolean; output: string } | undefined;
    await browser.waitUntil(
      async () => {
        result = (await getToolResults(user, conversation.id)).at(0);
        return result !== undefined;
      },
      { timeout: 120_000, interval: 1_000, timeoutMsg: '[e2e] the bash call never finished' },
    );
    if (kvm?.visible === false) {
      expect(result?.ok).toBe(false);
      expect(result?.output).toContain('no /dev/kvm');
    } else {
      expect(result?.ok).toBe(true);
      const token = await apiToken(user);
      const [sandbox] = await listSandboxes(token, conversation.id);
      // Opened by the image's own user, not merely present.
      const open = await execInSandbox(token, sandbox.id, 'test -c /dev/kvm && test -r /dev/kvm && test -w /dev/kvm && echo yes');
      expect(open.stdout.trim()).toBe('yes');
    }
    await api(admin, 'PATCH', `/v1/admin/images/${sharedId}`, { limits: { kvm: false } });
  });
});
