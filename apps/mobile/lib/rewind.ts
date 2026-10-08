import { isNudgeText, type FileRestoreReport, type RewindPreview, type ServerMessage } from '@loxaic/api-client';
import type { Message } from './types';

/**
 * Rewind and retry (#166), the parts that decide rather than render: which
 * messages carry the actions, what a rewind does to a thread on screen, and
 * every sentence the dialog says. Pure, so the rules are unit-tested — the
 * components only draw them.
 */

export type Rewound = Extract<ServerMessage, { type: 'conversation.rewound' }>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A message the server has stored — an optimistic bubble's id is our own. */
function isStored(msg: Message): msg is Message & { id: string } {
  return typeof msg.id === 'string' && UUID_RE.test(msg.id);
}

/**
 * The thread after a rewind or retry another device (or this one) made.
 *
 * By id, never by position: a retry's new reply can reach this device before
 * the event saying the old one went, and cutting "everything after" would take
 * the new one with it. What has no server id yet and sits after the point is
 * an optimistic bubble of a send the server refused meanwhile — it goes too.
 */
export function applyRewound(msgs: Message[], event: Rewound): Message[] {
  const removed = new Set(event.removed_ids);
  const pivot = msgs.findIndex((m) => m.id === event.from_message_id);
  const next = msgs.filter((m, i) => {
    if (isStored(m)) return !removed.has(m.id);
    return pivot < 0 || i <= pivot;
  });
  return next.length === msgs.length ? msgs : next;
}

/** Whether a message carries Rewind: one a person typed and the server
 * stored. Not a nudge the server wrote, not a sub-agent's task, and not a
 * bubble still waiting for its id. */
export function canRewind(msg: Message): boolean {
  return msg.role === 'user' && isStored(msg) && !msg.fromAgent && !isNudgeText(msg.text);
}

/**
 * Which message carries Retry: the newest reply, when it answers the newest
 * message someone typed — the only one the server retries. -1 when there is
 * none (nothing answered yet, or the newest thing is a message still waiting).
 */
export function retryIndex(msgs: Message[]): number {
  let typed = -1;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (canRewind(msgs[i])) {
      typed = i;
      break;
    }
  }
  if (typed < 0) return -1;
  for (let i = msgs.length - 1; i > typed; i--) {
    const m = msgs[i];
    if (m.role === 'assistant' && isStored(m)) return i;
  }
  return -1;
}

/** A reply that failed because its request could not fit the model's context
 * — refused by Loxaic, or by the backend. Offered "Edit message". */
export function isContextFailure(msg: Message): boolean {
  return msg.error === true && (msg.errorCode === 'context_cannot_fit' || msg.errorCode === 'context_overflow');
}

/** Under a reply the backend refused as too long: the one cause Loxaic cannot
 * see for itself, and who can fix it. */
export const CONTEXT_OVERFLOW_HINT =
  "The model's server refused this as longer than its context. If the model's context size is missing or wrong in Loxaic, an admin can set it in Settings → Model providers.";

/** Said in the dialog whenever files are offered: what a restore cannot do. */
export const FILE_LIMITS =
  'Only changes the agent made with its file tools can be put back. Commands it ran, edits made outside Loxaic, symbolic links and files over 10 MiB stay as they are.';

/** The rewind dialog's sentence about the conversation. */
export function rewindMessage(preview: RewindPreview): string {
  const later = preview.turns - 1;
  const what =
    later <= 0
      ? 'This message and its reply will be removed, and the message comes back to the composer to edit.'
      : `This message, the ${later === 1 ? 'message' : `${String(later)} messages`} after it, and every reply will be removed. The message comes back to the composer to edit.`;
  const others =
    preview.others > 0
      ? ` ${preview.others === 1 ? 'One of them was' : `${String(preview.others)} of them were`} sent by someone else in this conversation.`
      : '';
  const kept = preview.retained ? ' Admins can still read what is removed, as this server keeps deleted chats.' : '';
  return `${what}${others}${kept}`;
}

/** The files line, when there are any to offer. */
export function filesMessage(files: number, action: 'rewind' | 'retry'): string {
  const n = files === 1 ? '1 file' : `${String(files)} files`;
  return action === 'retry'
    ? `The agent changed ${n} in this reply. Put ${files === 1 ? 'it' : 'them'} back before answering again?`
    : `The agent changed ${n} from here on.`;
}

/** The toast after a files restore, or null when there was nothing to say. */
export function restoreReportLine(report: FileRestoreReport | null | undefined): string | null {
  if (!report) return null;
  const { restored, skipped } = report;
  if (restored.length === 0 && skipped.length === 0) return null;
  const put = restored.length === 0 ? '' : `Put back ${restored.length === 1 ? '1 file' : `${String(restored.length)} files`}.`;
  if (skipped.length === 0) return put;
  const first = skipped[0];
  const name = first.path.split('/').pop() ?? first.path;
  const more = skipped.length > 1 ? ` and ${String(skipped.length - 1)} more` : '';
  const couldNot = `Could not put back ${name}${more}: ${first.reason}.`;
  return put ? `${put} ${couldNot}` : couldNot;
}

/** Said when a rewind gave back text but kept someone else's attachments. */
export const ATTACHMENTS_WITHHELD = "The message's attachments stay with the person who sent them.";
