import type { DebugEvent } from '@shannon/api-client'

export type DebugEntry = {
  /** Monotonic within a session — stable list key across re-renders. */
  id: number
  ts: number
  event: DebugEvent
}

/** Raw telemetry is unbounded; the panel only ever shows a recent window. */
export const DEBUG_RING_CAPACITY = 300

/**
 * Fixed-capacity, drop-oldest buffer for live debug events, with a throttled
 * read so a fast local model streaming SSE lines can't drive one React render
 * per frame.
 */
export class DebugRing {
  private entries: DebugEntry[] = []
  private nextId = 1

  constructor(private readonly capacity: number = DEBUG_RING_CAPACITY) {}

  push(ts: number, event: DebugEvent): void {
    this.entries.push({ id: this.nextId++, ts, event })
    if (this.entries.length > this.capacity) {
      this.entries.splice(0, this.entries.length - this.capacity)
    }
  }

  /** A fresh array each call — callers hand it straight to React state. */
  snapshot(): DebugEntry[] {
    return [...this.entries]
  }

  get size(): number {
    return this.entries.length
  }

  /** True once the buffer has started discarding the oldest entries. */
  get overflowed(): boolean {
    return this.nextId - 1 > this.capacity
  }

  clear(): void {
    this.entries = []
  }
}

/** Human label for a channel, used by the panel's entry headers. */
export function describeChannel(event: DebugEvent): string {
  switch (event.channel) {
    case 'model.request':
      return `→ request · ${event.model}`
    case 'model.raw':
      return `← raw · ${event.lines.length} line${event.lines.length === 1 ? '' : 's'}`
    case 'model.done':
      return `✓ done · ${event.finish_reason ?? 'unknown'} · ${event.duration_ms}ms`
    case 'tool.call':
      return `→ ${event.tool}${event.source.kind === 'mcp' ? ` · ${event.source.server}` : ''}`
    case 'tool.result_raw':
      return `${event.ok ? '←' : '✕'} ${event.tool} · ${event.duration_ms}ms`
    case 'mcp.lifecycle':
      return `! ${event.server} · ${event.event}`
  }
}

/** The monospace body rendered for an entry. */
export function debugBody(event: DebugEvent): string {
  switch (event.channel) {
    case 'model.request':
      return event.body
    case 'model.raw':
      return event.lines.join('\n')
    case 'model.done':
      return JSON.stringify({ finish_reason: event.finish_reason, usage: event.usage, duration_ms: event.duration_ms }, null, 2)
    case 'tool.call':
      return event.args
    case 'tool.result_raw':
      return event.raw
    case 'mcp.lifecycle':
      return event.message
  }
}

export function isTruncated(event: DebugEvent): boolean {
  return 'truncated' in event && !!event.truncated
}
