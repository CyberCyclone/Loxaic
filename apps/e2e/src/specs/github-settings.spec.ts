/**
 * Connecting and disconnecting GitHub, against the harness's mock GitHub API
 * (apps/e2e/scripts/mock-github.ts) — never the real github.com.
 *
 * `VALID_TOKEN` is the one credential the mock accepts; anything else answers
 * 401, so the "bad token" case exercises the server's real error path rather
 * than a canned client-side rejection.
 */
import { provisionUser, uniqueCreds } from '../helpers/auth.ts';
import { METADATA_ONLY_TOKEN, VALID_TOKEN } from '../../scripts/mock-github.ts';
import { shot } from '../helpers/screenshot.ts';
import { tap, typeInto, waitForTextIn, waitForVisible } from '../helpers/selectors.ts';
import { openGithubSettings, signIn } from '../helpers/app.ts';

describe('GitHub connection', () => {
  before(async () => {
    const creds = uniqueCreds();
    await provisionUser(creds);
    await signIn(creds);
  });

  it('shows nothing connected before a token is entered', async () => {
    await openGithubSettings();
    await waitForVisible('github.token');
  });

  it('says which permissions a token needs before one is entered', async () => {
    await openGithubSettings();
    await waitForVisible('github.setup');
    // The instructions are the deliverable: someone arriving here should not
    // have to find out from a failed clone which permissions to grant.
    await waitForTextIn('github.setup', 'Contents: Read and write');
    await waitForTextIn('github.setup', 'Pull requests: Read and write');
    await shot('github-setup-instructions');
  });

  it('rejects a token the mock does not recognize, and stores nothing', async () => {
    await openGithubSettings();
    await typeInto('github.token', 'wrong-token');
    await tap('github.connect');
    await waitForVisible('github.error');
    // Deliberately not GitHub's raw body: `GitHub API 401: {"message":"Bad
    // credentials"}` named neither of the two things that actually cause it.
    await waitForTextIn('github.error', 'rejected by GitHub');
    await shot('github-connect-rejected');
  });

  it('connects with a valid token and shows who it connected as', async () => {
    await openGithubSettings();
    await typeInto('github.token', VALID_TOKEN);
    await tap('github.connect');
    await waitForVisible('github.status');
    await waitForTextIn('github.status', 'e2e-bot');
    await shot('github-connected');
  });

  it('persists the connection across a navigation', async () => {
    await openGithubSettings();
    await waitForVisible('github.status');
    await waitForTextIn('github.status', 'e2e-bot');
  });

  it('disconnects, returning to the connect form', async () => {
    await openGithubSettings();
    await waitForVisible('github.status');
    await tap('github.disconnect');
    await waitForVisible('github.token');
    await shot('github-disconnected');
  });

  it('says what a fine-grained token does not report, instead of showing nothing', async () => {
    // A fine-grained token sends no scopes header, so the card used to render
    // no permission line at all — silence, for exactly the token type where
    // "Connected" says least about whether anything will work.
    await openGithubSettings();
    await typeInto('github.token', METADATA_ONLY_TOKEN);
    await tap('github.connect');
    await waitForVisible('github.status');
    await waitForTextIn('github.status.permissions', 'Contents');
    await shot('github-connected-fine-grained');
  });
});
