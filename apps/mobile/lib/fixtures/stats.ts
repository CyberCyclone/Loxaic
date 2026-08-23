import type { KpiData, ChartPoint, PerModelStat, PerConvStat } from '../types'

export const KPIS: Record<string, KpiData[]> = {
  today: [
    { label: 'Total Tokens', value: '2,847,392', delta: '+12.3%', deltaDir: 'up', spark: [20, 35, 28, 45, 38, 52, 48, 60, 55, 68, 72, 80] },
    { label: 'Cache Hit %', value: '68.4%', delta: '+4.1%', deltaDir: 'up', spark: [55, 58, 60, 59, 62, 65, 63, 67, 66, 68, 69, 68] },
    { label: 'Avg TTFT', value: '142ms', delta: '-8ms', deltaDir: 'up', spark: [180, 165, 155, 160, 148, 152, 145, 150, 142, 140, 138, 142] },
    { label: 'Avg Gen tok/s', value: '38.2', delta: '+2.1', deltaDir: 'up', spark: [30, 32, 34, 33, 35, 36, 34, 37, 38, 36, 39, 38] },
  ],
  week: [
    { label: 'Total Tokens', value: '18,294,503', delta: '+8.7%', deltaDir: 'up', spark: [40, 52, 48, 60, 55, 68, 72] },
    { label: 'Cache Hit %', value: '64.2%', delta: '+2.3%', deltaDir: 'up', spark: [58, 60, 59, 62, 61, 64, 64] },
    { label: 'Avg TTFT', value: '156ms', delta: '-3ms', deltaDir: 'up', spark: [170, 165, 160, 158, 155, 152, 156] },
    { label: 'Avg Gen tok/s', value: '36.5', delta: '+1.8', deltaDir: 'up', spark: [32, 34, 35, 34, 36, 37, 36] },
  ],
  month: [
    { label: 'Total Tokens', value: '72,847,291', delta: '+15.2%', deltaDir: 'up', spark: [30, 45, 40, 55, 50, 62, 58, 68, 65, 72, 70, 75, 78, 80, 82, 85, 80, 88, 90, 85, 88, 92, 90, 95, 92, 98, 100, 95, 98, 102] },
    { label: 'Cache Hit %', value: '61.8%', delta: '+1.2%', deltaDir: 'up', spark: [55, 56, 58, 57, 59, 60, 58, 61, 60, 62, 61, 63, 62, 62, 61, 62, 63, 62, 61, 62, 62, 63, 62, 62, 61, 62, 62, 62, 61, 62] },
    { label: 'Avg TTFT', value: '168ms', delta: '+5ms', deltaDir: 'down', spark: [150, 155, 160, 158, 162, 165, 160, 168, 170, 165, 168, 170, 168, 172, 170, 168, 170, 172, 168, 170, 168, 166, 168, 170, 168, 170, 168, 170, 168, 168] },
    { label: 'Avg Gen tok/s', value: '35.1', delta: '-0.3', deltaDir: 'down', spark: [36, 35, 36, 35, 34, 35, 36, 35, 34, 35, 36, 35, 35, 34, 35, 35, 34, 35, 36, 35, 34, 35, 35, 36, 35, 34, 35, 35, 35, 35] },
  ],
  session: [
    { label: 'Total Tokens', value: '142,830', delta: '—', deltaDir: 'up', spark: [10, 25, 40, 55, 70, 85, 100] },
    { label: 'Cache Hit %', value: '72.1%', delta: '—', deltaDir: 'up', spark: [65, 68, 70, 71, 72, 72, 72] },
    { label: 'Avg TTFT', value: '128ms', delta: '—', deltaDir: 'up', spark: [145, 140, 135, 132, 130, 128, 128] },
    { label: 'Avg Gen tok/s', value: '41.5', delta: '—', deltaDir: 'up', spark: [38, 39, 40, 41, 42, 41, 42] },
  ],
  year: [
    { label: 'Total Tokens', value: '847M', delta: '+24.1%', deltaDir: 'up', spark: [20, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80] },
    { label: 'Cache Hit %', value: '58.3%', delta: '+6.2%', deltaDir: 'up', spark: [45, 48, 50, 52, 54, 55, 56, 57, 58, 58, 59, 58] },
    { label: 'Avg TTFT', value: '185ms', delta: '-22ms', deltaDir: 'up', spark: [210, 205, 200, 195, 190, 188, 185, 183, 182, 185, 186, 185] },
    { label: 'Avg Gen tok/s', value: '33.8', delta: '+3.2', deltaDir: 'up', spark: [28, 29, 30, 31, 32, 33, 34, 33, 34, 35, 34, 34] },
  ],
}

