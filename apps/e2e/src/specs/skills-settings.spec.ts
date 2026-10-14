/**
 * A person's own skills (#283), from Settings → Skills: added, used with
 * "/name", edited mid-conversation (the model is told, the prompt's front is
 * not touched), and deleted. Built-ins cannot be edited — overriding one is
 * adding a skill of the same name — and both rows say so while it lasts.
 * Overriding `/compact` makes it a message like any other skill.
 *
 * What reached the model is read from the stored rows and the mock's echo
 * ("Skill loaded", "Skills updated"), not only from the screen.
 */
import { browser } from '@wdio/globals';
import { uniqueCreds } from '../helpers/auth.ts';
import { shot } from '../helpers/screenshot.ts';
import {
  byTestId,
  closeKeyboard,
  platform,
  scrollTo,
  tap,
  typeInto,
  waitForAbsent,
  waitForFreshText,
  waitForVisible,
} from '../helpers/selectors.ts';
import {
  getStoredBlocks,
  goToSurface,
  listConversations,
  listMySkills,
  openSkills,
  selectThread,
  sendAndAwaitReply,
  signUp,
  startNewThread,
} from '../helpers/app.ts';

/** Fills the skill form that is open and saves it. */
async function fillAndSave(fields: { name?: string; description?: string; body?: string }): Promise<void> {
  if (fields.name !== undefined) await typeInto('skillModal.name', fields.name);
  if (fields.description !== undefined) await typeInto('skillModal.description', fields.description);
  if (fields.body !== undefined) await typeInto('skillModal.body', fields.body);
  await closeKeyboard();
  await tap('skillModal.save');
  await waitForAbsent('skillModal.dialog', 20_000);
}

async function idOf(creds: Parameters<typeof listMySkills>[0], name: string): Promise<string> {
  const id = (await listMySkills(creds)).mine.find((s) => s.name === name)?.id;
  if (!id) throw new Error(`no skill called ${name}`);
  return id;
}

describe('your own skills', () => {
  const creds = uniqueCreds();
  let convId = '';

  before(async () => {
    await signUp(creds);
  });

  it('lists the built-ins, read-only, with a way to read each one', async () => {
    await openSkills();
    await waitForVisible('skills.mine.empty');
    await scrollTo('skills.builtin.debug.view');
    await tap('skills.builtin.debug.view');
    await waitForFreshText('skillView.description', "Find and fix a bug's root cause");
    await shot('skills-screen-view-builtin');
    await tap('skillView.close');
    await waitForAbsent('skillView.dialog');
  });

  it('adds a skill, with a Save that can be reached, and runs it with /name', async () => {
    await tap('skills.add');
    await waitForVisible('skillModal.dialog');
    if (platform() === 'web' || platform() === 'electron') {
      // On screen, not merely in the page: the form is taller than a short
      // window, and only the body scrolls.
      const save = byTestId('skillModal.save');
      const { y } = await save.getLocation();
      const { height } = await save.getSize();
      const viewport = await browser.execute(() => window.innerHeight);
      expect(y + height).toBeLessThanOrEqual(viewport);
    }
    await fillAndSave({
      name: 'release-notes',
      description: 'Writes release notes from merged pull requests. Use when preparing a release.',
      body: 'Group the changes by area.',
    });
    const id = await idOf(creds, 'release-notes');
    // The list may be scrolled down from the last case; the new row is at the top.
    await scrollTo(`skills.row.${id}.name`);
    await shot('skills-screen-added');

    await goToSurface('chat');
    await startNewThread('chat');
    await sendAndAwaitReply('/release-notes for 1.2', 'Skill loaded: release-notes. Echo: /release-notes for 1.2');
    await waitForFreshText('chat.message.skill', 'Skill: release-notes (yours)');
    [{ id: convId }] = await listConversations(creds);
    const invoked = (await getStoredBlocks(creds, convId)).find((b) => b.kind === 'skill');
    expect(invoked).toMatchObject({ name: 'release-notes', source: 'user' });
    expect(invoked?.text).toContain('Group the changes by area.');
  });

  it('tells the model when a skill is edited mid-conversation', async () => {
    await openSkills();
    const id = await idOf(creds, 'release-notes');
    await tap(`skills.row.${id}.edit`);
    await fillAndSave({ body: 'Group the changes by package.' });

    await goToSurface('chat');
    await selectThread(convId);
    await sendAndAwaitReply('and the next one', 'Skills updated: release-notes. Echo: and the next one');
    await waitForFreshText('chat.message.skillsUpdate', 'Skills changed: changed release-notes');
    await shot('skills-edited-mid-conversation');
  });

  it('overrides a built-in from its row, and says so on both sides', async () => {
    await openSkills();
    await scrollTo('skills.builtin.code-review.override');
    await tap('skills.builtin.code-review.override');
    await waitForVisible('skillModal.overrideNote');
    await fillAndSave({ body: 'Check our house rules first.' });
    const id = await idOf(creds, 'code-review');
    await scrollTo('skills.builtin.code-review.overridden');
    await scrollTo(`skills.row.${id}.overrides`);
    await shot('skills-overridden-builtin');

    await goToSurface('chat');
    await startNewThread('chat');
    await sendAndAwaitReply('/code-review the parser', 'Skill loaded: code-review. Echo: /code-review the parser');
    await waitForFreshText('chat.message.skill', 'Skill: code-review (yours)');
    const [conv] = await listConversations(creds);
    const invoked = (await getStoredBlocks(creds, conv.id)).find((b) => b.kind === 'skill');
    expect(invoked?.text).toContain('Check our house rules first.');
  });

  it('overrides compact, which then sends the skill instead of compacting', async () => {
    await openSkills();
    await scrollTo('skills.builtin.compact.override');
    await tap('skills.builtin.compact.override');
    await fillAndSave({ description: 'Our own summary.', body: 'Summarise in three bullet points.' });

    await goToSurface('chat');
    await selectThread(convId);
    await sendAndAwaitReply('/compact keep it short', 'Skill loaded: compact. Echo: /compact keep it short');
    // A message the model answered, and no compaction.
    expect((await getStoredBlocks(creds, convId)).some((b) => b.kind === 'compaction')).toBe(false);
  });

  it('deletes a skill only once confirmed, and an override gives the built-in back', async () => {
    await openSkills();
    const id = await idOf(creds, 'code-review');
    await tap(`skills.row.${id}.delete`);
    await tap('skills.deleteConfirm.cancel');
    // Let the dialog finish closing first: on Android a tap while it is still
    // going lands on it, and the next Delete opened nothing. Re-queried each
    // poll, since a closed modal's element goes on reporting displayed.
    await waitForAbsent('skills.deleteConfirm.cancel');
    // The list may be scrolled down from the last case; the new row is at the top.
    await scrollTo(`skills.row.${id}.name`);

    await tap(`skills.row.${id}.delete`);
    await tap('skills.deleteConfirm.confirm');
    await waitForAbsent(`skills.row.${id}.name`);
    await waitForAbsent('skills.builtin.code-review.overridden');
    expect((await listMySkills(creds)).builtin.find((b) => b.name === 'code-review')?.overriddenBy).toBeNull();
    await shot('skills-override-deleted');
  });
});
