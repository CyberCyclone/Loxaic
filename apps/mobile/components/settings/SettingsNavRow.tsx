import type { LucideIcon } from 'lucide-react-native';
import { ChevronRight } from 'lucide-react-native';
import { HStack } from '@/components/ui/hstack';
import { VStack } from '@/components/ui/vstack';
import { Text } from '@/components/ui/text';
import { Pressable } from '@/components/ui/pressable';
import { Icon } from '@/components/ui/icon';
import { TRUNCATE_TEXT } from '@/lib/truncate';

/**
 * One row of the Settings modal that opens a settings screen. `min-w-0` and
 * `shrink` on the row and the label column, with the subtitle truncated: React
 * Native defaults every view to `flexShrink: 0`, so a long subtitle otherwise
 * pushes the chevron off the card on a phone.
 */
export function SettingsNavRow({
  testID,
  icon,
  title,
  subtitle,
  onPress,
}: {
  testID: string;
  icon: LucideIcon;
  title: string;
  subtitle: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      className="flex-row items-center justify-between rounded-md border border-border bg-card px-3 py-2.5 web:hover:bg-muted/30"
    >
      <HStack space="sm" className="min-w-0 shrink items-center">
        <Icon as={icon} size="sm" className="shrink-0 text-muted-foreground" />
        <VStack className="min-w-0 shrink">
          <Text size="sm" className="text-foreground">
            {title}
          </Text>
          <Text size="2xs" className="text-muted-foreground" numberOfLines={1} style={TRUNCATE_TEXT}>
            {subtitle}
          </Text>
        </VStack>
      </HStack>
      <Icon as={ChevronRight} size="sm" className="shrink-0 text-muted-foreground" />
    </Pressable>
  );
}
