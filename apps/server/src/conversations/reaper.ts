/**
 * Erases retained conversations once their window is up.
 *
 * The counterpart to the retention setting: without this, turning retention on
 * would mean keeping every deleted conversation forever, which is not what a
 * 30-day audit policy says and not something an admin can undo one row at a
 * time.
 *
 * Modelled on `files/reaper.ts` — hourly, unref'd, started at boot — with two
 * differences that come from what it deletes. It stands down entirely when the
 * policy is unreadable, and it skips anything an admin put on hold.
 */
import { db, and, eq, isNotNull, lt } from "@loxaic/db";
import { conversations } from "@loxaic/db/schema";
import { conversationRetentionUnknown, getConversationSettings } from "../settings.ts";
import { purgeConversations, type DeleteLogger } from "./delete.ts";

/** How often the sweep runs once started. Matches the attachment sweep: a
 * retention window is measured in days, so the hour it takes to notice one
 * expired is not a meaningful part of it. */
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

const consoleLogger: DeleteLogger = {
  warn(obj, msg) {
    console.warn("[conversation-reaper]", msg ?? "", obj);
  },
};

/**
 * Erases every retained conversation past its window, or — when retention is
 * off — every retained conversation there is.
 *
 * That second branch is the one that matters most. Retention off is the
 * default, so on an ordinary deployment this is what clears out anything left
 * behind by a window that used to be on, and it is why turning the switch off
 * is worded as a deletion in the settings card rather than as a preference.
 * Holds survive both branches: a hold is an admin saying "not this one", and a
 * policy change is not an answer to that.
 *
 * `ownerId` scopes the sweep to one user's rows. Production passes nothing;
 * the suites share one Postgres, and a test's deliberately short window must
 * not erase the conversation another suite is asserting on (the same rule
 * `reapAbandonedSandboxes` follows).
 */
export async function sweepRetainedConversations(ownerId?: string): Promise<number> {
  // Never act on a policy we could not read. Both branches here delete, so
  // "assume off and purge" is the one guess that cannot be taken back.
  if (conversationRetentionUnknown()) return 0;

  const { keepDeleted, keepDeletedDays } = getConversationSettings();

  const conditions = [isNotNull(conversations.deletedAt), eq(conversations.deletedHold, false)];
  if (keepDeleted) {
    // Computed here rather than in SQL against `now()` so the window is
    // measured against the same clock the admin screen's `purgeAt` uses.
    conditions.push(lt(conversations.deletedAt, new Date(Date.now() - keepDeletedDays * DAY_MS)));
  }
  if (ownerId) conditions.push(eq(conversations.ownerId, ownerId));

  const rows = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(and(...conditions))
    .limit(500);

  if (rows.length === 0) return 0;
  return purgeConversations(
    rows.map((r) => r.id),
    consoleLogger,
  );
}

export function startConversationReaper(onSweep?: (count: number) => void): NodeJS.Timeout {
  const timer = setInterval(() => {
    void sweepRetainedConversations().then(
      (n) => {
        if (n > 0) onSweep?.(n);
      },
      () => undefined,
    );
  }, SWEEP_INTERVAL_MS);
  timer.unref();
  return timer;
}

