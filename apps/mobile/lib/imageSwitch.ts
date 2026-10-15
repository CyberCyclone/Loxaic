/**
 * Changing a conversation's image (#253): whether the Inspector offers it,
 * and why it is disabled when it is. Pure; the server refuses the same cases.
 */
import type { CustomImagesPolicy } from '@loxaic/api-client';

export interface ImageSwitchInput {
  /** The conversation exists on the server (not an optimistic local id). */
  saved: boolean;
  isOwner: boolean;
  workspaceKind: 'scratch' | 'github' | 'local';
  /** Whether it runs in a custom image now. */
  hasImage: boolean;
  policy: CustomImagesPolicy | undefined;
  blocked: string | undefined;
  running: boolean;
  reachable: boolean;
}

export interface ImageSwitchState {
  offered: boolean;
  /** Why the offered control can't be used right now, or null. */
  disabledReason: string | null;
}

export function imageSwitchState(input: ImageSwitchInput): ImageSwitchState {
  // A conversation already in a custom image can always go back to Loxaic's
  // own, even with custom images since turned off; otherwise there must be
  // something to choose.
  const anyToChoose = (input.policy !== undefined && input.policy !== 'off' && !input.blocked) || input.hasImage;
  const offered = input.saved && input.isOwner && input.workspaceKind !== 'local' && anyToChoose;
  if (!offered) return { offered: false, disabledReason: null };
  if (input.running) return { offered, disabledReason: "Stop the run first: the image can't change while it is running." };
  if (!input.reachable) return { offered, disabledReason: "Can't reach your server." };
  return { offered, disabledReason: null };
}

export const IMAGE_SWITCH_NOTE =
  'Your files in /home/loxaic (the workspace and its checkpoints) move to the new image. ' +
  'Anything installed elsewhere in the old container does not. The next message re-reads the whole conversation once.';
