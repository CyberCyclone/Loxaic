/**
 * A person's command rules (permissions/bash/rules.ts), one row each in
 * `command_rules`. Every write is one statement — an insert that ignores a
 * rule already there, or a delete — so a grant from one device and a removal
 * from another never overwrite each other the way a whole-list write would.
 */
import { and, db, eq } from "@loxaic/db";
import { commandRules } from "@loxaic/db/schema";
import { normalizePattern, validatePattern, type CommandRule, type RuleAction } from "./bash/rules.ts";

export interface StoredCommandRule extends CommandRule {
  id: string;
  source: "prompt" | "settings";
  createdAt: Date;
}

export class CommandRuleError extends Error {}

const ACTIONS: readonly RuleAction[] = ["allow", "ask", "deny"];

export function isRuleAction(value: unknown): value is RuleAction {
  return typeof value === "string" && (ACTIONS as readonly string[]).includes(value);
}

/** Every rule this person has, oldest first. A failed read is no rules,
 * which only ever asks more. */
export async function loadCommandRules(userId: string): Promise<StoredCommandRule[]> {
  try {
    const rows = await db.query.commandRules.findMany({
      where: eq(commandRules.userId, userId),
      orderBy: (r, { asc }) => [asc(r.createdAt), asc(r.id)],
    });
    return rows.map((r) => ({ id: r.id, pattern: r.pattern, action: r.action, source: r.source, createdAt: r.createdAt }));
  } catch (err) {
    console.warn(`could not read the command rules of ${userId}: ${(err as Error).message}`);
    return [];
  }
}

/** Adds rules, ignoring any already there. Throws CommandRuleError for a
 * pattern that is not acceptable — the server's own proposals never are. */
export async function addCommandRules(
  userId: string,
  patterns: readonly string[],
  action: RuleAction,
  source: StoredCommandRule["source"],
): Promise<void> {
  const values = patterns.map((p) => {
    const problem = validatePattern(p);
    if (problem) throw new CommandRuleError(problem);
    return { userId, pattern: normalizePattern(p), action, source };
  });
  if (values.length === 0) return;
  await db.insert(commandRules).values(values).onConflictDoNothing();
}

/** Removes one rule. False when it was not this person's or not there. */
export async function deleteCommandRule(userId: string, id: string): Promise<boolean> {
  const removed = await db
    .delete(commandRules)
    .where(and(eq(commandRules.id, id), eq(commandRules.userId, userId)))
    .returning({ id: commandRules.id });
  return removed.length > 0;
}
