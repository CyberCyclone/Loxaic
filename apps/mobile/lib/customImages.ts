/**
 * Custom sandbox images (#253) on the client: every decision the screens and
 * the new-chat chooser make, as pure functions. The server enforces all of
 * it again; these only decide what is offered and what it says.
 */
import type { CustomImagesPolicy, ImageChoice, SandboxImage } from '@loxaic/api-client';

export const CUSTOM_IMAGE_POLICIES: { value: CustomImagesPolicy; label: string }[] = [
  { value: 'off', label: 'Off' },
  { value: 'shared', label: 'Admins load images' },
  { value: 'everyone', label: 'Everyone can add their own' },
];

export function describeCustomImagesPolicy(policy: CustomImagesPolicy): string {
  switch (policy) {
    case 'off':
      return "Every agent sandbox runs in Loxaic's own image.";
    case 'shared':
      return 'People can start an agent chat in an image an admin loads under Settings → Container images. Images may run as root; every capability is still dropped. Applies to new sandboxes; existing ones keep theirs.';
    case 'everyone':
      return 'As well as the images an admin loads, each person can add their own, pulled with their own registry login, which nobody else can see or use. Images may run as root; every capability is still dropped. Applies to new sandboxes; existing ones keep theirs.';
  }
}

/** Which image screens Settings offers this person. A policy absent from the
 * server's answer is a server that predates custom images: neither. */
export function imageScreens(policy: CustomImagesPolicy | undefined, isAdmin: boolean): { shared: boolean; personal: boolean } {
  return {
    shared: isAdmin && (policy === 'shared' || policy === 'everyone'),
    personal: policy === 'everyone',
  };
}

export interface ImageOption {
  /** Null is Loxaic's own image. */
  id: string | null;
  label: string;
  detail: string;
  /** Why it can't be chosen for this workspace, or null when it can. */
  disabledReason: string | null;
}

export const BUILT_IN_OPTION: ImageOption = {
  id: null,
  label: "Loxaic's image",
  detail: 'The built-in sandbox image.',
  disabledReason: null,
};

/** What the chooser lists for a workspace source: Loxaic's own first, then
 * the shared images and the person's own in the order the server gave. */
export function imageOptions(choices: ImageChoice[], source: 'scratch' | 'github'): ImageOption[] {
  return [
    BUILT_IN_OPTION,
    ...choices.map((c) => ({
      id: c.id,
      label: c.label,
      detail: `${c.reference}${c.scope === 'personal' ? ' · yours' : ''}`,
      disabledReason: source === 'github' && !c.hasGit ? 'No git in this image, which a GitHub workspace needs.' : null,
    })),
  ];
}

/** The chosen image, if it can still be used for this source; otherwise
 * Loxaic's own (a GitHub source can rule out an image chosen for scratch). */
export function effectiveImageChoice(chosen: string | null, options: ImageOption[]): string | null {
  const option = options.find((o) => o.id === chosen);
  return option?.disabledReason === null ? chosen : null;
}

/**
 * The new-chat chooser's image list, whatever state its fetch is in.
 *
 * - **Loading** (`choices` null, not failed): Confirm waits. Confirming against
 *   an empty list would read an image already chosen as "ruled out" and
 *   silently start the chat in Loxaic's own.
 * - **Failed**: the image already chosen stays offered and chosen, so a blip
 *   in `/v1/images` never swaps it out unseen. The server checks it again
 *   when the chat is created.
 * - **Loaded**: `imageOptions`, with `effectiveImageChoice` deciding whether
 *   the choice still fits this source.
 */
export function chooserImages(input: {
  choices: ImageChoice[] | null;
  failed: boolean;
  current: { id: string; label: string } | null;
  chosen: string | null;
  source: 'scratch' | 'github';
}): { options: ImageOption[]; chosenId: string | null; ready: boolean } {
  if (input.choices !== null) {
    const options = imageOptions(input.choices, input.source);
    return { options, chosenId: effectiveImageChoice(input.chosen, options), ready: true };
  }
  const kept: ImageOption[] = input.current
    ? [{ id: input.current.id, label: input.current.label, detail: "Couldn't check this image just now; it is checked again when the chat starts.", disabledReason: null }]
    : [];
  const options = [BUILT_IN_OPTION, ...kept];
  const chosenId = options.some((o) => o.id === input.chosen) ? input.chosen : null;
  return { options, chosenId, ready: input.failed };
}

/** One line about an image's latest pull, for its row. */
export function imageStatusLine(image: SandboxImage): string {
  if (image.status === 'pulling') {
    const p = image.progress;
    if (p && p.total > 0) return `Pulling… ${String(Math.min(99, Math.floor((p.current / p.total) * 100)))}%`;
    return 'Pulling…';
  }
  if (image.status === 'failed') {
    return image.usable
      ? `The last update failed; the previous pull is still used. ${image.error ?? ''}`.trim()
      : image.error ?? 'The pull failed.';
  }
  return 'Ready';
}

/** Whether anything on an image list is still pulling, so it polls. */
export function anyPulling(images: SandboxImage[]): boolean {
  return images.some((i) => i.status === 'pulling');
}

/** Megabytes and CPUs as typed, or the reason they can't be saved. Bounds
 * match the server's (images/store.ts LIMIT_BOUNDS). */
export function parseLimitsInput(input: { memoryMb: string; cpus: string; pids: string }):
  | { ok: true; limits: { memoryMb: number; cpus: number; pids: number } }
  | { ok: false; error: string } {
  const memoryMb = Number(input.memoryMb);
  const cpus = Number(input.cpus);
  const pids = Number(input.pids);
  if (!Number.isInteger(memoryMb) || memoryMb < 256 || memoryMb > 65_536) return { ok: false, error: 'Memory must be a whole number from 256 to 65536 MB.' };
  if (!Number.isFinite(cpus) || cpus < 0.25 || cpus > 64) return { ok: false, error: 'CPUs must be from 0.25 to 64.' };
  if (!Number.isInteger(pids) || pids < 64 || pids > 32_768) return { ok: false, error: 'Processes must be a whole number from 64 to 32768.' };
  return { ok: true, limits: { memoryMb, cpus, pids } };
}
