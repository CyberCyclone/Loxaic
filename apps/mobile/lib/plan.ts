import { PLAN_ACCEPTED_MESSAGE, PLAN_REJECTED_MESSAGE } from '@loxaic/types'
import type { AgentMode, Message } from './types'

/**
 * Planning mode's plans, as the client sees them (#199).
 *
 * A plan is a successful `propose_plan` tool call: the server offers that tool
 * in planning mode only, and a successful call ends the turn. Everything here
 * is read from the transcript — the plan from the call's arguments, what
 * became of it from the reply that follows — so it is the same live, after a
 * reload, and on a second device, with nothing stored anywhere else.
 *
 * Pure, so the rules are asserted (plan.test.ts).
 */

/** Mirrors `PLAN_TOOL_NAME` in `@loxaic/agent`, which this app does not
 * depend on. It is on the wire, so a rename there stops every plan rendering
 * here — which the e2e spec would see at once. */
export const PLAN_TOOL = 'propose_plan'

export { PLAN_ACCEPTED_MESSAGE, PLAN_REJECTED_MESSAGE }

export interface ProposedPlan {
  callId: string
  /** The plan as the model wrote it, in Markdown. */
  text: string
  /** Its first line, for the card, the bar and the panel's header. */
  title: string
}

/**
 * What became of a plan.
 *
 * - `pending` — nothing has been said since;
 * - `accepted` / `rejected` — the reply was that decision's fixed text;
 * - `superseded` — a newer plan exists, so this one is history;
 * - `changes` — anything else was said and no new plan has come of it yet:
 *   a suggestion, or an ordinary message typed into the composer.
 *
 * "Open" (see `isOpen`) is pending or changes: a plan nobody has accepted or
 * rejected, which the bar above the toolbar keeps in view.
 */
export type PlanStatus = 'pending' | 'accepted' | 'rejected' | 'superseded' | 'changes'

export function isOpen(status: PlanStatus | null): boolean {
  return status === 'pending' || status === 'changes'
}

/** The plan's first line, without Markdown heading, list or bold markers. */
export function planTitle(text: string): string {
  const first = text
    .split('\n')
    .map((l) => l.replace(/^\s*(#+|[-*]|\d+[.)])\s*/, '').replace(/\*\*/g, '').trim())
    .find((l) => l !== '')
  if (!first) return 'Plan'
  return first.length > 80 ? `${first.slice(0, 79)}…` : first
}

/** The plan a call carries, or undefined for any other call — and for a
 * refused one with an empty plan, which never reached anyone as a plan. */
export function planOf(tool: string, args: Record<string, unknown>): string | undefined {
  if (tool !== PLAN_TOOL) return undefined
  return typeof args.plan === 'string' && args.plan.trim() !== '' ? args.plan : undefined
}

/**
 * Every plan in the thread, oldest first.
 *
 * Only a call the server accepted counts (`ok === true`): a refused empty plan,
 * a call stopped by the user, one skipped after "answer now", and an
 * unknown-tool call outside planning mode all have `ok: false`, and a call
 * whose result has not arrived is not a plan anyone has been shown yet.
 */
export function plansIn(msgs: readonly Message[]): (ProposedPlan & { index: number })[] {
  const out: (ProposedPlan & { index: number })[] = []
  msgs.forEach((m, index) => {
    for (const t of m.tools ?? []) {
      if (t.tool !== PLAN_TOOL || !t.plan || !t.callId || t.ok !== true) continue
      out.push({ callId: t.callId, text: t.plan, title: planTitle(t.plan), index })
    }
  })
  return out
}

/** The newest plan — what the menu item and the bar open. */
export function latestPlan(msgs: readonly Message[]): ProposedPlan | null {
  const last = plansIn(msgs).at(-1)
  return last ? { callId: last.callId, text: last.text, title: last.title } : null
}

export function planStatus(msgs: readonly Message[], callId: string): PlanStatus | null {
  const all = plansIn(msgs)
  const at = all.findIndex((p) => p.callId === callId)
  if (at < 0) return null
  const reply = msgs.slice(all[at].index + 1).find((m) => m.role === 'user')
  if (reply?.text === PLAN_ACCEPTED_MESSAGE) return 'accepted'
  if (reply?.text === PLAN_REJECTED_MESSAGE) return 'rejected'
  if (at < all.length - 1) return 'superseded'
  return reply ? 'changes' : 'pending'
}

/**
 * The mode "Accept plan" runs the work in: the Default mode from Settings,
 * or Manual when that default is Planning — accepting a plan is leaving
 * planning, never re-entering it.
 */
export function acceptMode(defaultMode: AgentMode): Exclude<AgentMode, 'planning'> {
  return defaultMode === 'planning' ? 'manual' : defaultMode
}
