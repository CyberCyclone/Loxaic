import { useState } from 'react';
import { ChevronRight, Scissors } from 'lucide-react-native';
import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { Text } from '@/components/ui/text';
import { Pressable } from '@/components/ui/pressable';
import { Icon } from '@/components/ui/icon';
import { Spinner } from '@/components/ui/spinner';
import type { CompactionStats } from '@/lib/types';

const fmt = (n: number) => n.toLocaleString();

const SKIP_COPY: Record<NonNullable<CompactionStats['skipped']>, string> = {
  already_compacted: 'Already compacted — nothing new since the last compaction.',
  too_short: 'Not enough conversation to compact yet.',
};

interface CompactionCardProps {
  /** Undefined until the run's `compaction` event lands — the card renders
   * as "Compacting…" with the growing summary text visible, same idiom as
   * ThinkingBlock's live state. */
  stats?: CompactionStats;
  /** The summary itself. Empty for a skipped (no-op) compaction. */
  summaryText?: string;
}

/**
 * Renders in place of the normal message bubble for `role: 'summary'` — this
 * is the one visible seam of compaction. Everything above it in the thread
 * is untouched and still on screen; this card just marks where prompt
 * assembly now starts.
 */
export function CompactionCard({ stats, summaryText }: CompactionCardProps) {
  const [open, setOpen] = useState(false);
  const live = !stats;

  if (stats?.skipped) {
    return (
      <Box className="my-2 items-center px-4">
        <Text size="xs" className="text-muted-foreground">
          {SKIP_COPY[stats.skipped]}
        </Text>
      </Box>
    );
  }

  return (
    <Box className="my-2 px-4">
      <Pressable
        onPress={() => {
          if (!live) setOpen((o) => !o);
        }}
        className="mx-auto max-w-[820px] items-center"
      >
        <HStack space="xs" className="items-center rounded-full border border-border bg-card px-3 py-1.5">
          {live ? (
            <>
              <Spinner size="small" className="text-muted-foreground" />
              <Text size="xs" className="text-muted-foreground">
                Compacting…
              </Text>
            </>
          ) : (
            <>
              <Icon as={Scissors} size="2xs" className="text-muted-foreground" />
              <Text size="xs" className="text-muted-foreground">
                {`${stats.auto ? 'Auto-compacted' : 'Compacted'} · ${String(stats.messages_compacted)} message${stats.messages_compacted === 1 ? '' : 's'} → summary · `}
                {stats.before_estimated ? '~' : ''}
                {fmt(stats.before_tokens)} → {fmt(stats.after_tokens)} tokens · saved{' '}
                {stats.before_estimated ? '~' : ''}
                {fmt(stats.saved_tokens)}
              </Text>
              <Icon
                as={ChevronRight}
                size="2xs"
                className="text-muted-foreground"
                style={{ transform: [{ rotate: open ? '90deg' : '0deg' }] }}
              />
            </>
          )}
        </HStack>
      </Pressable>

      {stats?.auto && !stats.skipped && (
        // A summary nobody asked for, appearing mid-conversation, needs to say
        // why it is there — otherwise it reads as the app having lost the
        // thread rather than deliberately condensing it.
        <Text size="2xs" className="mt-1 text-center text-muted-foreground">
          The conversation reached the model's context limit — earlier messages are now summarised.
        </Text>
      )}

      {stats?.guidance && (
        <Text size="2xs" className="mt-1 text-center text-muted-foreground">
          Focused: {stats.guidance}
        </Text>
      )}

      {(live || open) && !!summaryText && (
        <Box className="mx-auto mt-1.5 max-w-[820px] rounded-md border border-border bg-card p-3">
          <Text size="xs" className="text-muted-foreground">
            {summaryText}
          </Text>
        </Box>
      )}
    </Box>
  );
}
