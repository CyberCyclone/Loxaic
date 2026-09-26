/**
 * An account suspended while it is signed in.
 *
 * A ban lands out of band — `UPDATE "user" SET banned = true`, the way an
 * operator applies one (AGENTS.md, "banned is enforced by our own
 * middleware"). The user's live socket is re-checked on its next message and
 * closed with 4001; the app then asks the server who it is, and a banned user
 * has to be told nobody. The session route used to skip the ban, so the app
 * heard "all fine", reconnected, was refused again, and went on doing that
 * indefinitely under a banner blaming the server.
 */
import { closeDb, db, eq } from '@loxaic/db';
import { user } from '@loxaic/db/schema';
import { uniqueCreds } from '../helpers/auth.ts';
import { mockEcho, sendAndAwaitReply, sendMessage, signUp } from '../helpers/app.ts';
import { shot } from '../helpers/screenshot.ts';
import { waitForVisible } from '../helpers/selectors.ts';

describe('an account suspended while signed in', () => {
  const creds = uniqueCreds();

  before(async () => {
    await signUp(creds);
    await sendAndAwaitReply('hello', mockEcho('hello'));
  });

  after(async () => {
    await closeDb();
  });

  it('is signed out on its next message, not left reconnecting', async () => {
    await db.update(user).set({ banned: true, banExpires: null }).where(eq(user.email, creds.email));
    await sendMessage('still here?');
    await waitForVisible('login.submit', 20_000);
    await shot('suspended-signed-out');
  });
});
