import { describe, expect, it } from 'vitest';
import type { HfMtpHead, LocalModel } from '@loxaic/api-client';
import {
  defaultMtpHead,
  describeMtpAcceptance,
  mtpBadge,
  mtpCanTurnOn,
  mtpPanel,
  mtpParallelWarning,
  showsMtp,
  wantsRepoHeads,
  withMtp,
} from './mtp';
import { pollIntervalMs } from './localModels';

type M = Pick<LocalModel, 'mtpSource' | 'mtpHead' | 'meta'>;
const model = (over: Partial<M> = {}): M => ({ mtpSource: null, mtpHead: null, meta: {}, ...over });
const head = (status: 'queued' | 'downloading' | 'ready' | 'failed', over: Partial<NonNullable<M['mtpHead']>> = {}) => ({
  path: 'MTP/mtp-Qwen3.8-Flash-Next-Q8_0.gguf',
  size: 4_000_000_000,
  status,
  bytesDone: 1_000_000_000,
  error: null,
  layers: null,
  ...over,
});
const repoHeads: HfMtpHead[] = [
  { path: 'MTP/mtp-X-shared-Q8_0.gguf', size: 2_600_000_000, sha256: null, shared: true },
  { path: 'MTP/mtp-X-BF16.gguf', size: 7_200_000_000, sha256: null, shared: false },
  { path: 'MTP/mtp-X-Q4_K_M.gguf', size: 2_600_000_000, sha256: null, shared: false },
  { path: 'MTP/mtp-X-Q8_0.gguf', size: 3_850_000_000, sha256: null, shared: false },
];

describe('the MTP panel', () => {
  it('says a model carries its own head, and asks the repository for nothing', () => {
    const own = model({ mtpSource: 'embedded', meta: { mtp: { layers: 1 } } });
    expect(mtpPanel(own, null)).toEqual({ kind: 'embedded' });
    expect(wantsRepoHeads(own)).toBe(false);
    expect(mtpCanTurnOn(mtpPanel(own, null))).toBe(true);
  });

  it('follows a separate head through its download, and lets MTP be turned on while it comes', () => {
    const coming = mtpPanel(model({ mtpSource: 'head-pending', mtpHead: head('downloading') }), null);
    expect(coming).toEqual({ kind: 'head-downloading', name: 'mtp-Qwen3.8-Flash-Next-Q8_0.gguf', percent: 25, queued: false });
    expect(mtpCanTurnOn(coming)).toBe(true);
    expect(mtpPanel(model({ mtpHead: head('queued', { bytesDone: 0 }) }), null)).toMatchObject({ queued: true, percent: 0 });
    expect(mtpPanel(model({ mtpSource: 'head', mtpHead: head('ready') }), null)).toEqual({
      kind: 'head-ready',
      name: 'mtp-Qwen3.8-Flash-Next-Q8_0.gguf',
      size: '3.7 GB',
    });
  });

  it('shows why a head was refused, offers the others again, and will not turn MTP on with it', () => {
    const failed = model({ mtpSource: null, mtpHead: head('failed', { error: 'a head for llama, not qwen4exp' }) });
    expect(mtpPanel(failed, repoHeads)).toMatchObject({ kind: 'head-failed', error: 'a head for llama, not qwen4exp' });
    expect(wantsRepoHeads(failed)).toBe(true);
    expect(mtpCanTurnOn(mtpPanel(failed, repoHeads))).toBe(false);
  });

  it("lists a repository's heads with shared ones disabled, and shows nothing for a model with no head anywhere", () => {
    const choose = mtpPanel(model(), repoHeads);
    expect(choose.kind).toBe('choose');
    if (choose.kind !== 'choose') return;
    expect(choose.heads[0].name).toBe('mtp-X-shared-Q8_0.gguf');
    expect(choose.heads[0].disabledReason).toMatch(/cannot/);
    expect(choose.heads.slice(1).every((h) => h.disabledReason === null)).toBe(true);
    expect(mtpCanTurnOn(choose)).toBe(false);
    expect(showsMtp(mtpPanel(model(), []))).toBe(false);
  });

  it('says it is checking the repository, and says so when it could not, never "no head"', () => {
    // Asking, and could not ask, are both shown — and neither can turn MTP
    // on. "None" is the only state that hides the group.
    const checking = mtpPanel(model(), null);
    expect(checking.kind).toBe('checking');
    expect(showsMtp(checking)).toBe(true);
    expect(mtpCanTurnOn(checking)).toBe(false);
    const unreachable = mtpPanel(model(), 'error');
    expect(unreachable.kind).toBe('unreachable');
    expect(showsMtp(unreachable)).toBe(true);
    expect(mtpCanTurnOn(unreachable)).toBe(false);
  });

  it('defaults the download dialog to the smallest self-contained Q8_0, never a shared head', () => {
    expect(defaultMtpHead(repoHeads)?.path).toBe('MTP/mtp-X-Q8_0.gguf');
    expect(defaultMtpHead(repoHeads.filter((h) => !h.path.includes('Q8_0')))?.path).toBe('MTP/mtp-X-Q4_K_M.gguf');
    expect(defaultMtpHead([repoHeads[0]])).toBeNull();
    expect(defaultMtpHead(undefined)).toBeNull();
  });
});

