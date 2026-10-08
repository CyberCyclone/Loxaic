import type { AttachmentRef } from "@loxaic/types";
import { turnErrorText } from "../error-text.ts";
import { getStreamBroker } from "../index.ts";
import { unregisterRun, type RunHandle } from "../registry.ts";
import type { StreamProducer } from "../broker.ts";
import { announceNewRun } from "../watchers.ts";
import { runToolLoop } from "./engine.ts";

/** How a run ended, as the stream log finalized it. */
export interface RunSettled {
  status: "complete" | "error" | "cancelled";
  error?: string;
}

export interface StartedRun {
  streamId: string;
  conversationId: string;
  userMessageId: string;
}

/** What `runToolLoop` takes beyond the run's identity and stream. */
export type LoopOptions = Omit<
  Parameters<typeof runToolLoop>[0],
  "streamId" | "convId" | "userId" | "userMsgId" | "userLamport" | "abort" | "producer" | "surface"
>;

/**
 * Starts a run that answers a user message already stored — everything a send
 * does after it has inserted its row, and the whole of a retry, which answers
 * the same row again.
 *
 * `claim` is the conversation's run slot, already taken (`claimConversation`)
 * before the caller's first await that matters; its stream id becomes the
 * run's. It is released here if the stream cannot be opened, and by the loop
 * once the run ends.
 *
 * The row's `message.start` is emitted again on the new stream. A send's
 * client has the bubble already, a retry's has it from history, and both
 * dedupe by id; a device that only ever sees this stream's snapshot needs it
 * to place the reply.
 */
export async function startRunOnRow(input: {
  claim: RunHandle;
  surface: "chat" | "agent";
  row: { id: string; lamport: number; parentId: string | null; text: string; attachments: AttachmentRef[] };
  /** Built once the stream is open: the agent's prepare step writes to it. */
  loop: (producer: StreamProducer) => LoopOptions;
  /** See `startChatRun`. Must not throw. */
  onSettled?: (info: RunSettled) => void;
}): Promise<StartedRun> {
  const { claim, row } = input;
  const { streamId, conversationId: convId, userId, abort } = claim;
  const broker = getStreamBroker();
  let producer: StreamProducer;
  try {
    producer = await broker.openProducer({ streamId, conversationId: convId, userId, surface: input.surface });
  } catch (err) {
    unregisterRun(streamId);
    throw err;
  }

  producer.emit({
    kind: "message.start",
    message_id: row.id,
    author_type: "user",
    parent_id: row.parentId,
    lamport: row.lamport,
    text: row.text,
    ...(row.attachments.length ? { attachments: row.attachments } : {}),
  });
  producer.emit({ kind: "message.end", message_id: row.id, status: "complete" });
  announceNewRun(convId, streamId);

  // Wired before the loop starts, because a run that fails inside its first
  // await would otherwise finalize before anyone was listening.
  const settle = onceSettled(input.onSettled, broker.onEnd.bind(broker), streamId);

  // Detached: the caller gets turn.started immediately, and generation
  // continues independent of whatever socket happened to start it.
  runToolLoop({
    ...input.loop(producer),
    streamId,
    convId,
    userId,
    userMsgId: row.id,
    userLamport: row.lamport,
    surface: input.surface,
    abort,
    producer,
  }).then(
    () => {
      // Every deliberate exit of the loop ends the stream, so this normally
      // finds the run already settled. If it does not, the stream would stay
      // "active" forever — a resync would keep waiting on a run nothing is
      // running — so end it rather than leave it hanging.
      settle({ status: "error", error: "The run ended without a result." });
    },
    async (err: unknown) => {
      // `runToolLoop` rethrows anything that is not a cancellation, and
      // nothing above this point catches it: as a bare `void` it was an
      // unhandled rejection that also left the stream active.
      const text = turnErrorText(err, `run failed in ${convId}`);
      console.error(`run ${streamId} failed in ${convId}:`, err);
      // Idempotent — a no-op if the loop already ended the stream itself.
      await producer.end("error", { error: text }).catch(() => undefined);
      settle({ status: "error", error: text });
    },
  );

  return { streamId, conversationId: convId, userMessageId: row.id };
}

/**
 * Bridges the stream log's terminal status to the caller's callback, once.
 *
 * `broker.onEnd` is the source of truth — it is what the producer's own
 * `end()` emits, so the status here is exactly the one the log recorded. The
 * promise handlers above are the backstop for the case it never fires.
 */
function onceSettled(
  cb: ((info: RunSettled) => void) | undefined,
  onEnd: (streamId: string, listener: (info: RunSettled) => void) => () => void,
  streamId: string,
): (info: RunSettled) => void {
  if (!cb) return () => undefined;
  let done = false;
  const fire = (info: RunSettled) => {
    if (done) return;
    done = true;
    off();
    try {
      cb(info);
    } catch (err) {
      // The caller's bookkeeping is not allowed to take the run down with it.
      console.error(`run ${streamId} settle handler threw:`, err);
    }
  };
  const off = onEnd(streamId, (info) => {
    fire({ status: info.status, ...(info.error === undefined ? {} : { error: info.error }) });
  });
  return fire;
}
