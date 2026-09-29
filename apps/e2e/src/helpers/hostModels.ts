/**
 * Host-model plumbing for specs that need a downloaded, enabled model and the
 * fake router's record of what it was loaded with — the context-stage spec's
 * ground, kept apart so it reads as behaviour.
 */
import { existsSync, readFileSync } from 'node:fs';
import { browser } from '@wdio/globals';
import { adminCreds, apiToken, type Credentials } from './auth.ts';
import { BASE_URL, FAKE_ROUTER_LOG, mockHf } from '../../scripts/standup.ts';

let adminToken: string | null = null;

export async function adminApi(pathname: string, init: RequestInit = {}): Promise<Response> {
  adminToken ??= await apiToken(adminCreds());
  return fetch(`${BASE_URL}${pathname}`, {
    ...init,
    headers: { authorization: `Bearer ${adminToken}`, ...(init.body ? { 'content-type': 'application/json' } : {}) },
  });
}

export async function userApi(creds: Pick<Credentials, 'email' | 'password'>, pathname: string, init: RequestInit = {}): Promise<Response> {
  const token = await apiToken(creds);
  return fetch(`${BASE_URL}${pathname}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, ...(init.body ? { 'content-type': 'application/json' } : {}) },
  });
}

interface AdminModel {
  id: string;
  status: string;
}

/** Removes every model this suite's mock HuggingFace served, and any an earlier
 * run left — a row left behind is an enabled model with no files. */
export async function removeMockModels(): Promise<void> {
  const res = await adminApi('/v1/admin/local-models');
  if (!res.ok) throw new Error(`[e2e] listing local models failed (${String(res.status)})`);
  const { models } = (await res.json()) as { models: AdminModel[] };
  for (const m of models) {
    if (!m.id.startsWith('e2e-org/') && !m.id.startsWith('pixel-lab/')) continue;
    const r =
      m.status === 'ready' || m.status === 'failed'
        ? await adminApi(`/v1/admin/local-models/model?id=${encodeURIComponent(m.id)}`, { method: 'DELETE' })
        : await adminApi('/v1/admin/local-models/cancel', { method: 'POST', body: JSON.stringify({ id: m.id }) });
    if (!r.ok) throw new Error(`[e2e] could not remove ${m.id} (${String(r.status)}): ${await r.text()}`);
  }
}

/** The mock's small model, downloaded and waited for. */
export async function downloadTinyModel(): Promise<string> {
  const hf = mockHf();
  const id = `${hf.repos.tiny}:${hf.quants.download}`;
  const res = await adminApi('/v1/admin/local-models/downloads', {
    method: 'POST',
    body: JSON.stringify({ repo: hf.repos.tiny, quant: hf.quants.download }),
  });
  if (!res.ok) throw new Error(`[e2e] download failed (${String(res.status)}): ${await res.text()}`);
  await browser.waitUntil(
    async () => {
      const list = (await (await adminApi('/v1/admin/local-models')).json()) as { models: AdminModel[] };
      return list.models.find((m) => m.id === id)?.status === 'ready';
    },
    { timeout: 90_000, interval: 300, timeoutMsg: `[e2e] ${id} never finished downloading` },
  );
  return id;
}

export async function patchModel(id: string, body: Record<string, unknown>): Promise<void> {
  const res = await adminApi('/v1/admin/local-models/model', { method: 'PATCH', body: JSON.stringify({ id, ...body }) });
  if (!res.ok) throw new Error(`[e2e] patching ${id} failed (${String(res.status)}): ${await res.text()}`);
}

/** What the router knows a model by — the id with "@" for ":". */
export const routerName = (id: string): string => id.replace(':', '@');

export interface RouterEvent {
  event: string;
  model: string;
  section?: Record<string, string>;
}

export function routerEvents(): RouterEvent[] {
  if (!existsSync(FAKE_ROUTER_LOG)) return [];
  return readFileSync(FAKE_ROUTER_LOG, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as RouterEvent);
}

/** The loads of one model, oldest first, with the section each was given. */
export function loadsOf(id: string): RouterEvent[] {
  return routerEvents().filter((e) => e.event === 'load' && e.model === routerName(id));
}

export interface StageModelInfo {
  id: string;
  context_stage?: { active: number; windows: (number | null)[]; pending: number | null; who_may_change: string; when_full: string };
}

/** The model as the picker's list reports it, for the given user. */
export async function modelInfo(creds: Pick<Credentials, 'email' | 'password'>, id: string): Promise<StageModelInfo | undefined> {
  const res = await userApi(creds, '/v1/models');
  if (!res.ok) throw new Error(`[e2e] listing models failed (${String(res.status)})`);
  return ((await res.json()) as StageModelInfo[]).find((m) => m.id === id);
}

export async function waitForModelStage(
  creds: Pick<Credentials, 'email' | 'password'>,
  id: string,
  active: number,
  timeout = 30_000,
): Promise<void> {
  let seen: number | undefined;
  await browser.waitUntil(
    async () => {
      seen = (await modelInfo(creds, id))?.context_stage?.active;
      return seen === active;
    },
    { timeout, interval: 400, timeoutMsg: `[e2e] expected ${id} at stage ${String(active)}, it is at ${String(seen)}` },
  );
}

/** Moves the model to a stage through the API, with nothing open — the way to
 * put it where a case needs it. */
export async function putModelAtStage(creds: Pick<Credentials, 'email' | 'password'>, id: string, stage: number): Promise<void> {
  if ((await modelInfo(creds, id))?.context_stage?.active === stage) return;
  const res = await userApi(creds, '/v1/models/context-stage', { method: 'POST', body: JSON.stringify({ model: id, stage }) });
  if (!res.ok) throw new Error(`[e2e] moving ${id} to stage ${String(stage)} failed (${String(res.status)}): ${await res.text()}`);
  await waitForModelStage(creds, id, stage);
}

/** A reply another person is in the middle of: sent from a connection of its
 * own, on the model, slow enough to hold it while a case looks. `stop` ends it
 * the way Stop does. */
export async function replyFromElsewhere(
  creds: Pick<Credentials, 'email' | 'password'>,
  model: string,
  content: string,
): Promise<{ done: Promise<void>; stop: () => void; close: () => void }> {
  const token = await apiToken(creds);
  const ws = new WebSocket(`${BASE_URL.replace(/^http/, 'ws')}/ws/chat?token=${encodeURIComponent(token)}`);
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => { resolve(); });
    ws.addEventListener('error', () => { reject(new Error('[e2e] second connection failed to open')); });
  });
  let streamId: string | null = null;
  const done = new Promise<void>((resolve) => {
    ws.addEventListener('message', (m) => {
      try {
        const msg = JSON.parse(String(m.data)) as { type?: string; stream_id?: string };
        if (msg.type === 'turn.started' && msg.stream_id) streamId = msg.stream_id;
        if (msg.type === 'stream.end') resolve();
      } catch {
        // not JSON
      }
    });
    ws.addEventListener('close', () => { resolve(); });
  });
  ws.send(JSON.stringify({ type: 'chat.send', content, model }));
  return {
    done,
    stop: () => {
      if (streamId) ws.send(JSON.stringify({ type: 'stream.stop', stream_id: streamId }));
    },
    close: () => { ws.close(); },
  };
}

/** Polls the server rather than the page, for the reason waitForRunDone gives:
 * a headless tab left idle in a long waitUntil can stop answering. */
export async function waitUntilTrue(check: () => Promise<boolean> | boolean, timeout: number, message: string): Promise<void> {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error(`[e2e] ${message}`);
    await new Promise((r) => setTimeout(r, 300));
  }
}
