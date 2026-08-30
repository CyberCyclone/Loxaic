/**
 * The parity claim: the same approved-tool-call flow works identically
 * whether the sandbox is a container or the host, and switching between them
 * takes effect live — no server restart, exactly what
 * apps/server/src/settings.ts's runtime-apply exists for.
 *
 * `bash` (not `fs_write`, which smoke.spec.ts already covers) is the probe
 * here specifically because its mock output differs only in *where* it ran,
 * not in what it says — see MOCK_BASH_OUTPUT in helpers/app.ts.
 */
import { adminCreds, provisionAdmin } from '../helpers/auth.ts';
import { shot } from '../helpers/screenshot.ts';
import { tap, waitForTextIn, waitForVisible } from '../helpers/selectors.ts';
import {
  BASH_PROMPT,
  MOCK_BASH_OUTPUT,
  goToSurface,
  openSandboxSettings,
  resetSandboxSettings,
  sendMessage,
  setSandboxMode,
  signIn,
  startNewAgentRun,
} from '../helpers/app.ts';

describe('sandbox bash parity', () => {
  before(async () => {
    await provisionAdmin();
    // Mode now lives in the database, so it survives the process. A previous
    // run killed mid-flight (Ctrl-C, CI timeout) never runs its after() hook
    // and leaves the row on whatever it had set — this test would then start
    // against an inherited mode instead of the container default it assumes.
    await resetSandboxSettings();
    await signIn(adminCreds());
  });

  after(async () => {
    // Mode is global server state — a later spec file must not inherit
    // whatever this one leaves behind, especially if a test here fails.
    await resetSandboxSettings();
  });

  it('runs an approved bash call in container mode (the default)', async () => {
    await goToSurface('agent');
    await tap('agent.mode.manual');
    await sendMessage(BASH_PROMPT);

    await waitForVisible('agent.permission.bar');
    await tap('agent.permission.allow');
    await waitForTextIn('chat.messageList', MOCK_BASH_OUTPUT);
    await shot('sandbox-bash-container');
  });

  it('runs the identical flow in host mode after a live switch', async () => {
    await openSandboxSettings();
    await setSandboxMode('host');
    await shot('sandbox-host-mode-enabled');

    // A conversation's sandbox is created lazily and keeps using the
    // provider it was created under even after a mode switch (see
    // resolveEntry() in sandbox-manager.ts) — a NEW conversation is what
    // actually exercises the newly-selected provider.
    await goToSurface('agent');
    await startNewAgentRun();
    await tap('agent.mode.manual');
    await sendMessage(BASH_PROMPT);

    await waitForVisible('agent.permission.bar');
    await tap('agent.permission.allow');
    await waitForTextIn('chat.messageList', MOCK_BASH_OUTPUT);
    await shot('sandbox-bash-host');
  });
});
