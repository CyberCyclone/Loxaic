/**
 * Favourite questions on the new-chat screen: the four a person starts with,
 * each sent as it is with one tap; one added from the dialog; one added on
 * another device (the API); and removing them all, which leaves only the add
 * button and stays that way across a cold start.
 *
 * What the server holds is read from the API, not only from the screen.
 */
import { uniqueCreds } from '../helpers/auth.ts';
import { shot } from '../helpers/screenshot.ts';
import { browser } from '@wdio/globals';
import {
  closeKeyboard,
  isVisible,
  platform,
  scrollTo,
  tap,
  testIdSelector,
  typeInto,
  waitForAbsent,
  waitForFreshText,
  waitForTextIn,
  waitForVisible,
} from '../helpers/selectors.ts';
import { getWindowSize, setWindowSize } from '../helpers/window.ts';
import {
  addFavouriteQuestionViaApi,
  getMessageTexts,
  goToSurface,
  listConversations,
  listFavouriteQuestions,
  mockEcho,
  relaunchApp,
  selectThread,
  signUp,
  startNewThread,
  waitForComposerReady,
} from '../helpers/app.ts';

/** `MAX_FAVOURITE_QUESTIONS` in packages/types/src/favourites.ts. */
const MAX_FAVOURITE_QUESTIONS = 12;

const DEFAULTS = [
  "What's the weather like today?",
  "What's the top news for my area and around the world?",
  'Tell me a fun fact about a random topic.',
  'Tell me a joke.',
];

/**
 * Makes the screen too short for a full list: a phone-sized viewport on web,
 * a short window on Electron; native screens are phones already. Returns how
 * to put it back.
 */
async function smallScreen(): Promise<() => Promise<void>> {
  const p = platform();
  if (p === 'web') {
    const before = await browser.execute(() => ({ width: window.innerWidth, height: window.innerHeight }));
    await browser.setViewport({ width: 375, height: 700 });
    return () => browser.setViewport(before);
  }
  if (p === 'electron') {
    const before = await getWindowSize();
    await setWindowSize(900, 560);
    return () => setWindowSize(before.width, before.height);
  }
  return () => Promise.resolve();
}

/**
 * Whether scrolling brings an element fully into view: its nearest ancestor
 * that really scrolls (computed overflow-y auto or scroll, and taller inside
 * than out) is scrolled to the end, then the element's rect is compared with
 * the ancestor's. `isDisplayed()` is true below the fold, so it cannot say this.
 */
async function scrolledIntoReach(id: string): Promise<string> {
  return browser.execute((selector: string) => {
    const el = document.querySelector(selector);
    if (!el) return 'missing';
    let box = el.parentElement;
    while (box) {
      const { overflowY } = getComputedStyle(box);
      if ((overflowY === 'auto' || overflowY === 'scroll') && box.scrollHeight > box.clientHeight) break;
      box = box.parentElement;
    }
    if (!box) return 'no scrolling ancestor';
    box.scrollTop = box.scrollHeight;
    const outer = box.getBoundingClientRect();
    const inner = el.getBoundingClientRect();
    return inner.top >= outer.top && inner.bottom <= outer.bottom + 1
      ? 'reachable'
      : `outside: ${String(inner.top)}-${String(inner.bottom)} in ${String(outer.top)}-${String(outer.bottom)}`;
  }, testIdSelector(id));
}

