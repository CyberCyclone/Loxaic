/**
 * Screenshots web_fetch took (#281): stored as the conversation owner's
 * attachments, shown on the tool card, and put in front of a model that can
 * see images.
 *
 * To the model a tool message stays a string (most backends refuse anything
 * else there). The images follow every tool message of the iteration as one
 * user message naming the calls they came from, so an assistant's tool calls
 * and their results still sit together, which strict backends require. The
 * live loop and the replay build that message with the same function from the
 * same stored bytes, so the prompt prefix the backend cached never changes
 * under it (streams/AGENTS.md).
 */
import { db, eq } from "@loxaic/db";
import { conversations } from "@loxaic/db/schema";
import type { AttachmentRef, ContentBlock } from "@loxaic/types";
import { storeGeneratedImage } from "../../files/generated.ts";
import { readAsDataUri } from "../../files/storage.ts";
import type { ChatMessage, ContentPart } from "../../inference/provider.ts";

/** How many screenshots a replayed prompt carries as images; older ones are
 * named but not resent. A viewport PNG is a few hundred KB, and a long
 * research thread would otherwise resend every one of them on every turn. */
export const SCREENSHOT_REPLAY_LIMIT = 4;

export interface ScreenshotTurn {
  callId: string;
  images: AttachmentRef[];
}

/** Stores a screenshot for `convId`, owned by the conversation's owner (an
 * editor's screenshot belongs to the conversation, like its sandbox). A
 * failure keeps the text result and says the image was not kept. */
export async function storeScreenshot(
  convId: string,
  callId: string,
  image: { bytes: Buffer; mime: "image/png" },
): Promise<{ images: AttachmentRef[] } | { note: string }> {
  try {
    const row = await db.query.conversations.findFirst({
      where: eq(conversations.id, convId),
      columns: { ownerId: true },
    });
    if (!row) return { note: "The screenshot was not kept: the conversation no longer exists." };
    const name = `screenshot-${callId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40) || "page"}.png`;
    const stored = await storeGeneratedImage({ bytes: image.bytes, mime: image.mime, ownerId: row.ownerId, name });
    return { images: [{ ref: stored.ref, mime: stored.mime, name: stored.filename }] };
  } catch (err) {
    return { note: `The screenshot was not kept: ${(err as Error).message}` };
  }
}

/** The user message that carries an iteration's screenshots to the model.
 * `include` says which refs go as images; the rest are named only. */
export async function screenshotMessage(turns: ScreenshotTurn[], include: (ref: string) => boolean = () => true): Promise<ChatMessage> {
  const parts: ContentPart[] = [];
  for (const turn of turns) {
    parts.push({ type: "text", text: `Screenshot from web_fetch (call ${turn.callId}):` });
    for (const image of turn.images) {
      if (!include(image.ref)) {
        parts.push({ type: "text", text: "[earlier screenshot, not resent]" });
        continue;
      }
      try {
        parts.push({ type: "image_url", image_url: { url: await readAsDataUri(image.ref, image.mime) } });
      } catch {
        parts.push({ type: "text", text: "[image unavailable]" });
      }
    }
  }
  return { role: "user", content: parts };
}

/** The screenshots a tool row showed the model, in stored order. */
export function screenshotTurnsOf(blocks: readonly ContentBlock[], presentCallIds: ReadonlySet<string>): ScreenshotTurn[] {
  const turns: ScreenshotTurn[] = [];
  for (const block of blocks) {
    if (block.kind !== "tool_result" || block.images_sent_to_model !== true || !block.images?.length) continue;
    if (!presentCallIds.has(block.call_id)) continue;
    turns.push({ callId: block.call_id, images: block.images });
  }
  return turns;
}

/** The newest `SCREENSHOT_REPLAY_LIMIT` screenshot refs across a replay. */
export function replayedScreenshotRefs(turns: readonly ScreenshotTurn[]): Set<string> {
  const refs = turns.flatMap((t) => t.images.map((i) => i.ref));
  return new Set(refs.slice(-SCREENSHOT_REPLAY_LIMIT));
}
