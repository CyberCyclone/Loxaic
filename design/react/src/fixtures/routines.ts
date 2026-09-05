import type { Routine, RoutineRun, AgentRun } from '../types'

export const ROUTINES: Routine[] = [
  {
    id: 'r1', name: 'Daily standup summary', prompt: 'Summarize yesterday\'s commits and flag anything risky',
    cron: '0 9 * * 1-5', humanized: 'Weekdays 09:00', target: 'agent', directory: 'Loxaic/design',
    model: 'm3', lastRun: '6h ago', lastRunStatus: 'success', nextRun: 'Tomorrow 09:00', enabled: true,
  },
  {
    id: 'r2', name: 'Weekly dependency audit', prompt: 'Check for outdated/vulnerable dependencies and summarize',
    cron: '0 10 * * 1', humanized: 'Mondays 10:00', target: 'agent', directory: 'Loxaic/api',
    model: 'm1', lastRun: '3d ago', lastRunStatus: 'success', nextRun: 'Next Monday 10:00', enabled: true,
  },
  {
    id: 'r3', name: 'Nightly test runner', prompt: 'Run the full test suite and report failures',
    cron: '0 2 * * *', humanized: 'Daily 02:00', target: 'agent', directory: 'Loxaic/sync',
    model: 'm2', lastRun: '14h ago', lastRunStatus: 'error', nextRun: 'Tonight 02:00', enabled: true,
  },
  {
    id: 'r4', name: 'Monthly changelog generator', prompt: 'Generate a changelog from merged PRs since last release',
    cron: '0 0 1 * *', humanized: '1st of month 00:00', target: 'chat', directory: 'Loxaic/design',
    model: 'm2', lastRun: '2w ago', lastRunStatus: 'success', nextRun: 'Sep 1 00:00', enabled: false,
  },
]

export const ROUTINE_RUNS: Record<string, RoutineRun[]> = {
  r1: [
    { id: 'rr1', status: 'success', startedAt: '06:00', finishedAt: '06:01', duration: '47s', tokens: 1800 },
    { id: 'rr2', status: 'success', startedAt: 'Yesterday 09:00', finishedAt: 'Yesterday 09:01', duration: '52s', tokens: 1650 },
    { id: 'rr3', status: 'success', startedAt: '2d ago 09:00', finishedAt: '2d ago 09:01', duration: '41s', tokens: 1420 },
  ],
  r2: [
    { id: 'rr4', status: 'success', startedAt: 'Mon 10:00', finishedAt: 'Mon 10:03', duration: '3m 12s', tokens: 4200 },
  ],
  r3: [
    { id: 'rr5', status: 'error', startedAt: '14h ago 02:00', finishedAt: '14h ago 02:08', duration: '8m 04s', tokens: 8900 },
    { id: 'rr6', status: 'success', startedAt: '38h ago 02:00', finishedAt: '38h ago 02:06', duration: '6m 22s', tokens: 7800 },
  ],
  r4: [],
}

export const CRON_PRESETS = [
  { label: 'Every hour', cron: '0 * * * *' },
  { label: 'Daily 9am', cron: '0 9 * * *' },
  { label: 'Weekdays 9am', cron: '0 9 * * 1-5' },
  { label: 'Weekly Mon', cron: '0 10 * * 1' },
  { label: 'Monthly', cron: '0 0 1 * *' },
]

export function humanizeCron(cron: string): string {
  const presets = CRON_PRESETS.find(p => p.cron === cron)
  if (presets) return presets.label
  const parts = cron.split(' ')
  if (parts.length !== 5) return cron
  const [min, hour, dom, mon, dow] = parts
  if (dom === '*' && mon === '*') {
    if (dow === '*') return `Daily ${hour.padStart(2, '0')}:${min.padStart(2, '0')}`
    if (dow === '1-5') return `Weekdays ${hour.padStart(2, '0')}:${min.padStart(2, '0')}`
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
    const dayName = days[parseInt(dow) % 7] || dow
    return `${dayName} ${hour.padStart(2, '0')}:${min.padStart(2, '0')}`
  }
  if (dom === '1' && mon === '*') return `1st of month ${hour.padStart(2, '0')}:${min.padStart(2, '0')}`
  return cron
}

export function validateCron(cron: string): string | null {
  const parts = cron.trim().split(/\s+/)
  if (parts.length !== 5) return 'Cron must have 5 fields (min hour dom mon dow)'
  const ranges = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]]
  for (let i = 0; i < 5; i++) {
    if (parts[i] === '*') continue
    if (parts[i] === '*/n' || /^\*\/\d+$/.test(parts[i])) continue
    if (parts[i].includes('-')) {
      const [a, b] = parts[i].split('-').map(Number)
      if (isNaN(a) || isNaN(b) || a < ranges[i][0] || b > ranges[i][1]) return `Field ${i + 1}: invalid range`
      continue
    }
    if (parts[i].includes(',')) {
      for (const v of parts[i].split(',')) {
        const n = parseInt(v)
        if (isNaN(n) || n < ranges[i][0] || n > ranges[i][1]) return `Field ${i + 1}: ${v} out of range`
      }
      continue
    }
    const n = parseInt(parts[i])
    if (isNaN(n) || n < ranges[i][0] || n > ranges[i][1]) return `Field ${i + 1}: ${parts[i]} out of range (${ranges[i][0]}-${ranges[i][1]})`
  }
  return null
}
