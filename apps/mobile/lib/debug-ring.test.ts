import { describe, expect, it } from 'vitest'
import type { DebugEvent } from '@shannon/api-client'
import { DebugRing, debugBody, describeChannel, isTruncated } from './debug-ring'

const raw = (n: number): DebugEvent => ({ channel: 'model.raw', stream_id: 's', lines: [`line ${n}`] })

describe('DebugRing', () => {
  it('keeps insertion order and assigns stable ids', () => {
    const ring = new DebugRing(10)
    ring.push(1, raw(1))
    ring.push(2, raw(2))
    const snap = ring.snapshot()
    expect(snap.map((e) => e.id)).toEqual([1, 2])
    expect(snap.map((e) => e.ts)).toEqual([1, 2])
  })

  it('drops the oldest entries past capacity', () => {
    const ring = new DebugRing(3)
    for (let i = 1; i <= 5; i++) ring.push(i, raw(i))
    const snap = ring.snapshot()
    expect(snap).toHaveLength(3)
    expect(snap.map((e) => e.id)).toEqual([3, 4, 5])
    expect(ring.overflowed).toBe(true)
  })

  it('reports no overflow while under capacity, and clears', () => {
    const ring = new DebugRing(3)
    ring.push(1, raw(1))
    expect(ring.overflowed).toBe(false)
    ring.clear()
    expect(ring.size).toBe(0)
    expect(ring.snapshot()).toEqual([])
  })

  it('hands out a fresh array so React state changes identity', () => {
    const ring = new DebugRing()
    ring.push(1, raw(1))
    expect(ring.snapshot()).not.toBe(ring.snapshot())
  })
})

describe('entry rendering helpers', () => {
  it('labels each channel distinctly', () => {
    expect(describeChannel({ channel: 'model.request', stream_id: 's', model: 'm', body: '{}' })).toContain('request')
    expect(describeChannel(raw(1))).toContain('1 line')
    expect(
      describeChannel({ channel: 'model.done', stream_id: 's', finish_reason: 'stop', duration_ms: 12 }),
    ).toContain('12ms')
    expect(
      describeChannel({
        channel: 'tool.call',
        stream_id: 's',
        call_id: 'c',
        tool: 'brave__web',
        source: { kind: 'mcp', server: 'brave' },
        args: '{}',
      }),
    ).toContain('brave')
    expect(
      describeChannel({
        channel: 'tool.result_raw',
        stream_id: 's',
        call_id: 'c',
        tool: 'bash',
        ok: false,
        raw: 'boom',
        duration_ms: 3,
      }),
    ).toContain('bash')
    expect(
      describeChannel({ channel: 'mcp.lifecycle', server: 'brave', event: 'unavailable', message: 'x' }),
    ).toContain('brave')
  })

  it('exposes the right body per channel', () => {
    expect(debugBody({ channel: 'model.request', stream_id: 's', model: 'm', body: 'BODY' })).toBe('BODY')
    expect(debugBody({ channel: 'model.raw', stream_id: 's', lines: ['a', 'b'] })).toBe('a\nb')
    expect(debugBody({ channel: 'mcp.lifecycle', server: 'x', event: 'connect_failed', message: 'why' })).toBe('why')
  })

  it('surfaces the truncation flag only when set', () => {
    expect(isTruncated({ channel: 'model.request', stream_id: 's', model: 'm', body: 'x', truncated: true })).toBe(true)
    expect(isTruncated({ channel: 'model.request', stream_id: 's', model: 'm', body: 'x' })).toBe(false)
    expect(isTruncated(raw(1))).toBe(false)
  })
})
