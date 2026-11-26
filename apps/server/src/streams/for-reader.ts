/**
 * What one reader of a conversation may see of what another person in it
 * revealed about where they are: their `local_time` block (its zone) and
 * their `get_location` results (`locationResultFor` in packages/types). The
 * model still has both; only what goes out to people is narrowed, on every
 * path: stored rows (the message routes), live events and snapshots
 * (ws/delivery.ts).
 */
import { locationResultFor, type ContentBlock, type StreamEventKind, type StreamSnapshot } from "@loxaic/types";
import { withoutOthersLocalTime } from "./runs/local-time.ts";

/** A stored row's content as `reader` sees it. */
export function contentForReader(content: unknown, authorUserId: string | null, reader: string): unknown {
  const kept = withoutOthersLocalTime(content, authorUserId, reader);
  if (!Array.isArray(kept)) return kept;
  const blocks = kept as ContentBlock[];
  const out = blocks.map((b) => (b.kind === "tool_result" && b.device ? locationResultFor(b, reader) : b));
  return out.some((b, i) => b !== blocks[i]) ? out : kept;
}

/** A live stream event as `reader` sees it. */
export function eventForReader(event: StreamEventKind, reader: string): StreamEventKind {
  return event.kind === "tool.result" && event.device ? locationResultFor(event, reader) : event;
}

/** A catch-up snapshot as `reader` sees it. */
export function snapshotForReader(snapshot: StreamSnapshot, reader: string): StreamSnapshot {
  let changed = 0;
  const messages = snapshot.messages.map((m) => {
    const calls = m.tool_calls.map((c) => (c.device ? locationResultFor(c, reader) : c));
    const differs = calls.filter((c, i) => c !== m.tool_calls[i]).length;
    changed += differs;
    return differs ? { ...m, tool_calls: calls } : m;
  });
  return changed ? { ...snapshot, messages } : snapshot;
}
