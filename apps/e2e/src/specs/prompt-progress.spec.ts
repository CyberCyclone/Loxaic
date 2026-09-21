/**
 * A backend that reports its own prompt-evaluation progress gets a measured
 * line and a bar instead of the estimate.
 *
 * llama.cpp sends `prompt_progress` on the stream when asked; LM Studio and
 * hosted APIs send nothing, and keep #196's estimate (prompt-stats.spec.ts).
 * The mock's progress prompt plays llama.cpp's reports out over eight seconds,
 * and only when the server asked for them — so this also proves the engine
 * decided to ask.
 *
 * What would look wrong if it regressed: the word "(estimate)" on figures the
 * backend measured, or a bar that never moves past its first report.
 */
import { uniqueCreds } from '../helpers/auth.ts';
import { shot } from '../helpers/screenshot.ts';
import { byTestId, waitForGone, waitForTextIn, waitForVisible } from '../helpers/selectors.ts';
import { PROGRESS_PROMPT, goToSurface, sendMessage, signUp } from '../helpers/app.ts';

describe('measured prompt progress', () => {
  const creds = uniqueCreds();

  before(async () => {
    await signUp(creds);
  });

  it('shows the backend’s own progress while it evaluates the prompt', async function () {
    this.timeout(2 * 60_000);
    await goToSurface('chat');

    await sendMessage(PROGRESS_PROMPT);
    await waitForVisible('chat.status.promptProgress', 20_000);
    await waitForTextIn('chat.status.promptStats', '% cached');
    // Not merely present: the line moves as reports arrive.
    await waitForTextIn('chat.status.promptStats', 'left');
    await shot('prompt-progress-evaluating');
    const line = await byTestId('chat.status.promptStats').getText();
    expect(line).toContain('% evaluated');
    expect(line).not.toContain('(estimate)');
    expect(line).not.toContain('~');

    await waitForGone('chat.status.promptProgress', 30_000);
  });
});
