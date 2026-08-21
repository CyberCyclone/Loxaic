export type SurfaceId = 'chat' | 'agent' | 'routines' | 'stats' | 'launcher'

export type ModelLocation = 'server' | 'device' | 'remote'

export type ConversationKind = 'chat' | 'agent' | 'routine'

export type MessageLocation = 'server' | 'device'

export type AgentMode = 'planning' | 'manual' | 'auto'

export type RunState = 'running' | 'awaiting_approval' | 'done' | 'error'

export type ThinkingLevel = 'None' | 'Low' | 'Medium' | 'High'

export type ThemePref = 'light' | 'dark' | 'system'

export type SmartRoutingProfile = 'cloud' | 'server' | 'hybrid'

export interface ModelInfo {
  id: string
  display_name: string
  quant: string
  context_tokens: number
  location: ModelLocation
  price: number
}

export interface Workspace {
  name: string
  path: string
}

export interface MessageUsage {
  in: number
  out: number
  tps: number
  cache: number
}

export interface ToolCall {
  tool: string
  summary: string
  result: string
  duration?: string
  diff?: DiffLine[]
}

export interface DiffLine {
  type: 'add' | 'del' | 'meta' | 'ctx'
  text: string
}

export interface Message {
  role: 'user' | 'assistant'
  model?: string
  text: string
  thinking?: string
  tools?: ToolCall[]
  usage?: MessageUsage
  forks?: string[]
  origin?: MessageLocation
}

export interface Conversation {
  id: string
  title: string
  kind: ConversationKind
  time: string
  model: string
  location: MessageLocation
  msgs: Message[]
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
  cachePct: number
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
  cachePct: number
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
