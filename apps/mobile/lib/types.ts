export type SurfaceId = 'chat' | 'agent' | 'routines' | 'mcp' | 'stats' | 'launcher' | 'admin'

export type ModelLocation = 'server' | 'device' | 'remote'

export type ConversationKind = 'chat' | 'agent' | 'routine'

export type MessageLocation = 'server' | 'device'

export type AgentMode = 'planning' | 'manual' | 'auto'

export type RunState = 'running' | 'awaiting_approval' | 'done' | 'error'

export type ThinkingLevel = 'None' | 'Low' | 'Medium' | 'High'

export type ThemePref = 'light' | 'dark' | 'system'

export type SmartRoutingProfile = 'cloud' | 'server' | 'hybrid'

export type { ModelInfo } from '@loxaic/api-client'
export type { ContextBreakdown, ContextCategory, ContextPart, CompactionStats, SlashCommand, AttachmentRef } from '@loxaic/api-client'
import type { ContextBreakdown, CompactionStats, AttachmentRef } from '@loxaic/api-client'

export const THINKING_LEVELS: ThinkingLevel[] = ['None', 'Low', 'Medium', 'High']

export interface Workspace {
  name: string
  path: string
}

export interface MessageUsage {
  in: number
  out: number
  /** Generation speed (tokens/sec). */
  tps: number
  /**
   * Prompt-evaluation speed (tokens/sec) over the tokens actually evaluated.
   * Null whenever the backend doesn't report how many that was — LM Studio
   * never does. It must not be derived from `in / ttftMs`: on a cache hit that
   * produces a number like 47,742 tok/s, which is not a speed. Show `in`
   * against `ttftMs` instead.
   */
  promptTps?: number | null
  /** Total wall-clock duration (ms) of the response: model load (if any), prompt eval, and generation. */
  totalMs?: number | null
  /** Time to first token (ms) — the prompt-evaluation cost. */
  ttftMs?: number | null
  /** Tokens the backend reported reusing from its cache. Null = the backend
   * doesn't report it, which is not the same as nothing being cached. */
  cachedTokens?: number | null
  /** Tokens of the prompt that repeated the previous request's prompt exactly
   * — what the server offered the backend to reuse. Available on every
   * backend. */
  reusableTokens?: number | null
  /** What this turn's prompt was made of. Computed server-side — the agent's
   * tool schemas never appear in the message list, so this can't be derived
   * here. Absent on turns predating the feature, and when usage wasn't reported. */
  context?: ContextBreakdown
}

export interface ToolCall {
  tool: string
  summary: string
  result: string
  duration?: string
  diff?: DiffLine[]
  /** call_id from the agent protocol — used to join a later tool_result while streaming. Not from the design source. */
  callId?: string
}

export interface DiffLine {
  type: 'add' | 'del' | 'meta' | 'ctx'
  text: string
}

export interface Message {
  id?: string
  role: 'user' | 'assistant' | 'summary'
  model?: string
  text: string
  thinking?: string
  tools?: ToolCall[]
  usage?: MessageUsage
  forks?: string[]
  origin?: MessageLocation
  error?: boolean
  /** User-initiated stop (stream.stop), not a failure — rendered distinctly from `error`. */
  stopped?: boolean
  /** Present only on role: 'summary' — what a /compact did. Absent while the
   * summary is still streaming (its own `compaction` event hasn't landed yet). */
  compaction?: CompactionStats
  /** User messages only. `ref` is absent for the brief window between an
   * optimistic send and the server's own message.start — `localUri` covers
   * rendering during that gap. */
  attachments?: (Partial<AttachmentRef> & { localUri?: string; mime: string })[]
}

export interface Conversation {
  id: string
  title: string
  kind: ConversationKind
  time: string
  model: string
  location: MessageLocation
  msgs: Message[]
  /** Server-side last-activity timestamp (ISO). The offline cache sorts and
   * evicts on this rather than on when it happened to write a row — the two
   * disagree, and the second one is meaningless to a user. Absent on a
   * locally-created conversation until the server has listed it. */
  updatedAt?: string
  /** What this user may do here. Absent means owner — a locally-created
   * conversation that hasn't round-tripped through the server yet is always
   * the creator's own. */
  role?: ConversationRole
  /** The owner's display name, for a thread shared with this user. Absent on
   * their own conversations, which is what the sidebar keys on to badge. */
  sharedBy?: string
}

export type ConversationRole = 'viewer' | 'editor' | 'owner'

/** May this user send into the conversation? Absent role means their own. */
export function canEdit(conv: { role?: ConversationRole } | null | undefined): boolean {
  return !conv?.role || conv.role === 'owner' || conv.role === 'editor'
}

export interface Routine {
  id: string
  name: string
  prompt: string
  cron: string
  humanized: string
  target: string
  directory: string
  model: string
  lastRun: string | null
  lastRunStatus: string | null
  nextRun: string | null
  enabled: boolean
}

export interface RoutineRun {
  id: string
  status: string
  startedAt: string
  finishedAt: string
  duration: string
  tokens: number
}

export interface TodoItem {
  text: string
  done: boolean
}

export interface ChangedFile {
  path: string
  adds: number
  dels: number
}

export interface AgentRun {
  id: string
  title: string
  target: string
  state: RunState
  mode: AgentMode
  prompt: string
  messages: Message[]
  todos: TodoItem[]
  changedFiles: ChangedFile[]
  contextPercent: number
}

export interface KpiData {
  label: string
  value: string
  delta: string
  deltaDir: 'up' | 'down'
  spark: number[]
}

export interface ChartPoint {
  label: string
  values: Record<string, number>
}

export interface PerModelStat {
  model: string
  conversations: number
  tokens: number
  /** Null when no turn in the window carried a reuse figure. */
  cachePct: number | null
  ppSpeed: number
  tgSpeed: number
  ttftP50: number
  ttftP95: number
  ttftP99: number
}

export interface PerConvStat {
  title: string
  model: string
  tokens: number
  /** Null when no turn in the window carried a reuse figure. */
  cachePct: number | null
  time: string
}

export interface Settings {
  name: string
  defaultMode: AgentMode
  defaultThinkingLevel: ThinkingLevel
  tailscale: string
  endpoint: string
}

export interface SmartRouting {
  profile: SmartRoutingProfile
  planning: string
  heavyThinking: string
  simpleJobs: string
}
