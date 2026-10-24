import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react-native';
import type { PromptProgress } from '@loxaic/api-client';
import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { Icon } from '@/components/ui/icon';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { LiveElapsed } from './LiveElapsed';
import { PromptProgressBar } from './PromptProgressBar';

/**
 * The pill a conversation shows for something happening to its context rather
 * than a reply: a context-stage switch (ContextStageCard) and a saved cache
 * going back in (PromptCacheCard). A spinner and elapsed time while `active`,
 * an icon after; a line of detail and the shared progress bar beneath.
 */
export function ContextPill(props: {
  testID: string;
  labelTestID: string;
  detailTestID?: string;
  active: boolean;
  failed: boolean;
  icon: LucideIcon;
  label: ReactNode;
  /** For e2e: which step the label describes. */
  step?: string;
  since: number;
  detail?: string | null;
  progress?: PromptProgress | null;
}) {
  const { active, failed } = props;
  return (
    <Box testID={props.testID} className="my-2 px-4">
      <Box className="mx-auto max-w-[820px] items-center">
        <HStack space="xs" className={`items-center rounded-full border bg-card px-3 py-1.5 ${failed ? 'border-destructive/40' : 'border-border'}`}>
          {active ? (
            <Spinner size="small" className="text-muted-foreground" />
          ) : (
            <Icon as={props.icon} size="2xs" className={failed ? 'text-destructive' : 'text-muted-foreground'} />
          )}
          <Text
            testID={props.labelTestID}
            size="xs"
            className={`shrink ${failed ? 'text-destructive' : 'text-muted-foreground'}`}
            data-step={props.step}
          >
            {props.label}
          </Text>
          {active && <LiveElapsed since={props.since} className="text-muted-foreground" />}
        </HStack>
        {props.detail ? (
          <Text testID={props.detailTestID} size="2xs" className="mt-1 text-center text-muted-foreground">
            {props.detail}
          </Text>
        ) : null}
        {props.progress && props.progress.total_tokens > 0 ? (
          <Box className="mt-1 w-full max-w-[420px]">
            <PromptProgressBar stats={{ progress: props.progress }} />
          </Box>
        ) : null}
      </Box>
    </Box>
  );
}
