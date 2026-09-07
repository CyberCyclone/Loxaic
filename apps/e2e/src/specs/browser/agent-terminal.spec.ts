/**
 * The terminal panel, against a real container sandbox.
 *
 * Two things are being established, and each needs a shell that actually ran
 * something rather than a window that merely appeared:
 *
 * - The command reaches a real shell and its *output* comes back. The command
 *   deliberately contains arithmetic the shell must evaluate — a TTY echoes
 *   what was typed, so asserting on the literal text would pass on the echo
 *   alone and prove nothing about execution.
 * - It opens in the workspace's working directory (#62). Under container mode
 *   that used to be the home directory *above* the checkout, differing from
 *   host mode for the same request.
 *
 * Web and Electron only: the panel is xterm there (the native one is a text
 * view with a different renderer), and this is the build that has it.
 */
import { browser } from '@wdio/globals';
import { provisionUser, uniqueCreds } from '../../helpers/auth.ts';
import { shot } from '../../helpers/screenshot.ts';
import { tap, typeInto, waitForGone, waitForTextIn, waitForVisible } from '../../helpers/selectors.ts';
import {
  MOCK_TOOL_DONE,
  TOOL_PROMPT,
  goToSurface,
  listConversations,
  sendMessage,
  signIn,
  waitForRunDone,
} from '../../helpers/app.ts';

/** What the container image puts the checkout at, and so what a terminal
 * opened on a container sandbox must report as its working directory. */
const CONTAINER_WORKDIR = '/home/loxaic/repo';

/** Types a command into the panel's line input and submits it. Enter rather
 * than a button: the input's `onSubmitEditing` is what a terminal's Return
 * key means, and there is no send button to press. */
async function runCommand(command: string): Promise<void> {
  await typeInto('agent.terminal.input', command);
  await browser.keys('Enter');
}

describe('agent terminal panel', () => {
  const creds = uniqueCreds();

  before(async function () {
    this.timeout(60_000);
    await provisionUser(creds);
    await signIn(creds);
  });

  it('opens a shell in the workspace and runs a command in it', async function () {
    this.timeout(4 * 60_000);

    await goToSurface('agent');
    await tap('agent.mode.manual');

    // The workspace is created by the first tool call, not by the terminal:
    // opening one is not a reason to spin up a container, so there has to be
    // something to open into first.
    await sendMessage(TOOL_PROMPT);
    await waitForVisible('agent.permission.bar');
    await tap('agent.permission.allow');
    await waitForTextIn('chat.messageList', MOCK_TOOL_DONE);
    const [conversation] = await listConversations(creds);
    await waitForRunDone(creds, conversation.id);

    await tap('agent.terminal.toggle');
    await waitForVisible('agent.terminal.panel');
    // #62, from the outside: the shell opened where the agent's own commands
    // run, not in the home directory above it.
    await waitForTextIn('agent.terminal.status', CONTAINER_WORKDIR);
    await shot('terminal-open');

    // `$((21*2))` is evaluated by the shell, so "term-ok-42" can only come
    // from having actually run it — the echoed command line shows the
    // arithmetic verbatim.
    await runCommand('echo term-ok-$((21*2))');
    await waitForTextIn('agent.terminal.view', 'term-ok-42');

    // And the same directory again, this time asked of the shell itself.
    await runCommand('pwd');
    await waitForTextIn('agent.terminal.view', CONTAINER_WORKDIR);
    await shot('terminal-command-output');
  });

  it('closes from the panel, and reopens onto the same workspace', async function () {
    this.timeout(2 * 60_000);

    await tap('agent.terminal.close');
    await waitForGone('agent.terminal.panel');

    await tap('agent.terminal.toggle');
    await waitForVisible('agent.terminal.panel');
    await waitForTextIn('agent.terminal.status', CONTAINER_WORKDIR);
    // A fresh shell in the same workspace — the file the agent wrote earlier
    // is still there, which is what "the same workspace" means.
    await runCommand('ls');
    await waitForTextIn('agent.terminal.view', 'notes.txt');
  });
});
