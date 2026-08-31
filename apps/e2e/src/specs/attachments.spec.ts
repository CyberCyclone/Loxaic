/**
 * Image attachments, end to end: pick → upload → send → render → view, plus
 * the two negative cases the feature's server-side guards exist for.
 *
 * Runs unchanged on every platform. The only platform-shaped step is getting
 * an image into the composer, which lives in helpers/attachments.ts — see its
 * comment for why the native branches are the suite's one sanctioned use of
 * non-testID selectors.
 *
 * The assertion that matters most is `mockImageAck`: the mock provider only
 * emits it when the assembled prompt actually contained image parts, so it
 * proves the whole chain (multipart upload → ownership check → content
 * blocks → history loader → OpenAI content parts) rather than just that a
 * thumbnail rendered locally.
 *
 * The camera path is deliberately not covered: the iOS simulator has no
 * camera at all, so there is nothing to drive. It carries a testID
 * (`composer.attach.camera`) and is verified by hand.
 */
import { $, browser } from '@wdio/globals';
import { apiToken, provisionUser, uniqueCreds } from '../helpers/auth.ts';
import { shot } from '../helpers/screenshot.ts';
import { isVisible, tap, waitForGone, waitForTextIn, waitForVisible } from '../helpers/selectors.ts';
import { listConversations, selectThread, sendMessage, signOut, signUp, startNewThread } from '../helpers/app.ts';
import {
  attachDocument,
  attachImage,
  CSV_FIXTURE,
  mockDocumentAck,
  mockImageAck,
  TEXT_FIXTURE,
} from '../helpers/attachments.ts';
import { BASE_URL } from '../../scripts/standup.ts';

describe('image attachments', () => {
  const creds = uniqueCreds();

  it('attaches an image and the model acknowledges receiving it', async () => {
    await signUp(creds);

    await attachImage();
    // The preview chip is the pre-send state: uploaded, staged, not yet part
    // of a message. It is what would look wrong if upload silently failed.
    await shot('attachment-pending');

    await sendMessage('describe this');
    await waitForTextIn('chat.messageList', mockImageAck(1));
    await waitForVisible('chat.attachment.thumb');
    await shot('attachment-sent');
  });

  it('opens the attachment fullscreen and closes again', async () => {
    await tap('chat.attachment.thumb');
    await waitForVisible('viewer.image');
    await shot('attachment-viewer');

    await tap('viewer.close');
    await waitForGone('viewer.image');
  });

  it('removes a staged attachment before sending', async () => {
    await attachImage();
    await tap('composer.attachment.remove');
    await waitForGone('composer.attachment.preview');
  });

  it('sends an image with no text at all', async () => {
    // Regression guard on the three places that used to reject empty content
    // outright — the composer's send(), and both WS handlers' send guard.
    // An image on its own is a complete message.
    await attachImage();
    await tap('composer.send');
    await waitForTextIn('chat.messageList', mockImageAck(1));
    await shot('attachment-no-text');
  });

  it('still shows the image after switching away and back', async () => {
    // Also covers the lazy per-thread history load: a non-active thread's
    // messages are fetched on selection, and the attachment has to survive
    // that round trip through Postgres — not just live in local state.
    // Selecting by real conversation id rather than list position, since
    // sending anything reorders the list.
    const [withImage] = await listConversations(creds);

    await startNewThread('chat');
    await waitForVisible('composer.input');
    await waitForGone('chat.attachment.thumb');

    await selectThread(withImage.id, 'chat');
    await waitForVisible('chat.attachment.thumb');
    await shot('attachment-history');
  });

  it('refuses to serve one user an attachment belonging to another', async () => {
    // A UI-only check can't prove this — the browser session is the owner, so
    // it would pass either way. Asserted straight against the API, mirroring
    // sandbox-settings.spec.ts's non-admin PATCH check.
    const ref = await uploadAs(creds, 'first-user.png');

    const other = await provisionUser();
    const otherToken = await apiToken(other);
    const foreign = await fetch(`${BASE_URL}/v1/files/${ref}`, {
      headers: { authorization: `Bearer ${otherToken}` },
    });
    if (foreign.status !== 404) {
      throw new Error(`foreign attachment fetch should be 404, got ${String(foreign.status)}`);
    }

    // …and a ref that never existed must be indistinguishable from one that
    // does but isn't yours, or the 404/403 split becomes an existence oracle.
    const missing = await fetch(`${BASE_URL}/v1/files/00000000-0000-4000-8000-000000000000`, {
      headers: { authorization: `Bearer ${otherToken}` },
    });
    if (missing.status !== foreign.status) {
      throw new Error(
        `nonexistent (${String(missing.status)}) and not-yours (${String(foreign.status)}) must match`,
      );
    }
  });
});

describe('document attachments', () => {
  const creds = uniqueCreds();

  it('attaches a CSV and the model acknowledges its actual content', async () => {
    // The previous describe block leaves the session signed in (its last
    // test only makes raw API calls, no navigation) — sign out first so
    // signUp finds the login screen it expects, same as any other spec that
    // hands off between two different users in one browser session.
    await signOut();
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

/** Uploads the fixture through the API as a given user, returning its ref. */
async function uploadAs(
  creds: Parameters<typeof apiToken>[0],
  filename: string,
): Promise<string> {
  const { readFileSync } = await import('node:fs');
  const { IMAGE_FIXTURE } = await import('../helpers/attachments.ts');
  const token = await apiToken(creds);
  const form = new FormData();
  form.append('file', new Blob([readFileSync(IMAGE_FIXTURE)], { type: 'image/png' }), filename);
  const res = await fetch(`${BASE_URL}/v1/files`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: form,
  });
  if (!res.ok) throw new Error(`upload failed (${String(res.status)}): ${await res.text()}`);
  const body = (await res.json()) as { ref: string };
  return body.ref;
}
