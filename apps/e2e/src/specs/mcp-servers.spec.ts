/**
 * Adding an MCP server, with the credential that server needs.
 *
 * The subject is *reachability*, not rendering. The Secrets field has always
 * been in the JSX and has always been unconditional — but `ModalContent` is
 * capped at `max-h-[85%]` while the vendored `ModalBody` hardcodes
 * `scrollEnabled={false}`, so anything past the fold was clipped away with no
 * way to scroll to it. The Add form carries two fields the Edit form does not
 * (Slug, Transport), which is exactly enough to push Secrets over that edge:
 * the field was reachable when editing an existing server and unreachable when
 * creating one.
 *
 * That made it a credential bug rather than a layout nit. Creating a server is
 * the only path on which a token is entered for the first time, and the last
 * field still visible there is Environment — which is stored in plaintext,
 * while Secrets is encrypted at rest. A real GitHub PAT was stored in the
 * clear this way.
 *
 * Invisible to any snapshot of static props: nothing about the component tree
 * changes, only whether the total content passes the fold.
 */
import { browser } from '@wdio/globals';
import { provisionUser, uniqueCreds, type Credentials } from '../helpers/auth.ts';
import { shot } from '../helpers/screenshot.ts';
import { isVisible, tap, testIdSelector, typeInto, waitForGone, waitForVisible } from '../helpers/selectors.ts';
import { listMcpServers, openMcpServers, signIn } from '../helpers/app.ts';

/**
 * Whether `id` can actually be brought on screen inside the modal, and not
 * merely whether it exists.
 *
 * `isDisplayed()` is not the question. WebDriver calls a rendered element
 * displayed even when it sits below the fold of a scroll container, so
 * `waitForVisible` passes identically with the bug and without it — the
 * Secrets field was always in the DOM, and only its *reachability* changed.
 *
 * The predicate that does change is the one `revealInModal` in
 * specs/electron/tailnet.spec.ts already relies on: a scroll container counts
 * only when its computed `overflow-y` is `auto` or `scroll`. A ScrollView
 * rendered with `scrollEnabled={false}` is `overflow: hidden`, so the walk
 * finds no scrollable ancestor at all and nothing can bring the field into
 * view. (Deliberately not asserted by setting `scrollTop` directly: a
 * hidden-overflow element still scrolls *programmatically*, which would pass
 * in both states and prove nothing.)
 */
async function reachabilityInModal(id: string): Promise<{
  found: boolean;
  scrollable: boolean;
  inView: boolean;
}> {
  const result = await browser.execute((selector: string) => {
    const el = document.querySelector<HTMLElement>(selector);
    if (!el) return { found: false, scrollable: false, inView: false };
    let node = el.parentElement;
    let scroller: HTMLElement | null = null;
    while (node) {
      const overflow = getComputedStyle(node).overflowY;
      if ((overflow === 'auto' || overflow === 'scroll') && node.scrollHeight > node.clientHeight) {
        scroller = node;
        break;
      }
      node = node.parentElement;
    }
    if (!scroller) return { found: true, scrollable: false, inView: false };
    scroller.scrollTop += el.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 40;
    const box = el.getBoundingClientRect();
    const view = scroller.getBoundingClientRect();
    return { found: true, scrollable: true, inView: box.top >= view.top - 1 && box.bottom <= view.bottom + 1 };
  }, testIdSelector(id));
  await browser.pause(300);
  return result;
}

describe('MCP servers', () => {
  let creds: Credentials;

  before(async () => {
    creds = uniqueCreds();
    await provisionUser(creds);
    await signIn(creds);
  });

  /**
   * Both tests open the Add modal, and a failure inside one leaves it open —
   * its backdrop then covers the sidebar, so the *next* test fails on an
   * intercepted click into `sidebar.nav.mcp` rather than on its own subject.
   * This spec's own red run showed exactly that cascade, which reads as two
   * broken things when only one is.
   *
   * Every step swallows its error: cleanup that can fail is just a second way
   * to lose the real failure.
   */
  afterEach(async () => {
    if (await isVisible('mcp.serverModal.dialog').catch(() => false)) {
      await tap('mcp.serverModal.cancel').catch(() => undefined);
      await waitForGone('mcp.serverModal.dialog').catch(() => undefined);
    }
  });

  it('offers the encrypted Secrets field when adding a server, not only when editing one', async () => {
    await openMcpServers();
    await tap('mcp.addServer');
    await waitForVisible('mcp.serverModal.dialog');
    await waitForVisible('mcp.serverModal.name');

    // Presence only, and deliberately not the regression assertion: both of
    // these passed while the Secrets field sat below an unscrollable fold.
    await waitForVisible('mcp.serverModal.env');
    await waitForVisible('mcp.serverModal.secrets');

    // This is the assertion that fails without the fix.
    const reach = await reachabilityInModal('mcp.serverModal.secrets');
    expect(reach.found).toBe(true);
    expect(reach.scrollable).toBe(true);
    expect(reach.inView).toBe(true);

    // Captured after the reveal: a shot of the modal's top shows Name and
    // Slug and says nothing about the field this spec is about.
    await shot('mcp-add-server-secrets-reachable');

    await tap('mcp.serverModal.cancel');
    await waitForGone('mcp.serverModal.dialog');
  });

  it('stores a credential entered on the Add form encrypted, never in the environment', async () => {
    await openMcpServers();
    await tap('mcp.addServer');
    await waitForVisible('mcp.serverModal.dialog');

    await typeInto('mcp.serverModal.name', 'Secret Holder');
    await typeInto('mcp.serverModal.command', '/usr/bin/true');
    await typeInto('mcp.serverModal.env', 'MY_SETTING=plain');
    await typeInto('mcp.serverModal.secrets', 'API_KEY=sk-not-a-real-key');
    await tap('mcp.serverModal.save');
    await waitForGone('mcp.serverModal.dialog');

    // Read the stored row back through the API rather than trusting the
    // screen: the point of the field is *where the value lands*, which the
    // UI cannot show. The route strips `secrets` and reports `secretKeys`,
    // so a key appearing there is proof it went through encryptSecrets.
    const servers = await listMcpServers(creds);
    const row = servers.find((s) => s.name === 'Secret Holder');
    if (!row) throw new Error('[e2e] the server just created is not in the list');

    expect(row.secretKeys).toContain('API_KEY');
    // The plaintext column keeps the non-secret it was given and nothing else.
    expect(row.env?.MY_SETTING).toBe('plain');
    expect(JSON.stringify(row.env ?? {})).not.toContain('sk-not-a-real-key');
    await shot('mcp-server-secret-stored-encrypted');
  });
});
