/**
 * Prompt reuse is reported, and never fabricated.
 *
 * Two things regressed invisibly before this existed. The history window slid
 * by one message per turn, so past message 50 every prompt was re-evaluated
 * from scratch — and nothing in the UI could have shown that, because the
 * cache figure was hardcoded to 0 and the "prompt speed" figure was
 * `prompt_tokens / ttft`, which reports ~47,000 tok/s precisely *when* the
 * cache is working. Both numbers looked plausible and neither was real.
 *
 * What's asserted here is the *provenance* contract, which is the part that
 * has to survive a refactor: the backend's own cache figure wins when it
 * exists and is labelled "cached", and a prompt-evaluation rate is shown only
 * when the backend said how many tokens it actually evaluated.
 *
 * MOCK_INFERENCE emits a full llama.cpp-shaped `timings` block, so this run
 * exercises exactly that branch. The other branch — a backend reporting
 * nothing about caching, which is every LM Studio deployment (no cache field
 * in `usage`, no /tokenize, no /slots, no /props) and where the server's own
 * `reusable_tokens` is displayed as "reused" instead — cannot be produced by
 * the mock, and is covered by `apps/server/src/inference/__tests__/
 * prompt-reuse.test.ts` plus manual verification against a real LM Studio.
 *
 * An earlier draft of this spec asserted that a conversation's first turn
 * shows no figure at all. That was wrong twice over: it is only true when the
 * backend reports no cache figure, and it passed against the mock purely
 * because the assertion ran while the reply was still streaming. Every
 * assertion below waits for the usage row itself, never for reply text.
 */
import { adminCreds, provisionAdmin } from '../helpers/auth.ts';
import { shot } from '../helpers/screenshot.ts';
import { byTestId, isVisible, tap, waitForVisible } from '../helpers/selectors.ts';
import { goToSurface, sendAndAwaitReply, signIn, startNewThread } from '../helpers/app.ts';

const MOCK_ECHO = '[Mock] Echo:';

describe('prompt reuse reporting', () => {
  before(async () => {
    await provisionAdmin();
    await signIn(adminCreds());
    await goToSurface('chat');
    await startNewThread('chat');
  });

  it("labels the backend's own cache figure as cached, not reused", async () => {
    await sendAndAwaitReply('first turn please', MOCK_ECHO);
    // Waits on the usage row, not the reply text: usage arrives with
    // message.end, well after the last token renders.
    await waitForVisible('chat.usage.reuse');
    const text = await byTestId('chat.usage.reuse').getText();
    // "cached" is a claim only the backend can support. If `reusable_tokens`
    // (our own measurement of what we offered it) ever gets preferred over
    // `cached_tokens`, or the two labels get collapsed into one, this fails.
    expect(text).toMatch(/^\d{1,3}% cached$/);
    await shot('reuse-backend-figure-labelled-cached');
  });

  it('keeps reporting a figure on the next turn', async () => {
    await sendAndAwaitReply('second turn please', MOCK_ECHO);
    await waitForVisible('chat.usage.reuse');
    expect(await byTestId('chat.usage.reuse').getText()).toMatch(/^\d{1,3}% cached$/);
    await shot('reuse-second-turn-reports-a-figure');
  });

  it('shows the figure in the context breakdown, with a rate only when one is real', async () => {
    await tap('composer.context');
    await waitForVisible('context.lastTurn.reuse');
    expect(await byTestId('context.lastTurn.reuse').getText()).toMatch(/^\d{1,3}%$/);

    // Exactly one of these, never both and never neither: a prompt-evaluation
    // *rate* only when the backend reported how many tokens it evaluated, and
    // the wall-clock cost otherwise. The bug this replaced showed a rate
    // unconditionally, computed as prompt_tokens / ttft — which reports tens
    // of thousands of tok/s precisely when the cache is working.
    const rate = await isVisible('context.lastTurn.promptRate');
    const cost = await isVisible('context.lastTurn.promptCost');
    expect(rate !== cost).toBe(true);
    // The mock reports timings, so this run must be on the rate side.
    expect(rate).toBe(true);

    await shot('reuse-context-breakdown');
  });
});
