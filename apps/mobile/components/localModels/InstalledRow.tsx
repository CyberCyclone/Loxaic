import { useEffect, useRef, useState } from 'react';
import { Pause, Play, SlidersHorizontal, Trash2, X, Eye, CircleAlert } from 'lucide-react-native';
import type { LocalModel } from '@loxaic/api-client';
import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { VStack } from '@/components/ui/vstack';
import { Text } from '@/components/ui/text';
import { Pressable } from '@/components/ui/pressable';
import { Icon } from '@/components/ui/icon';
import { Switch } from '@/components/ui/switch';
import { FitBadge } from './FitBadge';
import { etaSeconds, formatBytes, formatEta, progressPercent } from '@/lib/localModels';
import { useServerReachable } from '@/lib/connection';
import { TRUNCATE_TEXT } from '@/lib/truncate';

interface InstalledRowProps {
  model: LocalModel;
  onToggle: (enabled: boolean) => void;
  onPause: () => void;
  onResume: () => void;
  onCancel: () => void;
  onDelete: () => void;
  onSettings: () => void;
}

const STATUS_TEXT: Record<LocalModel['status'], string> = {
  queued: 'Waiting to download',
  downloading: 'Downloading',
  paused: 'Paused',
  failed: 'Download failed',
  ready: 'Downloaded',
};

/**
 * One downloaded or downloading model. In progress: bytes, time left, pause
 * or resume, cancel. Finished: the "enable for everyone" switch, its settings
 * and delete — enabling is what puts it in every user's picker.
 */
export function InstalledRow({ model, onToggle, onPause, onResume, onCancel, onDelete, onSettings }: InstalledRowProps) {
  const inProgress = model.status !== 'ready';
  const pct = progressPercent(model);
  // Two samples of the byte count, a poll apart, are what the ETA is made of.
  const sample = useRef<{ at: number; bytes: number } | null>(null);
  const [eta, setEta] = useState<number | null>(null);
  useEffect(() => {
    if (model.status !== 'downloading') {
      sample.current = null;
      setEta(null);
      return;
    }
    const now = { at: Date.now(), bytes: model.bytesDone };
    setEta(etaSeconds(sample.current, now, model.sizeBytes));
    sample.current = now;
  }, [model.bytesDone, model.status, model.sizeBytes]);

  const loaded = model.runtimeStatus === 'loaded';
  const reachable = useServerReachable();

  return (
    <Box testID={`localModels.row.${model.id}`} className="rounded-md border border-border bg-card p-3">
      <HStack className="items-start justify-between">
        <VStack className="min-w-0 flex-1 shrink pr-2">
          <Text className="font-medium text-foreground" numberOfLines={1} style={TRUNCATE_TEXT}>
            {model.displayName}
          </Text>
          <Text size="xs" className="text-muted-foreground" numberOfLines={1} style={TRUNCATE_TEXT}>
            {model.publisher} · {model.quant} · {formatBytes(model.sizeBytes)}
          </Text>
        </VStack>
        {!inProgress && (
          <Switch
            testID={`localModels.toggle.${model.id}`}
            value={model.enabled}
            disabled={!reachable}
            onValueChange={onToggle}
            accessibilityLabel="Enable for everyone"
          />
        )}
      </HStack>

      <HStack space="xs" className="mt-2 flex-wrap items-center">
        <FitBadge label={model.fit.label} testID={`localModels.fit.${model.id}`} />
        {model.hasVision && (
          <HStack space="xs" className="items-center rounded-full bg-muted px-2 py-0.5">
            <Icon as={Eye} size="2xs" className="text-muted-foreground" />
            <Text size="2xs" className="text-muted-foreground">
              vision
            </Text>
          </HStack>
        )}
        {!inProgress && (
          <Text testID={`localModels.status.${model.id}`} size="2xs" className="rounded-full bg-muted px-2 py-0.5 text-muted-foreground">
            {model.enabled ? (loaded ? 'In everyone’s picker · loaded' : 'In everyone’s picker') : 'Not offered to users'}
          </Text>
        )}
      </HStack>

      {inProgress && (
        <VStack space="xs" className="mt-2">
          <HStack className="items-center justify-between">
            <Text testID={`localModels.status.${model.id}`} size="xs" className="text-muted-foreground">
              {STATUS_TEXT[model.status]}
              {model.status !== 'failed' ? ` · ${String(pct)}%` : ''}
            </Text>
            <Text size="xs" className="text-muted-foreground">
              {formatBytes(model.bytesDone)} of {formatBytes(model.sizeBytes)}
              {formatEta(eta) ? ` · ${formatEta(eta) ?? ''}` : ''}
            </Text>
          </HStack>
          <Box className="h-1.5 overflow-hidden rounded-full bg-muted">
            <Box testID={`localModels.progress.${model.id}`} className="h-full rounded-full bg-primary" style={{ width: (String(pct) + "%") as `${number}%` }} />
          </Box>
        </VStack>
      )}

      {model.error && (
        <HStack space="xs" className="mt-2 items-start">
          <Icon as={CircleAlert} size="xs" className="mt-0.5 text-destructive" />
          <Text testID={`localModels.error.${model.id}`} size="xs" className="min-w-0 flex-1 text-destructive">
            {model.error}
          </Text>
        </HStack>
      )}
      {model.loadFailed && (
        <Text size="xs" className="mt-2 text-destructive">
          llama.cpp could not load this model with its current settings. Try a shorter context or fewer GPU layers.
        </Text>
      )}

      {/* Every action here is a request; Settings opens a sheet that says for
          itself why it cannot save. */}
      <HStack space="md" className="mt-3 items-center justify-end border-t border-border pt-2">
        {model.status === 'downloading' || model.status === 'queued' ? (
          <Pressable testID={`localModels.pause.${model.id}`} disabled={!reachable} onPress={onPause} className="flex-row items-center gap-1 p-1">
            <Icon as={Pause} size="xs" className="text-muted-foreground" />
            <Text size="xs" className="text-muted-foreground">
              Pause
            </Text>
          </Pressable>
        ) : null}
        {model.status === 'paused' || model.status === 'failed' ? (
          <Pressable testID={`localModels.resume.${model.id}`} disabled={!reachable} onPress={onResume} className="flex-row items-center gap-1 p-1">
            <Icon as={Play} size="xs" className="text-muted-foreground" />
            <Text size="xs" className="text-muted-foreground">
              {model.status === 'failed' ? 'Retry' : 'Resume'}
            </Text>
          </Pressable>
        ) : null}
        {inProgress ? (
          <Pressable testID={`localModels.cancel.${model.id}`} disabled={!reachable} onPress={onCancel} className="flex-row items-center gap-1 p-1">
            <Icon as={X} size="xs" className="text-destructive" />
            <Text size="xs" className="text-destructive">
              Cancel
            </Text>
          </Pressable>
        ) : (
          <>
            <Pressable testID={`localModels.settings.${model.id}`} onPress={onSettings} className="flex-row items-center gap-1 p-1">
              <Icon as={SlidersHorizontal} size="xs" className="text-muted-foreground" />
              <Text size="xs" className="text-muted-foreground">
                Settings
              </Text>
            </Pressable>
            <Pressable testID={`localModels.delete.${model.id}`} disabled={!reachable} onPress={onDelete} className="p-1">
              <Icon as={Trash2} size="xs" className="text-destructive" />
            </Pressable>
          </>
        )}
      </HStack>
    </Box>
  );
}
