/**
 * Favourite questions on the new-chat screen: the four a person starts with,
 * each sent as it is with one tap; one added from the dialog; one added on
 * another device (the API); an add refused because another device filled the
 * list; a double tap on remove; and removing them all, which leaves only the
 * add button and stays that way across a cold start.
 *
 * What the server holds is read from the API, not only from the screen.
 */
import { uniqueCreds } from '../helpers/auth.ts';
import { shot } from '../helpers/screenshot.ts';
import { browser } from '@wdio/globals';
import { pauseServer, resumeServer } from '../helpers/server.ts';
import {
  closeKeyboard,
  doubleTap,
  expectNeverPresent,
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
  deleteFavouriteQuestionViaApi,
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

  afterEach(() => {
    resumeServer();
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

  it('says so when another device filled the list meanwhile, and shows what it added', async () => {
    await tap('favourites.add');
    await waitForVisible('favourites.modal.input');
    const have = (await listFavouriteQuestions(creds)).length;
    for (let i = have; i < MAX_FAVOURITE_QUESTIONS; i++) await addFavouriteQuestionViaApi(creds, `Spare question ${String(i)}`);
    const last = (await listFavouriteQuestions(creds)).at(-1);
    if (!last) throw new Error('no favourite questions');

    await typeInto('favourites.modal.input', 'One too many');
    await closeKeyboard();
    await tap('favourites.modal.save');
    await waitForFreshText('favourites.modal.error', `up to ${String(MAX_FAVOURITE_QUESTIONS)} favourite questions`);
    await tap('favourites.modal.cancel');
    await waitForAbsent('favourites.modal.input', 20_000);
    // The refusal asked for the list again: the other device's questions are
    // there without leaving this screen.
    if (platform() === 'ios' || platform() === 'android') await scrollTo(`favourites.remove.${last.id}`);
    await waitForFreshText(`favourites.label.${last.id}`, last.text, 15_000);
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
      if (p === 'web' || p === 'electron') {
        await waitForFreshText(`favourites.label.${last.id}`, last.text);
        expect(await scrolledIntoReach(`favourites.question.${last.id}`)).toBe('reachable');
      } else {
        // UiAutomator2 does not list a card below the fold at all: scroll first.
        await scrollTo(`favourites.remove.${last.id}`);
        expect(await isVisible(`favourites.remove.${last.id}`)).toBe(true);
        await waitForFreshText(`favourites.label.${last.id}`, last.text);
      }
      // Full: no add button after the last one.
      await waitForAbsent('favourites.add');
      await shot('favourites-full-scrolled');
    } finally {
      await restore();
    }
  });

  it('removes one once when its X is tapped twice before the server answers', async () => {
    // The spares go the way they came, from another device.
    for (const q of await listFavouriteQuestions(creds)) {
      if (q.text.startsWith('Spare question')) await deleteFavouriteQuestionViaApi(creds, q.id);
    }
    await selectThread(jokeConversation);
    await waitForTextIn('chat.messageList', mockEcho('Tell me a joke.'));
    await startNewThread('chat');
    const before = await listFavouriteQuestions(creds);
    const [first] = before;
    await waitForFreshText(`favourites.label.${first.id}`, first.text);

    // Held, so the second tap lands while the first DELETE is unanswered.
    pauseServer();
    try {
      await doubleTap(`favourites.remove.${first.id}`);
      await browser.pause(300);
    } finally {
      resumeServer();
    }
    await waitForAbsent(`favourites.question.${first.id}`, 15_000);
    expect((await listFavouriteQuestions(creds)).map((q) => q.id)).toEqual(before.slice(1).map((q) => q.id));
    // A repeat sent anyway would answer 404 and say the removal failed.
    await expectNeverPresent(['shell.toast'], 4_000);
  });

  it('leaves only the add button once every one is removed, across a cold start', async function () {
    this.timeout(6 * 60_000);
    // A new chat shows the rest, which are removed here.
    await selectThread(jokeConversation);
    await waitForTextIn('chat.messageList', mockEcho('Tell me a joke.'));
    await startNewThread('chat');
    const left = await listFavouriteQuestions(creds);
    expect(left.length).toBeGreaterThan(0);
    await waitForFreshText(`favourites.label.${left[0].id}`, left[0].text);
    for (const q of left) {
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
