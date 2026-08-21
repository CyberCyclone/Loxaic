import { useLocalStorage } from './useLocalStorage'
import type { Settings, SmartRouting, ThinkingLevel } from '../types'

const DEFAULT_SETTINGS: Settings = {
  name: 'Casey Gibson',
  defaultMode: 'manual',
  defaultThinkingLevel: 'Medium',
  tailscale: 'shannon.tailscale.com',
  endpoint: 'http://shannon:8080',
}

const DEFAULT_ROUTING: SmartRouting = {
  profile: 'server',
  planning: 'm1',
  heavyThinking: 'm2',
  simpleJobs: 'm3',
}

export function useSettings() {
  return useLocalStorage<Settings>('shannon-settings', DEFAULT_SETTINGS)
}

export function useSmartRouting() {
  return useLocalStorage<SmartRouting>('shannon-smart-routing', DEFAULT_ROUTING)
}

export function useThinkingLevels() {
  return useLocalStorage<Record<string, ThinkingLevel>>('shannon-thinking-levels', {})
}
