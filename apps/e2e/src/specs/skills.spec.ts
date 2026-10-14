/**
 * Skills from the composer (#283): typing "/" lists every skill, most-used
 * first; typing more narrows the list; picking one puts "/name " in the box so
 * instructions can follow; sending it gives the model the skill's
 * instructions ahead of the message. The model can load one itself through
 * the `skill` tool, and `/compact` is one of the skills.
 *
 * The mock reports what reached the prompt ("Skill loaded: <name>", see the
 * mock in apps/server/src/inference/provider.ts), so these assert on what the
 * model was given, not only on what the screen shows.
 */
import { browser } from '@wdio/globals';
import { uniqueCreds } from '../helpers/auth.ts';
import { shot } from '../helpers/screenshot.ts';
import { byTestId, closeKeyboard, platform, tap, typeInto, waitForAbsent, waitForFreshText, waitForTextIn, waitForVisible } from '../helpers/selectors.ts';
import {
  getToolResults,
  listConversations,
  MOCK_TOOL_DONE,
  sendAndAwaitReply,
  signUp,
  startNewThread,
  waitForComposerReady,
} from '../helpers/app.ts';

const BUILT_INS = ['code-review', 'commit', 'compact', 'create-skill', 'debug', 'pr-description', 'security-review', 'write-tests'];

/** A row's vertical position: the list's order as a person sees it. */
async function rowTop(name: string): Promise<number> {
  const el = byTestId(`composer.command.${name}`);
  await el.waitForDisplayed();
  return (await el.getLocation()).y;
}

/** Empties the message box, closing the palette. */
async function clearComposer(): Promise<void> {
  if (platform() === 'web' || platform() === 'electron') await typeInto('composer.input', '');
  else await byTestId('composer.input').clearValue();
  await waitForAbsent('composer.palette');
}

/** What is in the message box: its value on the web and iOS, its text on
 * Android, whose inputs have no value attribute. */
async function inputValue(): Promise<string> {
  const input = byTestId('composer.input');
  return platform() === 'android' ? input.getText() : input.getValue();
}

describe('skills in the composer', () => {
  const creds = uniqueCreds();

  before(async () => {
    await signUp(creds);
    await waitForComposerReady();
  });

  it('lists every skill on a bare slash, and narrows the list as you type', async () => {
    await typeInto('composer.input', '/');
    await waitForVisible('composer.palette');
    // Nobody has used anything yet, so the order is by name.
    await waitForVisible('composer.command.code-review');
    if (platform() === 'web' || platform() === 'electron') {
      // The list scrolls, so on a phone only the first rows are on screen; in
      // a browser every row exists in the page.
      for (const name of BUILT_INS) expect(await byTestId(`composer.command.${name}`).isExisting()).toBe(true);
    }
    expect(await rowTop('code-review')).toBeLessThan(await rowTop('commit'));
    await shot('skills-palette-all');

    await typeInto('composer.input', '/rev');
    await waitForVisible('composer.command.code-review');
    await waitForVisible('composer.command.security-review');
    await waitForAbsent('composer.command.debug');
    await shot('skills-palette-narrowed');
  });

  it('puts a picked skill in the box, and sends its instructions with the message', async () => {
    await typeInto('composer.input', '/code');
    await tap('composer.command.code-review');
    await browser.waitUntil(async () => (await inputValue()) === '/code-review ', {
      timeout: 5_000,
      timeoutMsg: 'picking a skill did not put "/code-review " in the box',
    });
    await waitForAbsent('composer.palette');
    // Picking focuses the box, which raises a phone's keyboard; on Android it
    // covers the composer's toolbar, Send included, until it is put away.
    await closeKeyboard();

    await sendAndAwaitReply('/code-review the parser change', 'Skill loaded: code-review. Echo: /code-review the parser change');
    // On a phone the keyboard stays up after a send and the message above the
    // reply is off screen, so this is existence and text, not display.
    await waitForFreshText('chat.message.skill', 'Skill: code-review');
    await shot('skills-invoked');
  });

  it('lists the skills a person uses most first', async () => {
    await sendAndAwaitReply('/debug the first thing', 'Echo: /debug the first thing');
    await sendAndAwaitReply('/debug the second thing', 'Echo: /debug the second thing');
    await typeInto('composer.input', '/');
    await waitForVisible('composer.palette');
    // debug twice, code-review once, everything else never.
    expect(await rowTop('debug')).toBeLessThan(await rowTop('code-review'));
    expect(await rowTop('code-review')).toBeLessThan(await rowTop('commit'));
    await shot('skills-palette-most-used-first');
    await clearComposer();

    // The order above is the client's own re-sort; after a reload it is the
    // server's, from the counts it stored. A browser reload is the one cheap
    // way to start from nothing but the server.
    if (platform() !== 'web' && platform() !== 'electron') return;
    await browser.refresh();
    await waitForComposerReady();
    await typeInto('composer.input', '/');
    await waitForVisible('composer.palette');
    expect(await rowTop('debug')).toBeLessThan(await rowTop('code-review'));
    expect(await rowTop('code-review')).toBeLessThan(await rowTop('commit'));
    await clearComposer();
  });

  it('loads a skill when the model asks for one', async () => {
    await startNewThread('chat');
    await sendAndAwaitReply('please use the debug skill', MOCK_TOOL_DONE);
    const [conv] = await listConversations(creds);
    const results = await getToolResults(creds, conv.id);
    expect(results.some((r) => r.ok === true && r.output.startsWith('<skill-content name="debug" source="builtin">'))).toBe(true);
    await shot('skills-loaded-by-the-model');
  });

  it('runs /compact from the list, with what follows it as guidance', async () => {
    await typeInto('composer.input', '/comp');
    await tap('composer.command.compact');
    await browser.waitUntil(async () => (await inputValue()) === '/compact ', { timeout: 5_000 });
    await closeKeyboard();
    await typeInto('composer.input', '/compact keep the plan fully intact');
    await tap('composer.send');
    await waitForTextIn('chat.compaction.guidance', 'keep the plan fully intact');
    await shot('skills-compact-with-guidance');
  });
});
