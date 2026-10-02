/**
 * The thinking level, picked in the composer's `+` menu.
 *
 * It used to be four chips in the model picker that did nothing: a new chat
 * dropped the press, and no request carried the level, so every request went
 * out with none and the model's template chose — Qwen3.8's chooses its
 * highest. Every assertion that matters here is therefore made against what
 * the backend was sent: the mock names the thinking fields it received when a
 * prompt asks for its "thinking level", the fake llama.cpp router logs them,
 * and the mock provider records them. A menu that only *looks* right would
 * pass none of these.
 *
 * Mock models (apps/server/src/inference/models.ts): llama-3.1-8b-instruct
 * takes graded levels, qwen2.5-14b-instruct is on/off only. The mock
 * provider's models take none.
 */
import { browser } from '@wdio/globals';
import { provisionAdmin, provisionUser, uniqueCreds } from '../helpers/auth.ts';
import { mockProviderApiBase } from '../../scripts/standup.ts';
import { VALID_KEY } from '../../scripts/mock-provider.ts';
import { shot } from '../helpers/screenshot.ts';
import { byTestId, isVisible, platform, tap, waitForGone, waitForTextIn, waitForVisible } from '../helpers/selectors.ts';
import {
  chooseScratchWorkspace,
  chooseThinkingLevel,
  closePlusMenu,
  deleteProvidersWithBaseUrl,
  goToSurface,
  mockProviderRequests,
  mockThinking,
  openPlusMenu,
  openSettings,
  openThinkingFromPlusMenu,
  sendAndAwaitReply,
  sendMessage,
  signIn,
  startNewAgentRun,
  startNewThread,
  thinkingRowValue,
} from '../helpers/app.ts';
import { adminApi, downloadTinyModel, patchModel, removeMockModels, routerEvents, routerName } from '../helpers/hostModels.ts';

const GRADED = 'llama-3.1-8b-instruct';
const TOGGLE = 'qwen2.5-14b-instruct';
const PROMPT = 'what thinking level is this';

async function pickModel(id: string): Promise<void> {
  await tap('composer.model');
  await waitForVisible(`models.row.${id}`);
  await tap(`models.row.${id}`);
  await waitForGone('models.dialog', 10_000);
}

