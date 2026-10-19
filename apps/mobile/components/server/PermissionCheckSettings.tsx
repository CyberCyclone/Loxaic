import { HStack } from '@/components/ui/hstack';
import { VStack } from '@/components/ui/vstack';
import { Text } from '@/components/ui/text';
import { Pressable } from '@/components/ui/pressable';
import type { InferenceSettings } from '@loxaic/api-client';

const TIMEOUTS: { ms: number; label: string }[] = [
  { ms: 30_000, label: '30 s' },
  { ms: 60_000, label: '1 min' },
  { ms: 90_000, label: '90 s' },
  { ms: 180_000, label: '3 min' },
];

interface PermissionCheckSettingsProps {
  settings: InferenceSettings;
  /** The display name of the configured model, when it is one the list knows. */
  modelName: string | null;
  onUseRunModel: () => void;
  onPickModel: () => void;
  onTimeout: (ms: number) => void;
  unavailable?: boolean;
}

/**
 * Admin: what auto mode's permission check runs on (apps/server/src/
 * permissions/check.ts). The run's own model is the default and the
 * recommendation: its request extends the prompt the backend just cached, so a
 * check costs a few hundred tokens. Another model has none of the
 * conversation, and on a single-GPU llama.cpp host loading it can unload the
 * model the run is using.
 */
export function PermissionCheckSettings({
  settings,
  modelName,
  onUseRunModel,
  onPickModel,
  onTimeout,
  unavailable = false,
}: PermissionCheckSettingsProps) {
  const model = settings.permissionCheckModel ?? null;
  const timeout = settings.permissionCheckTimeoutMs;
  // Set on the server's own command line, so the API refuses a change.
  const timeoutPinned = settings.envOverrides.permissionCheckTimeoutMs === true;
  return (
    <VStack testID="inference.permissionCheck" space="xs" className="border-t border-border pt-4">
      <Text size="xs" className="text-muted-foreground">
        Auto mode permission check
      </Text>
      <Text size="xs" className="text-muted-foreground">
        In auto mode, a command that is not read-only and that no rule covers is checked by a model before it
        runs, wherever the workspace is not sealed off. The run&apos;s own model is the cheapest choice: the check
        reuses the prompt it just read.
      </Text>
      <HStack space="xs" className="flex-wrap items-center">
        <Pressable
          testID="inference.permissionCheck.runModel"
          disabled={unavailable}
          onPress={onUseRunModel}
          className={`rounded-full px-3 py-1.5 ${model === null ? 'bg-primary/15' : 'bg-muted'} ${unavailable ? 'opacity-40' : ''}`}
        >
          <Text size="sm" className={model === null ? 'text-primary' : 'text-muted-foreground'}>
            The run&apos;s own model
          </Text>
        </Pressable>
        <Pressable
          testID="inference.permissionCheck.pick"
          disabled={unavailable}
          onPress={onPickModel}
          className={`rounded-full px-3 py-1.5 ${model !== null ? 'bg-primary/15' : 'bg-muted'} ${unavailable ? 'opacity-40' : ''}`}
        >
          <Text testID="inference.permissionCheck.model" size="sm" className={model !== null ? 'text-primary' : 'text-muted-foreground'}>
            {model === null ? 'Another model…' : (modelName ?? model)}
          </Text>
        </Pressable>
      </HStack>
      {model !== null && (
        <Text size="xs" className="text-warning">
          A different model starts each check from nothing, and on a single-GPU host it may unload the model
          the run is using.
        </Text>
      )}
      {timeout !== undefined && (
        <>
          <Text size="xs" className="text-muted-foreground">
            If the check takes longer than this, the command asks instead.
          </Text>
          {timeoutPinned && (
            <Text testID="inference.permissionCheck.timeoutPinned" size="xs" className="text-muted-foreground">
              Set to {String(Math.round(timeout / 1000))} s by PERMISSION_CHECK_TIMEOUT_MS on the server.
            </Text>
          )}
          <HStack space="xs" className="flex-wrap">
            {TIMEOUTS.map((choice) => {
              const selected = timeout === choice.ms;
              return (
                <Pressable
                  key={choice.ms}
                  testID={`inference.permissionCheck.timeout.${String(choice.ms)}`}
                  disabled={unavailable || timeoutPinned}
                  onPress={() => { onTimeout(choice.ms); }}
                  className={`rounded-full px-3 py-1.5 ${selected ? 'bg-primary/15' : 'bg-muted'} ${unavailable || timeoutPinned ? 'opacity-40' : ''}`}
                >
                  <Text size="sm" className={selected ? 'text-primary' : 'text-muted-foreground'}>
                    {choice.label}
                  </Text>
                </Pressable>
              );
            })}
          </HStack>
        </>
      )}
    </VStack>
  );
}
