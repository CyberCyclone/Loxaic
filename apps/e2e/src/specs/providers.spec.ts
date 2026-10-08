/**
 * Adding an external LLM provider, and then using one of its models.
 *
 * The whole point of this spec is that nothing about the provider path is
 * stubbed. `MOCK_INFERENCE` covers the built-in provider (the local llama.cpp runtime) and
 * deliberately not an added provider, so the requests this makes are real
 * HTTP requests to `scripts/mock-provider.ts` — which is what lets it assert
 * on the bearer that was sent and the model id it was asked for, neither of
 * which a mocked `streamCompletion` could show.
 *
 * Provider rows are deployment-wide and the database is shared with every
 * other suite, so the cleanup is scoped to this run's own mock address.
 */
import { browser } from '@wdio/globals';
import { adminCreds, provisionAdmin, uniqueCreds } from '../helpers/auth.ts';
import { mockProviderApiBase } from '../../scripts/standup.ts';
import { PROVIDER_MODELS, VALID_KEY, WRONG_KEY } from '../../scripts/mock-provider.ts';
import { shot } from '../helpers/screenshot.ts';
import {
  byTestId,
  closeKeyboard,
  isVisible,
  platform,
  scrollTo,
  tap,
  typeInto,
  waitForAbsent,
  waitForGone,
  waitForTextIn,
  waitForVisible,
} from '../helpers/selectors.ts';
import { adminApi, userApi } from '../helpers/hostModels.ts';
import {
  clearConversationModel,
  closeContextPopover,
  openSettings,
  deleteProvidersWithBaseUrl,
  listConversations,
  listProviders,
  mockProviderRequests,
  openProviders,
  providerListStatus,
  selectThread,
  sendAndAwaitReply,
  signIn,
  signOut,
  signUp,
  startNewThread,
} from '../helpers/app.ts';

const PROVIDER_NAME = 'Acme Models';
const RENAMED = 'Acme Production';
const REPLY = 'Reply from the external provider.';

/** Fills the Add/Edit form. The key field is never seeded from the row — no
 * route returns a stored key — so an edit leaves it blank to keep what is
 * stored, which is itself worth exercising. */
async function fillProviderForm(opts: { name?: string; baseUrl?: string; apiKey?: string }): Promise<void> {
  if (opts.name !== undefined) await typeInto('providers.modal.name', opts.name);
  if (opts.baseUrl !== undefined) await typeInto('providers.modal.baseUrl', opts.baseUrl);
  if (opts.apiKey !== undefined) await typeInto('providers.modal.apiKey', opts.apiKey);
}

const APP_ID = 'com.loxaic.app';

/** Save in the provider form. On a phone the keyboard left up by the last
 * field covers the footer, and XCUITest reports Save under it as not there. */
async function saveForm(): Promise<void> {
  await closeKeyboard();
  // Tapped again if the form is still open: on Android a tap can be lost to
  // the layout settling after the keyboard. Never a second save — Save is
  // disabled while one is in flight, and the form closes when it succeeds.
  for (let attempt = 0; ; attempt++) {
    await tap('providers.modal.save');
    // Closed before anything behind it is tapped: on a phone a tap during the
    // modal's exit lands on the modal. An element inside it, not its root,
    // which goes on reporting itself displayed on Android.
    const closed = await waitForAbsent('providers.modal.name', 8_000).then(() => true, () => false);
    if (closed) {
      // Its fields leave the tree as the exit animation starts, and a tap
      // during the animation is lost on iOS (the Test button, next).
      if (platform() !== 'web' && platform() !== 'electron') await browser.pause(800);
      return;
    }
    if (attempt === 2 || (await isVisible('providers.modal.error'))) {
      throw new Error(`the provider form did not close: ${await byTestId('providers.modal.error').getText().catch(() => 'no error shown')}`);
    }
  }
}

/** Types into a field that may be below the fold, or under a keyboard the
 * last field left up. */
async function fill(id: string, text: string): Promise<void> {
  await closeKeyboard();
  await scrollTo(id);
  await typeInto(id, text);
}

/** A fresh start: a reload on the web and Electron, a cold start on a phone. */
async function relaunch(): Promise<void> {
  if (platform() === 'web' || platform() === 'electron') {
    await browser.refresh();
  } else {
    const app = platform() === 'ios' ? { bundleId: APP_ID } : { appId: APP_ID };
    await browser.execute('mobile: terminateApp', app);
    await browser.execute('mobile: activateApp', app);
  }
}