describe('favourite questions', () => {
  const creds = uniqueCreds();
  let jokeConversation = '';

  async function idOf(text: string): Promise<string> {
    const id = (await listFavouriteQuestions(creds)).find((q) => q.text === text)?.id;
    if (!id) throw new Error(`no favourite question "${text}"`);
    return id;
  }

  before(async () => {
    await signUp(creds);
  });

  it('starts with the defaults, and sends one as it is with a tap', async () => {
    await goToSurface('chat');
    await startNewThread('chat');
    const questions = await listFavouriteQuestions(creds);
    expect(questions.map((q) => q.text)).toEqual(DEFAULTS);
    for (const q of questions) await waitForFreshText(`favourites.label.${q.id}`, q.text);
    await shot('favourites-defaults');

    await tap(`favourites.question.${await idOf('Tell me a joke.')}`);
    await waitForTextIn('chat.messageList', mockEcho('Tell me a joke.'), 30_000);
    [{ id: jokeConversation }] = await listConversations(creds);
    expect(await getMessageTexts(creds, jokeConversation)).toContain('Tell me a joke.');
  });

  it('adds one from the dialog, and says when it is one already', async () => {
    await startNewThread('chat');
    await tap('favourites.add');
    await waitForVisible('favourites.modal.input');
    await typeInto('favourites.modal.input', 'Tell me a joke.');
    await waitForFreshText('favourites.modal.error', 'already a favourite');
    await typeInto('favourites.modal.input', 'What should I cook tonight?');
    await waitForAbsent('favourites.modal.error');
    await shot('favourites-add-dialog');
    await closeKeyboard();
    await tap('favourites.modal.save');
    await waitForAbsent('favourites.modal.input', 20_000);

    expect((await listFavouriteQuestions(creds)).map((q) => q.text)).toEqual([...DEFAULTS, 'What should I cook tonight?']);
    const id = await idOf('What should I cook tonight?');
    await waitForFreshText(`favourites.label.${id}`, 'What should I cook tonight?');
  });

  it('shows one added on another device on the next new chat', async () => {
    await addFavouriteQuestionViaApi(creds, 'Added somewhere else');
    // Away and back: a new chat mounts the list afresh.
    await selectThread(jokeConversation);
    await waitForTextIn('chat.messageList', mockEcho('Tell me a joke.'));
    await startNewThread('chat');
    await waitForFreshText(`favourites.label.${await idOf('Added somewhere else')}`, 'Added somewhere else');
  });

  it('keeps the last of a full list reachable on a small screen', async () => {
    const have = (await listFavouriteQuestions(creds)).length;
    for (let i = have; i < MAX_FAVOURITE_QUESTIONS; i++) await addFavouriteQuestionViaApi(creds, `Spare question ${String(i)}`);
    const last = (await listFavouriteQuestions(creds)).at(-1);
    if (!last) throw new Error('no favourite questions');
    const p = platform();
    const restore = await smallScreen();
    try {
      await selectThread(jokeConversation);
      await waitForTextIn('chat.messageList', mockEcho('Tell me a joke.'));
      await startNewThread('chat');
      // Full: no add button, anywhere in the list.
      await waitForFreshText(`favourites.label.${last.id}`, last.text);
      await waitForAbsent('favourites.add');
      if (p === 'web' || p === 'electron') {
        expect(await scrolledIntoReach(`favourites.question.${last.id}`)).toBe('reachable');
      } else {
        await scrollTo(`favourites.remove.${last.id}`);
        expect(await isVisible(`favourites.remove.${last.id}`)).toBe(true);
      }
      await shot('favourites-full-scrolled');
    } finally {
      await restore();
    }
  });

  it('leaves only the add button once every one is removed, across a cold start', async () => {
    for (const q of await listFavouriteQuestions(creds)) {
      await scrollTo(`favourites.remove.${q.id}`);
      await tap(`favourites.remove.${q.id}`);
      await waitForAbsent(`favourites.question.${q.id}`, 15_000);
    }
    expect(await listFavouriteQuestions(creds)).toEqual([]);
    await waitForVisible('favourites.add');
    await shot('favourites-empty');

    // A cold start opens the newest thread; the new chat is a tap away.
    await relaunchApp();
    await waitForComposerReady(60_000);
    await startNewThread('chat');
    await waitForVisible('favourites.add', 30_000);
    expect(await isVisible('favourites.loadFailed')).toBe(false);
    expect(await listFavouriteQuestions(creds)).toEqual([]);
  });
});
