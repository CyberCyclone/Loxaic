/**
 * A server's default for each kind of conversation — Chat, Agent, Routines —
 * set on the MCP Servers screen, and what each one decides.
 *
 * A conversation that has made no choice of its own follows its kind's
 * default; one that has, keeps it. Every case is asserted against the tools
 * the server actually put in the request (the stored context breakdown), since
 * a default that only moved a switch would save nothing.
 */
import { provisionUser, uniqueCreds } from '../helpers/auth.ts';
import { shot } from '../helpers/screenshot.ts';
import { tap, waitForSwitch, waitForVisible } from '../helpers/selectors.ts';
import {
  addMockMcpServer,
  closePlusMenu,
  conversationMcpOverrides,
  createRoutine,
  goToSurface,
  lastToolSourceKeys,
  listConversations,
  mockEcho,
  openMcpFromPlusMenu,
  openMcpServers,
  openPlusMenu,
  runRoutine,
  sendAndAwaitReply,
  sendMessage,
  setMcpDefaults,
  signIn,
  startNewAgentRun,
  startNewThread,
  waitForRunDone,
} from '../helpers/app.ts';

const MODEL = 'llama-3.1-8b-instruct';

describe('MCP defaults per kind of conversation', () => {
  const creds = uniqueCreds();
  let alpha: string;

  before(async () => {
    await provisionUser(creds);
    alpha = await addMockMcpServer(creds, 'Mock Alpha', 'alpha');
    await signIn(creds);
  });

  it('turns a server off by default for chats, on the MCP Servers screen', async () => {
    await openMcpServers();
    await waitForVisible(`mcp.serverDefaults.${alpha}`);
    await waitForSwitch(`mcp.serverDefault.${alpha}.chat`, true);
    await tap(`mcp.serverDefault.${alpha}.chat`);
    await waitForSwitch(`mcp.serverDefault.${alpha}.chat`, false);
    // The other two are untouched.
    await waitForSwitch(`mcp.serverDefault.${alpha}.agent`, true);
    await waitForSwitch(`mcp.serverDefault.${alpha}.routines`, true);
    await shot('mcp-surface-defaults');
  });

  it('starts a new chat without it', async () => {
    await goToSurface('chat');
    await startNewThread('chat');
    await openPlusMenu();
    await openMcpFromPlusMenu();
    await waitForSwitch(`composer.mcp.toggle.${alpha}`, false);
    await closePlusMenu();

    const prompt = 'no alpha here';
    await sendAndAwaitReply(prompt, mockEcho(prompt));
    const [conv] = await listConversations(creds);
    expect(await lastToolSourceKeys(creds, conv.id)).not.toContain(alpha);
    // Nothing was chosen: the default did this, not a stored choice.
    const overrides = await conversationMcpOverrides(creds, conv.id);
    expect(overrides?.disabledServerIds ?? []).not.toContain(alpha);
  });

  it('starts a new agent run with it, since the Agent default is still on', async () => {
    await goToSurface('agent');
    await startNewAgentRun();
    await openPlusMenu();
    await openMcpFromPlusMenu();
    await waitForSwitch(`composer.mcp.toggle.${alpha}`, true);
    await closePlusMenu();

    await sendMessage('agent sees alpha');
    const run = (await listConversations(creds)).find((c) => c.kind === 'agent');
    if (!run) throw new Error('the agent run was not created');
    await waitForRunDone(creds, run.id);
    expect(await lastToolSourceKeys(creds, run.id)).toContain(alpha);
  });

  it("lets a chat's own switch win over the default", async () => {
    await goToSurface('chat');
    await startNewThread('chat');
    await openPlusMenu();
    await openMcpFromPlusMenu();
    await tap(`composer.mcp.toggle.${alpha}`);
    await waitForSwitch(`composer.mcp.toggle.${alpha}`, true);
    await closePlusMenu();

    const prompt = 'alpha on for this one';
    await sendAndAwaitReply(prompt, mockEcho(prompt));
    const [conv] = await listConversations(creds);
    expect(await conversationMcpOverrides(creds, conv.id)).toMatchObject({ enabledServerIds: [alpha] });
    expect(await lastToolSourceKeys(creds, conv.id)).toContain(alpha);
  });

  it('runs a routine without it when the Routines default is off', async () => {
    await setMcpDefaults(creds, alpha, { onInRoutines: false });
    const routine = await createRoutine(creds, { name: `No alpha ${String(Date.now())}`, prompt: 'routine check', model: MODEL });
    const run = await runRoutine(creds, routine.id);
    await waitForRunDone(creds, run.conversationId);
    expect(await lastToolSourceKeys(creds, run.conversationId)).not.toContain(alpha);

    await setMcpDefaults(creds, alpha, { onInRoutines: true });
    const again = await runRoutine(creds, routine.id);
    await waitForRunDone(creds, again.conversationId);
    expect(await lastToolSourceKeys(creds, again.conversationId)).toContain(alpha);
  });
});
