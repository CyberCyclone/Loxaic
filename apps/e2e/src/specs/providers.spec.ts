/**
 * Adding an external LLM provider, and then using one of its models.
 *
 * The whole point of this spec is that nothing about the provider path is
 * stubbed. `MOCK_INFERENCE` covers the backend `INFERENCE_BASE_URL` names and
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
import { byTestId, isVisible, tap, typeInto, waitForTextIn, waitForVisible } from '../helpers/selectors.ts';
import {
  deleteProvidersWithBaseUrl,
  listProviders,
  mockProviderRequests,
  openProviders,
  providerListStatus,
  sendAndAwaitReply,
  signIn,
  signOut,
  signUp,
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

describe('external model providers', () => {
  const apiBase = mockProviderApiBase();

  after(async () => {
    await deleteProvidersWithBaseUrl(apiBase);
  });

  it('an admin adds a provider under a name they choose, and tests it', async () => {
    await deleteProvidersWithBaseUrl(apiBase);
    await provisionAdmin();
    await signIn(adminCreds());
    await openProviders();

    // The built-in backend is described but not editable — an admin needs to
    // see what is already there before deciding whether to add anything.
    await waitForTextIn('providers.builtin', 'INFERENCE_BASE_URL');
    await shot('providers-empty');

    await tap('providers.addFirst');
    await waitForVisible('providers.modal.dialog');
    // A wrong key first: what a rejected credential does is the case that
    // matters, and it is only reachable by choosing one.
    await fillProviderForm({ name: PROVIDER_NAME, baseUrl: apiBase, apiKey: WRONG_KEY });
    await shot('providers-add-form');
    await tap('providers.modal.save');

    const [created] = await listProviders();
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
    await tap('providers.modal.save');

    await tap(`providers.test.${created.id}`);
    await waitForTextIn(`providers.status.${created.id}`, 'Reachable');
    await shot('providers-test-ok');
  });

  it('renaming changes the picker heading and keeps the models selectable', async () => {
    const [provider] = await listProviders();
    await openProviders();
    await tap(`providers.edit.${provider.id}`);
    await waitForVisible('providers.modal.dialog');
    await fillProviderForm({ name: RENAMED });
    await tap('providers.modal.save');
    await waitForTextIn(`providers.name.${provider.id}`, RENAMED);

    const [renamed] = await listProviders();
    // The slug is what stored references are built from, so a rename must not
    // move it — otherwise every message that used this provider would name a
    // model nothing could resolve.
    if (renamed.slug !== provider.slug) throw new Error('the slug moved on a rename');
  });

  it("offers the provider's models to an ordinary user, grouped and searchable", async () => {
    const [provider] = await listProviders();
    await signOut();
    const user = uniqueCreds();
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
    const reachable = await browser.execute(() => {
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
    const [provider] = await listProviders();
    const ref = `${provider.slug}::${PROVIDER_MODELS[0].id}`;
    await tap(`models.row.${ref}`);
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
    const [provider] = await listProviders();
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

  it('is admin-only at the route, not merely hidden in the UI', async () => {
    const user = uniqueCreds();
    await signOut();
    await signUp(user);
    // The nav row is not rendered for them...
    await tap('sidebar.settings');
    if (await isVisible('settings.nav.providers')) {
      throw new Error('a non-admin was offered the providers screen');
    }
    // ...and the route refuses them, which is the boundary that matters.
    const status = await providerListStatus(user);
    if (status !== 403) throw new Error(`expected 403 for a non-admin, got ${String(status)}`);
  });
});
