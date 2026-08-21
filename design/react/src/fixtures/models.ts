import type { ModelInfo, Workspace } from '../types'

export const SHANNON_MODELS: ModelInfo[] = [
  { id: 'm1', display_name: 'Llama 3.1 8B', quant: 'Q4_K_M', context_tokens: 32768, location: 'server', price: 0 },
  { id: 'm2', display_name: 'Qwen 2.5 14B', quant: 'Q5_K_M', context_tokens: 32768, location: 'server', price: 0 },
  { id: 'm3', display_name: 'Phi 3 Mini', quant: 'Q8_0', context_tokens: 4096, location: 'device', price: 0 },
  { id: 'm4', display_name: 'Gemma 2 2B', quant: 'Q4_K_M', context_tokens: 8192, location: 'device', price: 0 },
  { id: 'r1', display_name: 'GPT-4o', quant: '—', context_tokens: 128000, location: 'remote', price: 2.50 },
  { id: 'r2', display_name: 'Mistral Large', quant: '—', context_tokens: 128000, location: 'remote', price: 2.00 },
  { id: 'r3', display_name: 'DeepSeek V3', quant: '—', context_tokens: 64000, location: 'remote', price: 0.27 },
]

export const SHANNON_WORKSPACES: Workspace[] = [
  { name: 'Open-Shannon/design', path: '/home/casey/projects/open-shannon/design' },
  { name: 'Open-Shannon/api', path: '/home/casey/projects/open-shannon/api' },
  { name: 'Open-Shannon/sync', path: '/home/casey/projects/open-shannon/sync' },
]

export const THINKING_LEVELS = ['None', 'Low', 'Medium', 'High'] as const

export function getModelName(id: string): string {
  return SHANNON_MODELS.find(m => m.id === id)?.display_name ?? id
}

export function getModelContext(id: string): number {
  return SHANNON_MODELS.find(m => m.id === id)?.context_tokens ?? 32768
}

export function getModelPrice(id: string): number {
  return SHANNON_MODELS.find(m => m.id === id)?.price ?? 0
}