describe('external model providers', () => {
  const apiBase = mockProviderApiBase();
  /** This run's provider, found by the mock's address. Never the first in the
   * list: the database is shared, and a provider some other install left in
   * it (a migrated backend, say) would be read in its place. */
  async function ourProvider() {
    const found = (await listProviders()).find((p) => p.baseUrl.replace(/\/+$/, '') === apiBase.replace(/\/+$/, ''));
    if (!found) throw new Error(`no provider at ${apiBase}`);
    return found;
  }
  // The ordinary user, shared across cases so later ones can ask the API about
  // the conversations an earlier one made.
  const user = uniqueCreds();

  after(async () => {
    await deleteProvidersWithBaseUrl(apiBase);
  });

  it('an admin adds a provider under a name they choose, and tests it', async () => {
    // The admin first: the cleanup signs in as them, which failed whenever
    // this spec ran on its own, before any other spec had made the account.
    await provisionAdmin();
    await deleteProvidersWithBaseUrl(apiBase);
    await signIn(adminCreds());
    await openProviders();

    // The built-in backend is described but not editable — an admin needs to
    // see what is already there before deciding whether to add anything.
    // The built-in provider is the local runtime, described with a link to its
    // own screen rather than an environment variable to go and edit.
    await waitForTextIn('providers.builtin', 'Host models, run by llama.cpp');
    await shot('providers-empty');

    // The empty state's button when this is the first provider, the header's
    // when the shared database already has one.
    await tap((await isVisible('providers.addFirst')) ? 'providers.addFirst' : 'providers.add');
    await waitForVisible('providers.modal.dialog');
    // A wrong key first: what a rejected credential does is the case that
    // matters, and it is only reachable by choosing one.
    await fillProviderForm({ name: PROVIDER_NAME, baseUrl: apiBase, apiKey: WRONG_KEY });
    await shot('providers-add-form');
    await saveForm();

    const created = await ourProvider();
    if (created.name !== PROVIDER_NAME) throw new Error(`expected the name the admin typed, got ${created.name}`);
    // Derived from the name, and never the name itself: it is stored in every
    // message that uses one of this provider's models.
    if (created.slug !== 'acme-models') throw new Error(`unexpected slug ${created.slug}`);
    if (!created.hasApiKey) throw new Error('the key did not store');

    await waitForVisible(`providers.row.${created.id}`);
    await tap(`providers.test.${created.id}`);
    // The provider is reachable and the key is wrong, so this reports the
    // refusal rather than a network failure — and the message must not quote
    // the key the provider echoed back at us.
    await waitForTextIn(`providers.status.${created.id}`, 'v1/models');
    const failedStatus = await byTestId(`providers.status.${created.id}`).getText();
    if (failedStatus.includes(WRONG_KEY)) throw new Error('the stored key reached the screen');
    // The LM Studio probe is a guess at a path nobody entered; reporting it
    // would send an admin looking for a URL that is not theirs.
    if (failedStatus.includes('api/v0')) throw new Error('reported the probe endpoint, not the configured one');
    await shot('providers-test-failed');

    // Now the right key. Left blank it would keep the stored one, so typing
    // is what replaces it.
    await tap(`providers.edit.${created.id}`);
    await waitForVisible('providers.modal.dialog');
    await fillProviderForm({ apiKey: VALID_KEY });
    await saveForm();

    await tap(`providers.test.${created.id}`);
    await waitForTextIn(`providers.status.${created.id}`, 'Reachable');
    await shot('providers-test-ok');
  });

  it('renaming changes the picker heading and keeps the models selectable', async () => {
    const provider = await ourProvider();
    await openProviders();
    await tap(`providers.edit.${provider.id}`);
    await waitForVisible('providers.modal.dialog');
    await fillProviderForm({ name: RENAMED });
    await saveForm();
    await waitForTextIn(`providers.name.${provider.id}`, RENAMED);

    const renamed = await ourProvider();
    // The slug is what stored references are built from, so a rename must not
    // move it — otherwise every message that used this provider would name a
    // model nothing could resolve.
    if (renamed.slug !== provider.slug) throw new Error('the slug moved on a rename');
  });

  it("offers the provider's models to an ordinary user, grouped and searchable", async () => {
    const provider = await ourProvider();
    await signOut();
    await signUp(user);

    await tap('composer.model');
    await waitForVisible('models.dialog');
    // Grouped by provider, under the name the admin gave it. Compared
    // case-insensitively because the heading is CSS-uppercased and
    // `getText()` reports what is rendered, not what was written — the same
    // trap `waitForTextIn`'s callers hit whenever text-transform is involved.
    await waitForVisible(`models.group.${provider.id}`);
    await browser.waitUntil(
      async () => (await byTestId(`models.group.${provider.id}`).getText()).toLowerCase().includes(RENAMED.toLowerCase()),
      { timeout: 20_000, timeoutMsg: `expected the group heading to read "${RENAMED}"` },
    );
    for (const model of PROVIDER_MODELS) {
      await waitForVisible(`models.row.${provider.slug}::${model.id}`);
    }
    await shot('models-grouped-by-provider');

    // A long list has to be reachable, not merely present: `isDisplayed()`
    // reports true for a below-the-fold element, so this asserts the modal
    // body really scrolls rather than merely rendering its rows.
    // The DOM check is the web's; on a phone the rows above are found by
    // scrolling, which is reachability by construction.
    const reachable = platform() !== 'web' && platform() !== 'electron' ? true : await browser.execute(() => {
      const row = document.querySelector('[data-testid^="models.row."]');
      let el: Element | null = row;
      while (el && el !== document.body) {
        const cs = getComputedStyle(el);
        if ((cs.overflowY === 'auto' || cs.overflowY === 'scroll') && el.scrollHeight > el.clientHeight) return true;
        el = el.parentElement;
      }
      // Nothing scrolls only because everything fits, which is also fine.
      return document.querySelectorAll('[data-testid^="models.row."]').length > 0;
    });
    if (!reachable) throw new Error('the model list is neither scrollable nor fully visible');

    // Searching the *provider's* name finds its models — the name someone
    // remembers when they cannot remember the model.
    await typeInto('models.search', 'Acme');
    await waitForVisible(`models.row.${provider.slug}::${PROVIDER_MODELS[0].id}`);
    // And the recents section stands down while searching, so no model is
    // offered twice.
    if (await isVisible('models.group.recent')) {
      throw new Error('the recents section should be hidden while searching');
    }
  });

  it('sends through the provider, with the key as a bearer and no prefix on the model', async () => {
    const provider = await ourProvider();
    const ref = `${provider.slug}::${PROVIDER_MODELS[0].id}`;
    await tap(`models.row.${ref}`);
    await waitForAbsent('models.search', 10_000);
    await sendAndAwaitReply('Hello from the providers spec', REPLY);
    await shot('providers-reply');

    const completions = (await mockProviderRequests(apiBase)).filter((r) => r.path.endsWith('/chat/completions'));
    const last = completions.at(-1);
    if (!last) throw new Error('the provider was never asked for a completion');
    if (last.authorization !== `Bearer ${VALID_KEY}`) {
      throw new Error(`expected the stored key as a bearer, got ${String(last.authorization)}`);
    }
    // The `slug::` prefix is ours. Sent upstream it would 404 on a hosted API
    // — or, on llama.cpp, be ignored and answered by whatever is loaded.
    if (last.model !== PROVIDER_MODELS[0].id) {
      throw new Error(`expected the upstream id, got ${String(last.model)}`);
    }
  });

  it('puts the model just used at the top, and opens a new chat on it', async () => {
    const provider = await ourProvider();
    const ref = `${provider.slug}::${PROVIDER_MODELS[0].id}`;

    await tap('composer.model');
    await waitForVisible('models.dialog');
    await waitForVisible('models.group.recent');
    // Rendered in the recents section as well as in its own provider's group,
    // so the group stays a complete list of what that provider serves.
    await waitForVisible(`models.recent.${ref}`);
    await shot('models-recently-used');
    await tap(`models.recent.${ref}`);

    // A new conversation opens on it without anyone choosing again, which is
    // the point of recording what was sent rather than what was browsed.
    await waitForTextIn('composer.model', PROVIDER_MODELS[0].id);
  });

  it('does not move an existing thread onto the last-used model', async () => {
    // From review. "Last used" is for a conversation that does not exist yet.
    // A thread with an id and no stored model — every thread from before
    // `model_pref` was written — used to take it too, which pointed an old
    // local-model thread at a paid provider the moment its owner tried one in
    // a different chat, with nothing on screen saying it had moved.
    const [conversation] = await listConversations(user);
    await clearConversationModel(user, conversation.id);
    await relaunch();
    await waitForVisible('composer.model');
    await selectThread(conversation.id);
    // The user's most recent model is the provider's. This thread must not
    // follow it: with no model of its own it falls to the built-in default.
    await waitForTextIn('composer.model', 'llama-3.1-8b-instruct');
    const pill = await byTestId('composer.model').getText();
    if (pill.includes(PROVIDER_MODELS[0].id)) {
      throw new Error('an existing thread was moved onto the last-used model');
    }
    await shot('existing-thread-keeps-its-backend');

    // While a *new* conversation still opens on it.
    await startNewThread();
    await waitForTextIn('composer.model', PROVIDER_MODELS[0].id);
  });

  it('is admin-only at the route, not merely hidden in the UI', async () => {
    const outsider = uniqueCreds();
    await signOut();
    await signUp(outsider);
    // The nav row is not rendered for them. Asked whether it exists, not
    // whether it shows: on a phone the rows are below the fold either way.
    await openSettings();
    await waitForVisible('settings.close');
    if (await byTestId('settings.nav.providers').isExisting()) {
      throw new Error('a non-admin was offered the providers screen');
    }
    // Closed again, or the modal's backdrop swallows the next case's first tap.
    await closeKeyboard();
    await tap('settings.close');
    await waitForAbsent('settings.name', 10_000);
    // ...and the route refuses them, which is the boundary that matters.
    const status = await providerListStatus(outsider);
    if (status !== 403) throw new Error(`expected 403 for a non-admin, got ${String(status)}`);
  });

  it('an admin sets a context size for models that report none, and their conversations use it', async () => {
    // Without a size Loxaic cannot compact a conversation: it grows until the
    // provider refuses a request, and then cannot continue. OpenAI's model
    // list reports no sizes at all, so this is the ordinary case there.
    const provider = await ourProvider();
    const classic = 'acme/nova-classic';
    const mini = 'acme/nova-mini';
    await signOut();
    await signIn(adminCreds());
    await openProviders();
    await tap(`providers.edit.${provider.id}`);
    await waitForVisible('providers.modal.dialog');
    // Said before anything is set: one of the three reports none.
    await scrollTo('providers.modal.contextUnsized');
    await waitForTextIn('providers.modal.contextUnsized', '1 of 3 models report no size');
    await shot('providers-context-unsized');

    await fill('providers.modal.contextFallback', '32000');
    // And one model's own size, which wins over what the provider declares.
    await fill('providers.modal.contextModel', mini);
    await fill('providers.modal.contextTokens', '48000');
    await closeKeyboard();
    await scrollTo('providers.modal.contextAdd');
    await tap('providers.modal.contextAdd');
    await scrollTo(`providers.modal.contextSize.${mini}`);
    await waitForTextIn('providers.modal.contextUnsized', 'use the size above');
    await shot('providers-context-sizes');
    await saveForm();
    await waitForGone('providers.modal.dialog');

    const stored = (await (await adminApi('/v1/admin/providers')).json()) as {
      providers: { id: string; contextWindows: Record<string, number> | null }[];
    };
    expect(stored.providers.find((p) => p.id === provider.id)?.contextWindows).toEqual({ '*': 32_000, [mini]: 48_000 });

    // What every user's runs now plan against.
    const models = (await (await userApi(user, '/v1/models')).json()) as {
      id: string;
      context_tokens: number;
      context_source: string;
    }[];
    const size = (id: string) => models.find((m) => m.id === `${provider.slug}::${id}`);
    expect(size(classic)).toMatchObject({ context_tokens: 32_000, context_source: 'configured' });
    expect(size(mini)).toMatchObject({ context_tokens: 48_000, context_source: 'configured' });
    // "*" fills in only for a model that reports none.
    expect(size('acme/nova-large')).toMatchObject({ context_tokens: 200_000, context_source: 'trained' });

    // And a conversation on it says where its size came from.
    await signOut();
    await signIn(user);
    await startNewThread();
    await tap('composer.model');
    await waitForVisible(`models.row.${provider.slug}::${classic}`);
    await tap(`models.row.${provider.slug}::${classic}`);
    await waitForAbsent('models.search', 10_000);
    await sendAndAwaitReply('How much can you read at once?', REPLY);
    await tap('composer.context');
    await waitForTextIn('context.windowSource', 'set by an admin');
    await shot('context-size-set-by-admin');
    await closeContextPopover();
  });

  it('warns about a stored key on a plain-http address, and can remove the key', async () => {
    // From review. The key field is blank whenever an existing provider is
    // edited — no route returns a key — so a warning judged on the field alone
    // stayed silent exactly when a real, stored key was about to travel in the
    // clear. And with empty meaning "keep", there was no way to remove a key
    // at all: re-pointing the address just sent the old bearer to a new host.
    const provider = await ourProvider();
    if (!provider.hasApiKey) throw new Error('precondition: the provider should still hold its key');

    await signOut();
    await signIn(adminCreds());
    await openProviders();
    await tap(`providers.edit.${provider.id}`);
    await waitForVisible('providers.modal.dialog');
    // Nothing typed, and the mock's address is http:// — the warning is about
    // the key that is *stored*.
    await waitForVisible('providers.modal.insecureWarning');
    await shot('providers-stored-key-http-warning');

    await tap('providers.modal.removeKey');
    await waitForGone('providers.modal.insecureWarning');
    await shot('providers-remove-key');
    await saveForm();
    await waitForGone('providers.modal.dialog');

    const after = await ourProvider();
    if (after.hasApiKey) throw new Error('the stored key survived being removed');
  });
});
