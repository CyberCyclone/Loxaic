/**
 * web_fetch on a file, and a tool call that fails.
 *
 * A PDF is read in the sandbox and its text is what the model and the card get.
 * A file it can't read is a red card saying why, and the chat carries on: the
 * call beside it keeps its result and the model still answers. These used to
 * end the run at the tool call, with nothing to show for it after a reload.
 *
 * The files are `scripts/mock-web.ts`, on loopback. Without a container
 * (`E2E_SANDBOX_MODE=host`) a PDF can't be read, which is a red card too.
 */
import { uniqueCreds, apiToken, provisionUser, type Credentials } from '../helpers/auth.ts';
import { shot } from '../helpers/screenshot.ts';
import { scrollTo, tap, waitForFreshText, waitForTextIn, waitForVisible } from '../helpers/selectors.ts';
import {
  goToSurface,
  relaunchApp,
  selectThread,
  sendInNewRun,
  signIn,
  signOut,
  startNewAgentRun,
  waitForComposerReady,
  waitForRunDone,
} from '../helpers/app.ts';
import { BASE_URL, SANDBOX_HOST_MODE } from '../../scripts/standup.ts';
import { PDF_TEXT } from '../../scripts/mock-web.ts';

interface Result { call_id: string; output: string; ok?: boolean }

async function results(creds: Credentials, conversationId: string): Promise<Result[]> {
  const token = await apiToken(creds);
  const res = await fetch(`${BASE_URL}/v1/conversations/${conversationId}/messages`, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`[e2e] messages failed (${String(res.status)})`);
  const body = (await res.json()) as { messages: { content: (Result & { kind: string })[] }[] };
  return body.messages.flatMap((m) => m.content.filter((b) => b.kind === 'tool_result'));
}

const NO_CONTAINER = "can't be read safely without a container sandbox";

async function expectResultOnCard(callId: string, text: string): Promise<void> {
  await scrollTo(`chat.toolCall.header.${callId}`);
  await tap(`chat.toolCall.header.${callId}`);
  await waitForFreshText(`chat.toolCall.resultText.${callId}`, text);
}

describe('web_fetch on a file', () => {
  const creds = uniqueCreds();

  before(async () => {
    await provisionUser(creds);
    await signIn(creds);
    await goToSurface('agent');
  });

  after(async () => {
    await signOut();
  });

  it('reads a PDF, and the model answers', async function () {
    this.timeout(3 * 60_000);
    await startNewAgentRun();
    const conv = await sendInNewRun(creds, 'read the manual pdf');
    await waitForRunDone(creds, conv);
    await waitForTextIn('chat.messageList', '[Mock] Read the manual.', 30_000);

    const [result] = await results(creds, conv);
    if (SANDBOX_HOST_MODE) {
      expect(result.ok).toBe(false);
      await waitForVisible(`chat.toolCall.failed.${result.call_id}`);
      await expectResultOnCard(result.call_id, NO_CONTAINER);
      return;
    }
    expect(result.ok).toBe(true);
    expect(result.output).toContain(PDF_TEXT);
    await expectResultOnCard(result.call_id, PDF_TEXT);
    await shot('web-fetch-pdf-read');
  });

  it('shows a file it cannot read on the failed call, keeps the other, and carries on, after a reload too', async function () {
    this.timeout(4 * 60_000);
    await startNewAgentRun();
    const conv = await sendInNewRun(creds, 'read the archive and the manual');
    await waitForRunDone(creds, conv);
    await waitForTextIn('chat.messageList', '[Mock] Carried on without the archive.', 30_000);

    const [archive, manual] = await results(creds, conv);
    expect(archive.ok).toBe(false);
    expect(archive.output).toContain('is a binary file (application/zip). web_fetch reads text, web pages and documents.');
    expect(manual.ok).toBe(!SANDBOX_HOST_MODE);
    await waitForVisible(`chat.toolCall.failed.${archive.call_id}`);
    await expectResultOnCard(archive.call_id, 'web_fetch reads text, web pages and documents.');
    await shot('web-fetch-binary-failed-card');

    await relaunchApp();
    await waitForComposerReady(60_000);
    await goToSurface('agent');
    await selectThread(conv, 'agent');
    await waitForTextIn('chat.messageList', '[Mock] Carried on without the archive.', 30_000);
    await scrollTo(`chat.toolCall.failed.${archive.call_id}`);
    await waitForVisible(`chat.toolCall.failed.${archive.call_id}`);
    await expectResultOnCard(archive.call_id, 'web_fetch reads text, web pages and documents.');
    await shot('web-fetch-binary-failed-card-after-reload');
  });
});
