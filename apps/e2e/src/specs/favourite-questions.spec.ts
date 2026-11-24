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
import { closeKeyboard, tap, typeInto, waitForAbsent, waitForFreshText, waitForTextIn, waitForVisible } from '../helpers/selectors.ts';
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
} from '../helpers/app.ts';

const DEFAULTS = [
  "What's the weather like today?",
  "What's the top news for my area and around the world?",
  'Tell me a fun fact about a random topic.',
  'Tell me a joke.',
];

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

  it('leaves only the add button once every one is removed, across a cold start', async () => {
    for (const q of await listFavouriteQuestions(creds)) {
      await tap(`favourites.remove.${q.id}`);
      await waitForAbsent(`favourites.question.${q.id}`, 15_000);
    }
    expect(await listFavouriteQuestions(creds)).toEqual([]);
    await waitForVisible('favourites.add');
    await shot('favourites-empty');

    await relaunchApp();
    await waitForVisible('favourites.add', 60_000);
    expect(await listFavouriteQuestions(creds)).toEqual([]);
  });
});
