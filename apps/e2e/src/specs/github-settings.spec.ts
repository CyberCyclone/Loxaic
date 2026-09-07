/**
 * Connecting and disconnecting GitHub, against the harness's mock GitHub API
 * (apps/e2e/scripts/mock-github.ts) — never the real github.com.
 *
 * `VALID_TOKEN` is the one credential the mock accepts; anything else answers
 * 401, so the "bad token" case exercises the server's real error path rather
 * than a canned client-side rejection.
 */
import { provisionUser, uniqueCreds } from '../helpers/auth.ts';
import { VALID_TOKEN } from '../../scripts/mock-github.ts';
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

  it('rejects a token the mock does not recognize, and stores nothing', async () => {
    await openGithubSettings();
    await typeInto('github.token', 'wrong-token');
    await tap('github.connect');
    await waitForVisible('github.error');
    await waitForTextIn('github.error', 'GitHub API 401');
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
});
