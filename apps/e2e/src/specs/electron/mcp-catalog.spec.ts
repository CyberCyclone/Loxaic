/**
 * Electron-only: a built-in MCP server actually starts on a packaged install.
 *
 * Every other lane's server runs on plain Node, where this cannot fail. Here
 * process.execPath is the Electron binary, and a stdio child inherits nothing
 * from the server's environment, so it runs the server as a script only if the
 * catalog's launch says to. Without that it starts as a whole Electron app and
 * the connection closes with no further explanation.
 *
 * Runs in self-contained mode only (E2E_SELF_CONTAINED=1), the one mode that
 * runs the packaged server. Test needs no real Brave key: the handshake and
 * tool listing never reach Brave's API.
 *
 * A red run is not contained. A child started without the flag ignores
 * --loxaic-data-dir and brings up the real app on the default data dir, and it
 * outlives the connection: after one, stop it and check that folder.
 */
import { browser } from '@wdio/globals';
import { SELF_CONTAINED } from '../../../scripts/electron-env.ts';
import { listMcpServers, openMcpServers, signUp } from '../../helpers/app.ts';
import { uniqueCreds } from '../../helpers/auth.ts';
import { shot } from '../../helpers/screenshot.ts';
import { byTestId, tap, typeInto, waitForTextIn } from '../../helpers/selectors.ts';

describe('electron built-in MCP server', () => {
  before(function skipUnlessSelfContained() {
    if (!SELF_CONTAINED) this.skip();
  });

  it('connects and lists its tools', async () => {
    const creds = uniqueCreds();
    await signUp(creds);
    await openMcpServers();

    await typeInto('mcp.catalogSecret.BRAVE_API_KEY', 'not-a-real-key');
    await tap('mcp.catalogEnable.brave');

    let id = '';
    await browser.waitUntil(
      async () => {
        id = (await listMcpServers(creds)).find((s) => s.builtinKey === 'brave')?.id ?? '';
        return id !== '';
      },
      { timeout: 10_000, timeoutMsg: '[e2e] enabling Brave Search stored no server' },
    );

    await tap(`mcp.serverTest.${id}`);
    await waitForTextIn(`mcp.serverRow.${id}`, 'Connected', 30_000);
    // The tool-count chip, which only shows once the listing returned tools.
    await browser.waitUntil(async () => /\b[1-9]\d* tools?\b/.test(await byTestId(`mcp.serverRow.${id}`).getText()), {
      timeout: 5_000,
      timeoutMsg: '[e2e] Brave Search connected but listed no tools',
    });
    await shot('mcp-brave-connected');
  });
});
