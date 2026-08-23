import { MessageSquare, Bot, Clock, BarChart3, Settings, Plus } from 'lucide-react-native';
import { Box } from '@/components/ui/box';
import { VStack } from '@/components/ui/vstack';
import { HStack } from '@/components/ui/hstack';
import { Text } from '@/components/ui/text';
import { Button, ButtonText, ButtonIcon } from '@/components/ui/button';
import { Pressable } from '@/components/ui/pressable';
import { Icon } from '@/components/ui/icon';
import type { SurfaceId } from '@/lib/types';
import { useSettings } from '@/hooks/useSettings';

interface SidebarProps {
  activeSurface: SurfaceId;
  onNavigate: (surface: SurfaceId) => void;
  onOpenSettings: () => void;
  onNewChat: () => void;
}

const NAV_ITEMS: { id: SurfaceId; label: string; icon: typeof MessageSquare }[] = [
  { id: 'chat', label: 'Chat', icon: MessageSquare },
  { id: 'agent', label: 'Agent', icon: Bot },
  { id: 'routines', label: 'Routines', icon: Clock },
  { id: 'stats', label: 'Stats', icon: BarChart3 },
];

function NavItem({
  label,
  icon,
  active,
  onPress,
}: {
  label: string;
  icon: typeof MessageSquare;
  active?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      className={`flex-row items-center gap-2.5 rounded-sm px-3 py-2 ${
        active ? 'bg-muted' : 'web:hover:bg-muted/50'
      }`}
    >
      <Icon
        as={icon}
        size="sm"
        className={active ? 'text-foreground' : 'text-muted-foreground'}
      />
      <Text
        size="sm"
        className={active ? 'font-medium text-foreground' : 'text-secondary-foreground'}
      >
        {label}
      </Text>
    </Pressable>
  );
}

export function Sidebar({ activeSurface, onNavigate, onOpenSettings, onNewChat }: SidebarProps) {
  const [settings] = useSettings();
  const initials =
    settings.name
      .split(' ')
      .map((p) => p[0])
      .filter(Boolean)
      .slice(0, 2)
      .join('')
      .toUpperCase() || '·';

  return (
    <VStack className="h-full w-[260px] border-r border-border bg-background">
      <HStack space="sm" className="items-center px-4 py-4">
        <Box className="h-8 w-8 items-center justify-center rounded-sm bg-primary">
          <Text size="xs" className="font-bold text-primary-foreground">
            OS
          </Text>
        </Box>
        <Text className="font-semibold text-foreground">Open-Shannon</Text>
      </HStack>

      <Box className="px-3 pb-2">
        <Button
          variant="outline"
          size="sm"
          className="justify-start border-border"
          onPress={onNewChat}
        >
          <ButtonIcon as={Plus} className="text-foreground" />
          <ButtonText className="text-foreground">New chat</ButtonText>
        </Button>
      </Box>

      <VStack space="xs" className="flex-1 px-3 pt-2">
        <Text size="xs" className="px-3 pb-1 uppercase tracking-wider text-muted-foreground">
          Workspace
        </Text>
        {NAV_ITEMS.map((item) => (
          <NavItem
            key={item.id}
            label={item.label}
            icon={item.icon}
            active={activeSurface === item.id}
            onPress={() => onNavigate(item.id)}
          />
        ))}
        <NavItem label="Settings" icon={Settings} onPress={onOpenSettings} />
      </VStack>

      <VStack space="sm" className="border-t border-border px-4 py-3">
        <HStack space="xs" className="items-center">
          <Box className="h-2 w-2 rounded-full bg-success" />
          <Text size="xs" className="text-muted-foreground">
            Server connected · llama.cpp
          </Text>
        </HStack>
        <HStack space="sm" className="items-center">
          <Box className="h-8 w-8 items-center justify-center rounded-full bg-muted">
            <Text size="xs" className="font-semibold text-foreground">
              {initials}
            </Text>
          </Box>
          <VStack>
            <Text size="sm" className="font-medium text-foreground">
              {settings.name || 'Signed in'}
            </Text>
            <Text size="xs" className="text-muted-foreground">
              {settings.tailscale || settings.endpoint || 'local server'}
            </Text>
          </VStack>
        </HStack>
      </VStack>
    </VStack>
  );
}