export const TOKENS_OVER_TIME: Record<string, ChartPoint[]> = {
  today: [
    { label: '00', values: { 'Llama 3.1 8B': 12000, 'Qwen 2.5 14B': 8000, 'Phi 3 Mini': 2000 } },
    { label: '04', values: { 'Llama 3.1 8B': 8000, 'Qwen 2.5 14B': 4000, 'Phi 3 Mini': 1000 } },
    { label: '08', values: { 'Llama 3.1 8B': 45000, 'Qwen 2.5 14B': 22000, 'Phi 3 Mini': 8000 } },
    { label: '12', values: { 'Llama 3.1 8B': 38000, 'Qwen 2.5 14B': 18000, 'Phi 3 Mini': 6000 } },
    { label: '16', values: { 'Llama 3.1 8B': 52000, 'Qwen 2.5 14B': 28000, 'Phi 3 Mini': 10000 } },
    { label: '20', values: { 'Llama 3.1 8B': 28000, 'Qwen 2.5 14B': 14000, 'Phi 3 Mini': 4000 } },
    { label: 'now', values: { 'Llama 3.1 8B': 15000, 'Qwen 2.5 14B': 7000, 'Phi 3 Mini': 2000 } },
  ],
  week: [
    { label: 'Mon', values: { 'Llama 3.1 8B': 280000, 'Qwen 2.5 14B': 140000, 'Phi 3 Mini': 40000 } },
    { label: 'Tue', values: { 'Llama 3.1 8B': 320000, 'Qwen 2.5 14B': 160000, 'Phi 3 Mini': 50000 } },
    { label: 'Wed', values: { 'Llama 3.1 8B': 290000, 'Qwen 2.5 14B': 130000, 'Phi 3 Mini': 38000 } },
    { label: 'Thu', values: { 'Llama 3.1 8B': 350000, 'Qwen 2.5 14B': 180000, 'Phi 3 Mini': 62000 } },
    { label: 'Fri', values: { 'Llama 3.1 8B': 310000, 'Qwen 2.5 14B': 150000, 'Phi 3 Mini': 45000 } },
    { label: 'Sat', values: { 'Llama 3.1 8B': 120000, 'Qwen 2.5 14B': 60000, 'Phi 3 Mini': 18000 } },
    { label: 'Sun', values: { 'Llama 3.1 8B': 90000, 'Qwen 2.5 14B': 40000, 'Phi 3 Mini': 12000 } },
  ],
  month: Array.from({ length: 30 }, (_, i) => ({
    label: `${i + 1}`,
    values: {
      'Llama 3.1 8B': 100000 + Math.round(Math.sin(i * 0.3) * 50000) + 200000,
      'Qwen 2.5 14B': 50000 + Math.round(Math.cos(i * 0.4) * 30000) + 100000,
      'Phi 3 Mini': 15000 + Math.round(Math.sin(i * 0.5) * 10000) + 30000,
    },
  })),
  session: [
    { label: '10m', values: { 'Llama 3.1 8B': 45000, 'Qwen 2.5 14B': 0, 'Phi 3 Mini': 0 } },
    { label: '20m', values: { 'Llama 3.1 8B': 82000, 'Qwen 2.5 14B': 22000, 'Phi 3 Mini': 0 } },
    { label: '30m', values: { 'Llama 3.1 8B': 95000, 'Qwen 2.5 14B': 38000, 'Phi 3 Mini': 8000 } },
    { label: 'now', values: { 'Llama 3.1 8B': 102000, 'Qwen 2.5 14B': 42000, 'Phi 3 Mini': 12000 } },
  ],
  year: [
    { label: 'Jan', values: { 'Llama 3.1 8B': 400000, 'Qwen 2.5 14B': 200000, 'Phi 3 Mini': 50000 } },
    { label: 'Feb', values: { 'Llama 3.1 8B': 420000, 'Qwen 2.5 14B': 210000, 'Phi 3 Mini': 55000 } },
    { label: 'Mar', values: { 'Llama 3.1 8B': 480000, 'Qwen 2.5 14B': 240000, 'Phi 3 Mini': 62000 } },
    { label: 'Apr', values: { 'Llama 3.1 8B': 520000, 'Qwen 2.5 14B': 280000, 'Phi 3 Mini': 70000 } },
    { label: 'May', values: { 'Llama 3.1 8B': 580000, 'Qwen 2.5 14B': 300000, 'Phi 3 Mini': 80000 } },
    { label: 'Jun', values: { 'Llama 3.1 8B': 620000, 'Qwen 2.5 14B': 320000, 'Phi 3 Mini': 85000 } },
    { label: 'Jul', values: { 'Llama 3.1 8B': 680000, 'Qwen 2.5 14B': 350000, 'Phi 3 Mini': 92000 } },
    { label: 'Aug', values: { 'Llama 3.1 8B': 720000, 'Qwen 2.5 14B': 380000, 'Phi 3 Mini': 100000 } },
  ],
}

