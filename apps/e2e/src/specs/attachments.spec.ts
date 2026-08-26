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
import { apiToken, provisionUser, uniqueCreds } from '../helpers/auth.ts';
import { shot } from '../helpers/screenshot.ts';
import { tap, waitForGone, waitForTextIn, waitForVisible } from '../helpers/selectors.ts';
import { listConversations, selectThread, sendMessage, signUp, startNewThread } from '../helpers/app.ts';
import { attachImage, mockImageAck } from '../helpers/attachments.ts';
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