describe('the thinking level in the + menu', () => {
  const creds = uniqueCreds();

  before(async () => {
    // The admin API adds the provider and downloads the host model below.
    await provisionAdmin();
    await provisionUser(creds);
    await signIn(creds);
    await goToSurface('chat');
  });

  it('is no longer in the model picker', async () => {
    await tap('composer.model');
    await waitForVisible('models.dialog');
    for (const level of ['None', 'Low', 'Medium', 'High']) {
      expect(await isVisible(`models.thinking.${level}`)).toBe(false);
    }
    await tap(`models.row.${GRADED}`);
    await waitForGone('models.dialog', 10_000);
  });

  it('starts a new chat at the default, Medium, and sends it', async () => {
    await startNewThread('chat');
    expect(await thinkingRowValue()).toBe('Medium');
    await sendAndAwaitReply(PROMPT, mockThinking('reasoning_effort=medium'));
  });

  it("carries a level chosen on a new chat, before it exists, on that chat's first message", async () => {
    await startNewThread('chat');
    await chooseThinkingLevel('High');
    // Shown as chosen — this is the press that used to be dropped.
    await openPlusMenu();
    await waitForTextIn('composer.plus.thinking.value', 'High', 10_000);
    await openThinkingFromPlusMenu();
    if (platform() === 'web' || platform() === 'electron') {
      expect(await byTestId('composer.thinking.level.High').getAttribute('aria-selected')).toBe('true');
    }
    await shot('thinking-submenu-high');
    await closePlusMenu();
    await sendAndAwaitReply(PROMPT, mockThinking('reasoning_effort=high'));
    // Still High once the chat exists on the server.
    expect(await thinkingRowValue()).toBe('High');
  });

  it('sends a level changed mid-conversation on the next message', async () => {
    await chooseThinkingLevel('Low');
    await sendAndAwaitReply(`${PROMPT} now`, mockThinking('reasoning_effort=low'));
    await chooseThinkingLevel('None');
    expect(await thinkingRowValue()).toBe('Off');
    await sendAndAwaitReply(`${PROMPT} once more`, mockThinking('reasoning_effort=none'));
  });

  it('offers an on/off model only Off and On, and switches it with enable_thinking', async () => {
    await startNewThread('chat');
    await pickModel(TOGGLE);
    await openPlusMenu();
    await openThinkingFromPlusMenu();
    await waitForVisible('composer.thinking.level.None');
    expect(await isVisible('composer.thinking.level.Low')).toBe(false);
    expect(await isVisible('composer.thinking.level.High')).toBe(false);
    await shot('thinking-submenu-toggle');
    await tap('composer.thinking.level.Medium');
    await sendAndAwaitReply(PROMPT, mockThinking('enable_thinking=true'));
    await chooseThinkingLevel('None');
    await sendAndAwaitReply(`${PROMPT} now`, mockThinking('reasoning_effort=none'));
  });

  it('works on the agent screen too', async () => {
    await goToSurface('agent');
    await startNewAgentRun();
    await chooseScratchWorkspace();
    await pickModel(GRADED);
    await chooseThinkingLevel('Low');
    await sendAndAwaitReply(PROMPT, mockThinking('reasoning_effort=low'));
    await goToSurface('chat');
  });

  it('applies a default changed in Settings to an open screen without a reload', async () => {
    await openSettings();
    await tap('settings.thinking.Low');
    await tap('settings.save');
    // Save keeps the modal open; closing it is the person's own step.
    await tap('settings.close');
    await waitForGone('settings.close', 10_000);
    await startNewThread('chat');
    await pickModel(GRADED);
    expect(await thinkingRowValue()).toBe('Low');
    await sendAndAwaitReply(PROMPT, mockThinking('reasoning_effort=low'));
    // Back to the default for the cases after this one.
    await openSettings();
    await tap('settings.thinking.Medium');
    await tap('settings.save');
    // Save keeps the modal open; closing it is the person's own step.
    await tap('settings.close');
    await waitForGone('settings.close', 10_000);
  });

  it('opens the submenu at phone width in place of the menu, on a press but never on a hover', async function () {
    if (platform() !== 'web') this.skip();
    // A viewport, not the window: Chrome will not size a window below 500 px,
    // where the submenu still fits beside the menu.
    const before = await browser.execute(() => ({ width: window.innerWidth, height: window.innerHeight }));
    await browser.setViewport({ width: 375, height: 812 });
    try {
      await chooseThinkingLevel('Medium');
      await openPlusMenu();
      // Hovering the row must not swap the menu out from under the pointer:
      // the submenu would open in the menu's place with a level row beneath
      // it, for the next click to choose.
      await byTestId('composer.plus.thinking').moveTo();
      await browser.pause(400);
      expect(await isVisible('composer.thinking.submenu')).toBe(false);
      expect(await isVisible('composer.plus.thinking')).toBe(true);
      // A press opens it in the menu's place.
      await tap('composer.plus.thinking');
      await waitForVisible('composer.thinking.back');
      expect(await byTestId('composer.thinking.submenu').getAttribute('data-placement')).toBe('replace');
      expect(await byTestId('composer.thinking.level.Medium').getAttribute('aria-selected')).toBe('true');
      // Reachable, not merely displayed: every level row inside the viewport.
      const inside = await browser.execute(() => {
        const rows = [...document.querySelectorAll('[data-testid^="composer.thinking.level."]')];
        return rows.length > 0 && rows.every((r) => {
          const b = r.getBoundingClientRect();
          return b.top >= 0 && b.bottom <= window.innerHeight && b.left >= 0 && b.right <= window.innerWidth;
        });
      });
      expect(inside).toBe(true);
      await shot('thinking-submenu-phone-width');
      await tap('composer.thinking.back');
      await waitForVisible('composer.plus.thinking');
      await closePlusMenu();
      expect(await thinkingRowValue()).toBe('Medium');
    } finally {
      await browser.setViewport(before);
    }
  });

  describe('a model that takes no level', () => {
    const apiBase = mockProviderApiBase();
    let ref = '';

    before(async () => {
      await deleteProvidersWithBaseUrl(apiBase);
      const res = await adminApi('/v1/admin/providers', {
        method: 'POST',
        body: JSON.stringify({ name: `Thinking ${String(Date.now())}`, baseUrl: apiBase, apiKey: VALID_KEY }),
      });
      if (!res.ok) throw new Error(`[e2e] adding the mock provider failed (${String(res.status)}): ${await res.text()}`);
      const { slug } = (await res.json()) as { slug: string };
      ref = `${slug}::acme/nova-mini`;
    });

    after(async () => {
      await deleteProvidersWithBaseUrl(apiBase);
    });

    it('shows the row disabled with the reason, and sends no thinking field', async () => {
      await startNewThread('chat');
      await pickModel(ref);
      await openPlusMenu();
      await waitForTextIn('composer.plus.thinking.reason', "doesn't take a thinking level", 10_000);
      await shot('thinking-row-no-level');
      await closePlusMenu();
      await sendMessage(PROMPT);
      await waitForTextIn('chat.messageList', 'Reply from the external provider.');
      const completions = (await mockProviderRequests(apiBase)).filter((r) => r.path.endsWith('/chat/completions'));
      expect(completions.length).toBeGreaterThan(0);
      expect(completions.at(-1)?.thinkingFields).toEqual([]);
    });
  });

  describe('a downloaded host model', () => {
    let id = '';

    before(async () => {
      await removeMockModels();
      id = await downloadTinyModel();
      await patchModel(id, { enabled: true });
    });

    after(async () => {
      await removeMockModels();
    });

    it('reads its levels from the chat template and sends llama.cpp its reasoning_effort', async () => {
      await startNewThread('chat');
      // The model list is fetched when the screen loads; a new model needs it again.
      await browser.refresh();
      await waitForVisible('composer.input');
      await pickModel(id);
      await chooseThinkingLevel('High');
      await sendMessage('hello');
      await waitForTextIn('chat.messageList', `from ${routerName(id)}`);
      await browser.waitUntil(
        () => routerEvents().some((e) => e.event === 'chat' && e.model === routerName(id) && e.reasoning_effort === 'high'),
        { timeout: 10_000, timeoutMsg: `[e2e] the router never received reasoning_effort=high for ${id}` },
      );
    });
  });
});
