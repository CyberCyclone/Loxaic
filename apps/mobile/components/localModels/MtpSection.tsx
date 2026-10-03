import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { VStack } from '@/components/ui/vstack';
import { Text } from '@/components/ui/text';
import { Button, ButtonText } from '@/components/ui/button';
import { PresetChips } from '@/components/settings/PresetChips';
import { mtpCanTurnOn, type MtpPanel } from '@/lib/mtp';

interface MtpSectionProps {
  panel: MtpPanel;
  /** The draft's `mtp`. */
  on: boolean;
  onToggle: (on: boolean) => void;
  onDownloadHead: (path: string) => void;
  onRemoveHead: () => void;
  /** Ask the repository for its heads again, after it could not be asked. */
  onRetryHeads: () => void;
  /** The server can be asked (the connection monitor). */
  reachable: boolean;
  help: string;
}

/**
 * Multi-token prediction for one model: the switch, and where its head comes
 * from — the model's own file, a separate head downloading or ready, one that
 * was refused, or the repository's heads to choose from. What each state says
 * is decided in lib/mtp.ts; this only lays it out.
 *
 * Head downloads and removal are immediate actions, not part of the draft:
 * they change files on the server, which Save and Reset do not undo.
 */
export function MtpSection({ panel, on, onToggle, onDownloadHead, onRemoveHead, onRetryHeads, reachable, help }: MtpSectionProps) {
  const canTurnOn = mtpCanTurnOn(panel);
  // Until the repository has answered there is nothing to switch on: the
  // group says what it is waiting for, and no more.
  if ((panel.kind === 'checking' || panel.kind === 'unreachable') && !on) {
    return <HeadState panel={panel} on={on} onDownloadHead={onDownloadHead} onRemoveHead={onRemoveHead} onRetryHeads={onRetryHeads} reachable={reachable} />;
  }
  return (
    // The group's own title ("Multi-token prediction") labels the switch.
    <VStack space="sm">
      <PresetChips
        chips={[
          { value: false, label: 'Off', key: 'off' },
          { value: true, label: 'On', key: 'on' },
        ]}
        value={on}
        disabled={!canTurnOn && !on}
        onChoose={(v) => { if (v !== on && (!v || canTurnOn)) onToggle(v); }}
        testIDPrefix="localModels.setting.mtp"
      />
      <Text size="2xs" className="text-muted-foreground">
        {help}
      </Text>
      <HeadState panel={panel} on={on} onDownloadHead={onDownloadHead} onRemoveHead={onRemoveHead} onRetryHeads={onRetryHeads} reachable={reachable} />
    </VStack>
  );
}

function HeadState({
  panel,
  on,
  onDownloadHead,
  onRemoveHead,
  onRetryHeads,
  reachable,
}: Pick<MtpSectionProps, 'panel' | 'on' | 'onDownloadHead' | 'onRemoveHead' | 'onRetryHeads' | 'reachable'>) {
  switch (panel.kind) {
    case 'checking':
      return (
        <Text testID="localModels.mtp.checking" size="xs" className="text-muted-foreground">
          Checking this model's repository for an MTP head…
        </Text>
      );
    case 'unreachable':
      return (
        <HStack space="sm" className="items-center rounded-md bg-muted/50 p-2">
          <Text testID="localModels.mtp.unreachable" size="xs" className="min-w-0 flex-1 text-muted-foreground">
            Couldn't check this model's repository for an MTP head: HuggingFace didn't answer.
          </Text>
          <Button testID="localModels.mtp.retry" size="sm" variant="outline" isDisabled={!reachable} onPress={onRetryHeads}>
            <ButtonText>Retry</ButtonText>
          </Button>
        </HStack>
      );
    case 'embedded':
      return (
        <Text testID="localModels.mtp.source" size="xs" className="text-muted-foreground">
          This model carries its own MTP head — nothing else to download.
        </Text>
      );
    case 'head-ready':
      return (
        <HStack space="sm" className="items-center rounded-md bg-muted/50 p-2">
          <Text testID="localModels.mtp.head.status" size="xs" className="min-w-0 flex-1 text-muted-foreground">
            Drafts with {panel.name} ({panel.size}).
          </Text>
          <Button testID="localModels.mtp.head.remove" size="sm" variant="outline" isDisabled={!reachable} onPress={onRemoveHead}>
            <ButtonText>Remove</ButtonText>
          </Button>
        </HStack>
      );
    case 'head-downloading':
      return (
        <VStack space="xs" className="rounded-md bg-muted/50 p-2">
          <HStack space="sm" className="items-center">
            <Text testID="localModels.mtp.head.status" size="xs" className="min-w-0 flex-1 text-muted-foreground">
              {panel.queued ? `Waiting to download ${panel.name}` : `Downloading ${panel.name} · ${String(panel.percent)}%`}
              {on ? '. MTP starts once it is here.' : '. The model stays usable meanwhile.'}
            </Text>
            <Button testID="localModels.mtp.head.remove" size="sm" variant="outline" isDisabled={!reachable} onPress={onRemoveHead}>
              <ButtonText>Cancel</ButtonText>
            </Button>
          </HStack>
          <Box className="h-1.5 overflow-hidden rounded-full bg-muted">
            <Box className="h-full bg-primary" style={{ width: (String(panel.percent) + '%') as `${number}%` }} />
          </Box>
        </VStack>
      );
    case 'head-failed':
      return (
        <HStack space="sm" className="items-center rounded-md bg-destructive/10 p-2">
          <Text testID="localModels.mtp.head.status" size="xs" className="min-w-0 flex-1 text-destructive">
            Not used: {panel.error}
          </Text>
          <Button testID="localModels.mtp.head.remove" size="sm" variant="outline" isDisabled={!reachable} onPress={onRemoveHead}>
            <ButtonText>Choose another</ButtonText>
          </Button>
        </HStack>
      );
    case 'choose':
      return (
        <VStack space="xs">
          <Text size="xs" className="text-muted-foreground">
            This model has no MTP head of its own. Its repository publishes these — download one to turn MTP on. The
            model stays usable while it downloads.
          </Text>
          {panel.heads.map((h, i) => (
            <HStack key={h.path} space="sm" className="items-center rounded-md bg-muted/50 p-2">
              <VStack className="min-w-0 flex-1">
                <Text size="xs" className="text-foreground" numberOfLines={1}>
                  {h.name}
                </Text>
                <Text size="2xs" className="text-muted-foreground">
                  {h.disabledReason ?? h.size}
                </Text>
              </VStack>
              <Button
                testID={`localModels.mtp.head.${String(i)}.download`}
                size="sm"
                variant="outline"
                isDisabled={!reachable || h.disabledReason !== null}
                onPress={() => { onDownloadHead(h.path); }}
              >
                <ButtonText>Download</ButtonText>
              </Button>
            </HStack>
          ))}
        </VStack>
      );
    default:
      return null;
  }
}
