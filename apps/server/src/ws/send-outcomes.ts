import { isStreamErrorCode, type ServerMessage } from "@loxaic/types";
import { NotFoundError } from "../streams/authz.ts";
import { clientRefOf } from "./client-ref.ts";

/**
 * What became of a send, kept so a client whose socket was replaced before it
 * heard can ask again (`send.status`).
 *
 * A new conversation's id reaches the client only in the `turn.started` sent
 * to the socket that sent the message. When that socket is replaced before the
 * reply lands — the app coming back from the background, a Mac waking, a
 * failed health probe — the reply is lost with it. The run goes on and
 * finishes, but the client never learns which conversation it is in: the
 * thread keeps its optimistic local id, no answer ever appears, and the next
 * resubscribe sent that local id to the server, which reached the screen as
 * `invalid input syntax for type uuid`. A subscribe cannot recover it (the
 * client has no id to subscribe to), and a lookup by content would guess. The
 * send's own `client_ref` names it exactly.
 *
 * Keyed by user as well as ref: the ref is the client's own token, so two
 * users may well pick the same one, and one must never read the other's. A
 * ref's uniqueness across one user's *devices* is the client's to ensure —
 * the server cannot check it — which is why clients add randomness to it.
 * In memory, like the run registry: a restart loses the answer, and the client
 * is then told the send is unknown rather than told something false.
 */

type TurnStarted = Extract<ServerMessage, { type: "turn.started" }>;
type SendError = Extract<ServerMessage, { type: "error" }>;
export type SendOutcome = TurnStarted | SendError;

/** Longest an answer is kept, whatever the stream log's retention. Above
 * Node's `2**31 - 1` a `setTimeout` delay silently becomes 1 ms, which would
 * forget every answer the moment it settled — clamped, as the approval and
 * check-in waits are. */
const MAX_KEEP_MS = 86_400_000;

/** How long an answer is kept after it is known. As long as the stream log
 * keeps the run it describes (past that there is nothing left to show), up to
 * `MAX_KEEP_MS`. */
export function keepMs(): number {
  const seconds = Number(process.env.STREAM_TTL_SECONDS);
  const ms = (Number.isFinite(seconds) && seconds > 0 ? seconds : 86_400) * 1000;
  return Math.min(ms, MAX_KEEP_MS);
}

/** Per user, newest kept. A client only ever asks about the send it is still
 * waiting on, so a handful is plenty; the bound is what stops a client that
 * sends forever from growing this without limit. */
const PER_USER = 50;

const outcomes = new Map<string, Map<string, Promise<SendOutcome>>>();

/**
 * The error a send's socket is told, for a failed send. Shared with the live
 * path so a replayed answer is word for word what the lost one said — with the
 * ref always, since a replay is only ever read by the ref it answers.
 */
export function sendErrorFor(err: unknown, ref: string | undefined): SendError {
  if (err instanceof NotFoundError) return { type: "error", error: "not found", ...(ref ? { client_ref: ref } : {}) };
  const raw = (err as { code?: unknown }).code;
  const code = isStreamErrorCode(raw) ? raw : undefined;
  return {
    type: "error",
    error: (err as Error).message,
    ...(code ? { code } : {}),
    ...(ref ? { client_ref: ref } : {}),
  };
}

interface Started { streamId: string; conversationId: string; userMessageId: string }

/** A send begun with `beginSend`. Only the first of either call counts. */
export interface PendingSendOutcome {
  /** The send went on to start a run (or to fail starting one). */
  started(run: Promise<Started>): void;
  /** The send was refused before a run was attempted. */
  failed(err: unknown): void;
}

/**
 * Start remembering this user's send `ref`, the moment its frame is read —
 * before the session re-check, which is a database round trip. A replacement
 * socket asking in that window must find the send pending, not unknown: told
 * "unknown", the client takes back a message that was in fact sent.
 */
export function beginSend(userId: string, ref: string): PendingSendOutcome {
  let settle!: (outcome: Promise<SendOutcome>) => void;
  const outcome = new Promise<SendOutcome>((resolve) => { settle = resolve; });
  remember(userId, ref, outcome);
  return {
    started: (run) => {
      settle(
        run.then(
          (r): SendOutcome => ({
            type: "turn.started",
            stream_id: r.streamId,
            conversation_id: r.conversationId,
            user_message_id: r.userMessageId,
            client_ref: ref,
          }),
          (err: unknown): SendOutcome => sendErrorFor(err, ref),
        ),
      );
    },
    failed: (err) => { settle(Promise.resolve(sendErrorFor(err, ref))); },
  };
}

/** `beginSend` for a message off a socket: only this surface's send, naming
 * itself, counts. The other surface's send type is not handled on this socket,
 * so remembering it would leave an answer nothing ever settles. */
export function beginSendFor(
  userId: string,
  msg: { type: string },
  surface: "chat" | "agent",
): PendingSendOutcome | undefined {
  // A retry starts a run the same way and loses its answer the same way.
  if (msg.type !== `${surface}.send` && msg.type !== `${surface}.retry`) return undefined;
  const ref = clientRefOf(msg);
  return ref ? beginSend(userId, ref) : undefined;
}

function remember(userId: string, ref: string, outcome: Promise<SendOutcome>): void {
  let mine = outcomes.get(userId);
  if (!mine) {
    mine = new Map();
    outcomes.set(userId, mine);
  }
  mine.delete(ref);
  mine.set(ref, outcome);
  while (mine.size > PER_USER) {
    const oldest = mine.keys().next().value;
    if (oldest === undefined) break;
    mine.delete(oldest);
  }
  void outcome.then(() => {
    setTimeout(() => { forget(userId, ref, outcome); }, keepMs()).unref();
  });
}

function forget(userId: string, ref: string, outcome: Promise<SendOutcome>): void {
  const mine = outcomes.get(userId);
  // Only this entry: the same ref may have been remembered again since.
  if (mine?.get(ref) !== outcome) return;
  mine.delete(ref);
  if (mine.size === 0) outcomes.delete(userId);
}

/**
 * What became of this user's send `ref`, once it is known — waiting for it
 * when the send is still being started, which is the ordinary case for a
 * socket replaced mid-send. Undefined when this process never heard of it.
 */
export function sendOutcomeFor(userId: string, ref: string): Promise<SendOutcome> | undefined {
  return outcomes.get(userId)?.get(ref);
}

/** Test seam. */
export function __resetSendOutcomesForTest(): void {
  outcomes.clear();
}
