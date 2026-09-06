/**
 * What a user is told when an attachment doesn't fit the prompt's budget.
 *
 * The model has always been told — prompt assembly substitutes a marker naming
 * the file — but nothing reached the client, so the chip sat in the transcript
 * looking exactly like one the model could see. Someone whose file was dropped
 * got a reply that ignored it and no way to connect the two.
 *
 * Driven through the real upload path rather than seeded, because the budget
 * is measured from the *extracted* text on disk: only a real upload produces
 * the sidecar `selectAffordableAttachments` stats. Plain text is used for the
 * same reason it is used elsewhere in the suite — it extracts in-process, so
 * this needs no sandbox.
 *
 * Web-only: it depends on the composer's real `<input type="file">`, and the
 * fixtures are written at runtime because four 256 KB files are not something
 * to commit.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { adminCreds, provisionAdmin } from '../../helpers/auth.ts';
import { shot } from '../../helpers/screenshot.ts';
import { byTestId, isVisible, waitForVisible } from '../../helpers/selectors.ts';
import { attachImage } from '../../helpers/attachments.ts';
import { goToSurface, sendMessage, signIn, startNewThread } from '../../helpers/app.ts';

/** One document at the per-document cap — three fit the budget, a fourth does
 * not. Matches MAX_EXTRACTED_BYTES in @loxaic/types. */
const DOCUMENT_BYTES = 256 * 1024;

const dir = mkdtempSync(path.join(tmpdir(), 'loxaic-budget-fixtures-'));

function writeFixture(name: string): string {
  const file = path.join(dir, name);
  // Distinct leading text per file so nothing can pass by matching the wrong
  // one; the padding is what makes it fill a budget slot.
  writeFileSync(file, `${name}\n${'x'.repeat(DOCUMENT_BYTES)}`, 'utf8');
  return file;
}

describe('attachment budget', () => {
  before(async () => {
    await provisionAdmin();
    await signIn(adminCreds());
    await goToSurface('chat');
    await startNewThread('chat');
  });

  it('says nothing while the attachments still fit', async () => {
    for (const name of ['report.txt', 'appendix-a.txt']) {
      await attachImage(writeFixture(name));
      await sendMessage(`Here is ${name}`);
      await waitForVisible('chat.usage.reuse');
    }
    // The notice is a claim about what was dropped, so it must stay off the
    // screen entirely while nothing has been.
    expect(await isVisible('chat.usage.omittedAttachments')).toBe(false);
    await shot('budget-within-limit-says-nothing');
  });

  it('tells the user which attachment stopped reaching the model', async () => {
    for (const name of ['appendix-b.txt', 'latest-figures.txt']) {
      await attachImage(writeFixture(name));
      await sendMessage(`Here is ${name}`);
      await waitForVisible('chat.usage.reuse');
    }

    await waitForVisible('chat.usage.omittedAttachments');
    const notice = await byTestId('chat.usage.omittedAttachments').getText();
    // Names the file and says what to do about it — a bare "some attachments
    // were omitted" would leave the user no better off than silence.
    expect(notice).toContain('attachment budget');
    expect(notice).toMatch(/Re-attach/);
    await shot('budget-exceeded-names-the-dropped-file');
  });
});
