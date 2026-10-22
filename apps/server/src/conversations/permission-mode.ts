import { db, eq } from "@loxaic/db";
import { conversations } from "@loxaic/db/schema";
import type { PermissionMode } from "@loxaic/types";
import { announceConversationEvent } from "../streams/watchers.ts";

/**
 * Remember `mode` as the one the thread opens in (#311), and tell the
 * owner's other devices watching it. Callers record only the owner's own
 * sends and picks: the column is the owner's, and an editor's Auto must never
 * become the mode the owner's next message goes out in.
 *
 * Best-effort: a pick or a send that is not remembered has still happened.
 */
export async function recordPermissionMode(conversationId: string, mode: PermissionMode): Promise<void> {
  try {
    await db.update(conversations).set({ permissionMode: mode }).where(eq(conversations.id, conversationId));
  } catch (err) {
    console.warn(`recording the mode of ${conversationId} failed: ${(err as Error).message}`);
    return;
  }
  announceConversationEvent({ type: "conversation.mode", conversation_id: conversationId, mode });
}