export const CACHE_HIT_RATE: Record<string, { label: string; value: number }[]> = {
  today: [
    { label: '00', value: 55 }, { label: '04', value: 58 }, { label: '08', value: 62 },
    { label: '12', value: 65 }, { label: '16', value: 68 }, { label: '20', value: 67 }, { label: 'now', value: 68 },
  ],
  week: [
    { label: 'Mon', value: 60 }, { label: 'Tue', value: 62 }, { label: 'Wed', value: 59 },
    { label: 'Thu', value: 63 }, { label: 'Fri', value: 64 }, { label: 'Sat', value: 58 }, { label: 'Sun', value: 57 },
  ],
  month: Array.from({ length: 30 }, (_, i) => ({ label: `${i + 1}`, value: 55 + Math.round(Math.sin(i * 0.3) * 8) + 5 })),
  session: [
    { label: '10m', value: 65 }, { label: '20m', value: 68 }, { label: '30m', value: 71 }, { label: 'now', value: 72 },
  ],
  year: [
    { label: 'Jan', value: 48 }, { label: 'Feb', value: 50 }, { label: 'Mar', value: 52 }, { label: 'Apr', value: 54 },
    { label: 'May', value: 55 }, { label: 'Jun', value: 56 }, { label: 'Jul', value: 57 }, { label: 'Aug', value: 58 },
  ],
}

export const MODEL_SPEEDS: PerModelStat[] = [
  { model: 'Llama 3.1 8B', conversations: 142, tokens: 1847291, cachePct: 68, ppSpeed: 120, tgSpeed: 42, ttftP50: 95, ttftP95: 180, ttftP99: 320 },
  { model: 'Qwen 2.5 14B', conversations: 67, tokens: 820103, cachePct: 58, ppSpeed: 85, tgSpeed: 28, ttftP50: 165, ttftP95: 280, ttftP99: 450 },
  { model: 'Phi 3 Mini', conversations: 34, tokens: 180000, cachePct: 71, ppSpeed: 200, tgSpeed: 55, ttftP50: 48, ttftP95: 95, ttftP99: 140 },
]

export const PER_CONV_STATS: PerConvStat[] = [
  { title: 'Rust vs Go for CLI tools', model: 'Llama 3.1 8B', tokens: 9510, cachePct: 74, time: '5h ago' },
  { title: 'Refactor auth middleware', model: 'Llama 3.1 8B', tokens: 15320, cachePct: 62, time: '2h ago' },
  { title: 'Explain CRDTs', model: 'Qwen 2.5 14B', tokens: 7180, cachePct: 55, time: '1d ago' },
  { title: 'Daily standup summary', model: 'Phi 3 Mini', tokens: 2220, cachePct: 82, time: '6h ago' },
  { title: 'Debug WebSocket reconnect', model: 'Llama 3.1 8B', tokens: 5680, cachePct: 68, time: '1d ago' },
  { title: 'K8s manifest generator', model: 'Qwen 2.5 14B', tokens: 5520, cachePct: 60, time: '2d ago' },
]

export const RANGES = ['session', 'today', 'week', 'month', 'year'] as const