describe('MTP settings', () => {
  it('warns when the model serves several conversations at once — llama.cpp runs four when unset', () => {
    expect(mtpParallelWarning({ mtp: true })).toMatch(/up to four conversations/);
    expect(mtpParallelWarning({ mtp: true, parallel: 2 })).toMatch(/up to 2 conversations/);
    expect(mtpParallelWarning({ mtp: true, parallel: 1 })).toBeNull();
    expect(mtpParallelWarning({ parallel: 4 })).toBeNull();
  });

  it('takes the draft length with it when MTP goes off', () => {
    expect(withMtp({ mtp: true, mtpDraftMax: 2, ctxSize: 4096 }, false)).toEqual({ ctxSize: 4096 });
    expect(withMtp({ ctxSize: 4096 }, true)).toEqual({ ctxSize: 4096, mtp: true });
  });

  it('describes acceptance floored, and says nothing when nothing was drafted', () => {
    expect(describeMtpAcceptance(491, 325)).toBe('MTP 66% of 491 drafted');
    expect(describeMtpAcceptance(1000, 999)).toBe('MTP 99% of 1000 drafted');
    expect(describeMtpAcceptance(0, 0)).toBeNull();
    expect(describeMtpAcceptance(null, null)).toBeNull();
    expect(describeMtpAcceptance(undefined, undefined)).toBeNull();
  });

  it('polls quickly while a head downloads, or waits on a ready model to start', () => {
    const view = (h: ReturnType<typeof head> | null, status = 'ready') =>
      ({ runtime: { state: 'running' }, models: [{ status, mtpHead: h }] }) as never;
    expect(pollIntervalMs(view(head('downloading')))).toBe(1000);
    expect(pollIntervalMs(view(head('queued')))).toBe(1000);
    expect(pollIntervalMs(view(head('ready')))).toBe(15_000);
    // A head waits for its model: queued behind a failed one it does not move
    // until someone retries the model, so there is nothing to watch.
    expect(pollIntervalMs(view(head('queued'), 'failed'))).toBe(15_000);
  });
});

describe('the installed row badge', () => {
  it('says MTP only when it drafts, and follows a head that is coming or was refused', () => {
    expect(mtpBadge({ ...model({ mtpSource: 'embedded', meta: { mtp: { layers: 1 } } }), loadSettings: { mtp: true } })).toEqual({ text: 'MTP', problem: false });
    expect(mtpBadge({ ...model({ mtpSource: 'embedded', meta: { mtp: { layers: 1 } } }), loadSettings: {} })).toBeNull();
    expect(mtpBadge({ ...model({ mtpSource: 'head-pending', mtpHead: head('downloading') }), loadSettings: { mtp: true } })).toEqual({ text: 'MTP head · 25%', problem: false });
    expect(mtpBadge({ ...model({ mtpSource: null, mtpHead: head('failed') }), loadSettings: { mtp: true } })).toEqual({ text: 'MTP head refused', problem: true });
  });
});
