import { PLAN_ACCEPTED_MESSAGE, PLAN_REJECTED_MESSAGE, QUESTIONS_ANSWERED_PREFIX } from '@loxaic/types'
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

export { PLAN_ACCEPTED_MESSAGE, PLAN_REJECTED_MESSAGE, QUESTIONS_ANSWERED_PREFIX }

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

// ── Questions ─────────────────────────────────────────────
//
// Planning mode's other way to end a turn (#199): questions whose answers
// would change the plan. Same rules as a plan — a successful call only, read
// from the transcript, answered by the user's next message.

/** Mirrors `QUESTIONS_TOOL_NAME` in `@loxaic/agent` — see PLAN_TOOL. */
export const QUESTIONS_TOOL = 'ask_questions'

export interface QuestionOption {
  label: string
  description?: string
}

export interface Question {
  question: string
  header?: string
  options: QuestionOption[]
  multiSelect: boolean
}

export interface ProposedQuestions {
  callId: string
  questions: Question[]
  /** The first question, for the card and the bar. */
  title: string
}

/** Answered once the user says anything after them; pending until then. */
export type QuestionsStatus = 'pending' | 'answered'

/**
 * The questions an `ask_questions` call carries, or undefined for any other
 * call. The server has already refused a malformed one (it never reaches
 * `ok: true`); this only has to read what passed, and drops anything it could
 * not render rather than trusting the shape blindly.
 */
export function questionsOf(tool: string, args: Record<string, unknown>): Question[] | undefined {
  if (tool !== QUESTIONS_TOOL || !Array.isArray(args.questions)) return undefined
  const out: Question[] = []
  for (const raw of args.questions as unknown[]) {
    if (typeof raw !== 'object' || raw === null) continue
    const q = raw as Record<string, unknown>
    if (typeof q.question !== 'string' || !Array.isArray(q.options)) continue
    const options = (q.options as unknown[]).flatMap((o): QuestionOption[] => {
      const { label, description } = (o ?? {}) as Record<string, unknown>
      if (typeof label !== 'string' || label.trim() === '') return []
      return [{ label, ...(typeof description === 'string' && description ? { description } : {}) }]
    })
    if (options.length === 0) continue
    out.push({
      question: q.question,
      ...(typeof q.header === 'string' && q.header ? { header: q.header } : {}),
      options,
      multiSelect: q.multiSelect === true,
    })
  }
  return out.length ? out : undefined
}

/** A plan or a set of questions, in the thread — what the panel, the bar and
 * the menu follow. */
export type ReviewItem =
  | { kind: 'plan'; callId: string; index: number; plan: ProposedPlan }
  | { kind: 'questions'; callId: string; index: number; questions: ProposedQuestions }

/** Every plan and question set, oldest first, with the same `ok === true`
 * gating as `plansIn`. */
export function reviewItemsIn(msgs: readonly Message[]): ReviewItem[] {
  const out: ReviewItem[] = []
  msgs.forEach((m, index) => {
    for (const t of m.tools ?? []) {
      if (!t.callId || t.ok !== true) continue
      if (t.tool === PLAN_TOOL && t.plan) {
        out.push({ kind: 'plan', callId: t.callId, index, plan: { callId: t.callId, text: t.plan, title: planTitle(t.plan) } })
      } else if (t.tool === QUESTIONS_TOOL && t.questions) {
        const title = t.questions[0]?.question ?? 'Questions'
        out.push({ kind: 'questions', callId: t.callId, index, questions: { callId: t.callId, questions: t.questions, title } })
      }
    }
  })
  return out
}

export function questionsStatus(msgs: readonly Message[], callId: string): QuestionsStatus | null {
  const item = reviewItemsIn(msgs).find((i) => i.callId === callId && i.kind === 'questions')
  if (!item) return null
  return msgs.slice(item.index + 1).some((m) => m.role === 'user') ? 'answered' : 'pending'
}

/** One question's answer as the panel collects it: the options chosen (by
 * index) and anything written in "Other". */
export interface Answer {
  selected: number[]
  other: string
}

export function isAnswered(answer: Answer | undefined): boolean {
  return !!answer && (answer.selected.length > 0 || answer.other.trim() !== '')
}

/**
 * The message the questions panel sends: a fixed first line, then each
 * question with its answer, in order. Plain text a person can read in the
 * transcript and a model can read back without a schema — the chosen labels as
 * written, "Other" answers verbatim.
 */
export function formatAnswers(questions: readonly Question[], answers: readonly (Answer | undefined)[]): string {
  const lines = questions.map((q, i) => {
    const a = answers[i]
    const parts = [
      ...(a?.selected ?? []).flatMap((n) => (q.options[n] ? [q.options[n].label] : [])),
      ...(a?.other.trim() ? [a.other.trim()] : []),
    ]
    return `${String(i + 1)}. ${q.question}\n→ ${parts.length ? parts.join('; ') : '(no answer)'}`
  })
  return [QUESTIONS_ANSWERED_PREFIX, '', ...lines].join('\n')
}
