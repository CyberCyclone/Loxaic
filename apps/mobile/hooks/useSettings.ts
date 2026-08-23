import { useStoredState } from './useStoredState';
import type { Settings, SmartRouting, ThinkingLevel } from '@/lib/types';

const DEFAULT_SETTINGS: Settings = {
  name: '',
  defaultMode: 'manual',
  defaultThinkingLevel: 'Medium',
  tailscale: '',
  endpoint: '',
};

const DEFAULT_ROUTING: SmartRouting = {
  profile: 'server',
  planning: 'm1',
  heavyThinking: 'm2',
  simpleJobs: 'm3',
};

export function useSettings() {
  return useStoredState<Settings>('shannon-settings', DEFAULT_SETTINGS);
}

export function useSmartRouting() {
  return useStoredState<SmartRouting>('shannon-smart-routing', DEFAULT_ROUTING);
}

export function useThinkingLevels() {
  return useStoredState<Record<string, ThinkingLevel>>('shannon-thinking-levels', {});
}
