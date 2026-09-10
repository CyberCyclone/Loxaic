import { useStoredState } from './useStoredState';
import type { Settings, SmartRouting, ThinkingLevel } from '@/lib/types';

const DEFAULT_SETTINGS: Settings = {
  name: '',
  defaultMode: 'manual',
  defaultThinkingLevel: 'Medium',
  endpoint: '',
};

const DEFAULT_ROUTING: SmartRouting = {
  profile: 'server',
  planning: 'm1',
  heavyThinking: 'm2',
  simpleJobs: 'm3',
};

export function useSettings() {
  return useStoredState<Settings>('loxaic-settings', DEFAULT_SETTINGS);
}

export function useSmartRouting() {
  return useStoredState<SmartRouting>('loxaic-smart-routing', DEFAULT_ROUTING);
}

export function useThinkingLevels() {
  return useStoredState<Record<string, ThinkingLevel>>('loxaic-thinking-levels', {});
}
