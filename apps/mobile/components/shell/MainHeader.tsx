import { Menu as MenuIcon } from 'lucide-react-native';
import { HStack } from '@/components/ui/hstack';
import { VStack } from '@/components/ui/vstack';
import { Text } from '@/components/ui/text';
import { Pressable } from '@/components/ui/pressable';
import { Icon } from '@/components/ui/icon';

interface MainHeaderProps {
  title: string;
  subtitle?: string;
  /** Rendered on narrow/medium layouts to open the sidebar slide-over. */
  onOpenMenu?: () => void;
  right?: React.ReactNode;
}

export function MainHeader({ title, subtitle, onOpenMenu, right }: MainHeaderProps) {
  return (
    <HStack className="h-14 items-center justify-between border-b border-border bg-background px-4">
      <HStack space="sm" className="flex-1 items-center">
        {onOpenMenu && (
          <Pressable
            testID="shell.menuButton"
            onPress={onOpenMenu}
            className="rounded-sm p-1.5 web:hover:bg-muted/50"
          >
            <Icon as={MenuIcon} size="md" className="text-foreground" />
          </Pressable>
        )}
        <VStack>
          <Text className="font-semibold text-foreground" numberOfLines={1}>
            {title}
          </Text>
          {subtitle ? (
            <Text size="xs" className="text-muted-foreground" numberOfLines={1}>
              {subtitle}
            </Text>
          ) : null}
        </VStack>
      </HStack>
      {right}
    </HStack>
  );
}
