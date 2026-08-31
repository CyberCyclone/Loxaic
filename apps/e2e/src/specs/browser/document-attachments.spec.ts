/**
 * Document attachments — web and Electron only, which is why this lives in
 * specs/browser/ rather than the shared glob.
 *
 * Getting a document into the composer means driving the composer's real
 * `<input type="file">`. On iOS and Android the equivalent is the system Files
 * app opened by expo-document-picker, which — unlike the photo picker the
 * image spec drives — exposes no stable accessibility path to select a file
 * with. That native gap is deliberate and matches how the camera path is
 * handled: `composer.attach.file` carries a testID and is verified by hand.
 *
 * `mockDocumentAck` is the assertion that carries the most weight, for the
 * same reason `mockImageAck` does in the image spec: the mock provider only
 * emits it when the assembled prompt genuinely contained a provenance-wrapped
 * <attached-file> part, so it proves upload -> extraction -> history loader ->
 * content parts, not merely that a chip rendered.
 */
import { $, browser } from '@wdio/globals';
import { uniqueCreds } from '../../helpers/auth.ts';
import { shot } from '../../helpers/screenshot.ts';
import { isVisible, tap, waitForGone, waitForTextIn, waitForVisible } from '../../helpers/selectors.ts';
import { listConversations, selectThread, sendMessage, signUp, startNewThread } from '../../helpers/app.ts';
import { attachDocument, CSV_FIXTURE, mockDocumentAck, TEXT_FIXTURE } from '../../helpers/attachments.ts';

describe('document attachments', () => {
  const creds = uniqueCreds();

  it('attaches a CSV and the model acknowledges its actual content', async () => {
    // Its own spec file, so its own session: this starts at the login screen
    // with no prior state, exactly like smoke.spec.ts does.
    await signUp(creds);

    await attachDocument(CSV_FIXTURE);
    // Same assertion anchor as the image case, but this time the box holds a
    // file chip (icon + filename) rather than a thumbnail — what would look
    // wrong if the non-image render branch regressed.
    await waitForVisible('composer.attachment.preview');
    await shot('document-attachment-pending');

    await sendMessage('what does this file say');
    await waitForTextIn('chat.messageList', mockDocumentAck(1));
    // The mock echoes the assembled prompt, so the CSV's real header line
    // appearing here is proof the actual extracted text reached the model —
    // not just that upload succeeded.
    await waitForTextIn('chat.messageList', 'quarter,region,revenue');
    await waitForVisible('chat.attachment.thumb');
    await shot('document-attachment-sent');
  });

  it('opens the document preview and closes it again', async () => {
    await tap('chat.attachment.thumb');
    await waitForVisible('documentPreview.modal');
    // The preview shows the cached extraction via GET /v1/files/:ref/text —
    // asserting the real CSV content appears here (not just that the modal
    // opened) proves that route end to end too.
    await waitForTextIn('documentPreview.modal', 'quarter,region,revenue');
    await shot('document-preview');

    await tap('documentPreview.close');
    await waitForGone('documentPreview.modal');
  });

  it('sends a text file with no message text, and the extracted content survives a thread switch', async () => {
    await attachDocument(TEXT_FIXTURE);
    await tap('composer.send');
    await waitForTextIn('chat.messageList', mockDocumentAck(1));
    // The distinctive phrase from notes.txt, proving the *text* fixture's
    // real content reached the prompt too, not just the CSV's.
    await waitForTextIn('chat.messageList', 'pangolin-77');

    // Covers the same lazy per-thread history load the image spec's "still
    // shows the image after switching away and back" case does, combined
    // with a second assertion into one case rather than duplicated as its
    // own test — the mechanism being proven (history round-trips through
    // Postgres) is identical to the image case, already covered there in
    // full; this only needs to confirm documents take the same path, not
    // re-prove the mechanism from scratch.
    const [withDoc] = await listConversations(creds);
    await startNewThread('chat');
    await waitForVisible('composer.input');
    await waitForGone('chat.attachment.thumb');
    await selectThread(withDoc.id, 'chat');
    await waitForVisible('chat.attachment.thumb');
  });

  it('rejects a file type the server does not accept', async () => {
    // A .bin extension with no recognizable mime and no allowlisted
    // extension — resolveAttachmentMime (packages/types/src/stream-protocol.ts)
    // returns null for both the client-side pre-check (addWebFiles in
    // useComposerAttachments.ts) and, independently, the server's own upload
    // gate. addWebFiles's rejection branch is synchronous (no upload is even
    // attempted), so there is nothing async to wait out — checking isVisible
    // right after the file lands is exactly as reliable as checking it a
    // second later, unlike sandbox-settings.spec.ts's isVisible checks this
    // mirrors (which follow the same "assert the observable outcome, not the
    // toast copy" idiom). Asserting on the OBSERVABLE outcome (no pending
    // attachment chip appears) rather than the toast text, since toast copy
    // is more likely to drift than behavior.
    const { writeFileSync } = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const badFile = path.join(os.tmpdir(), 'unsupported.bin');
    writeFileSync(badFile, Buffer.from([0x00, 0x01, 0x02, 0x03]));

    const remotePath = await browser.uploadFile(badFile);
    await $('input[data-testid="composer.attach.input"]').addValue(remotePath);

    if (await isVisible('composer.attachment.preview')) {
      throw new Error('an unsupported file type should not have been staged as a pending attachment');
    }
  });
});
