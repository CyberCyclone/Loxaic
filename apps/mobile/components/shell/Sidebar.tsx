import { MessageSquare, Bot, Clock, BarChart3, Plug, Settings, Plus, LogOut, ShieldCheck } from 'lucide-react-native';
import { useRouter } from 'expo-router';
import { Box } from '@/components/ui/box';
import { VStack } from '@/components/ui/vstack';
import { HStack } from '@/components/ui/hstack';
import { Text } from '@/components/ui/text';
import { Button, ButtonText, ButtonIcon } from '@/components/ui/button';
import { Pressable } from '@/components/ui/pressable';
import { Icon } from '@/components/ui/icon';
import type { SurfaceId } from '@/lib/types';
import { useSettings } from '@/hooks/useSettings';
import { useInstanceState } from '@/hooks/useInstanceState';
import { useSession } from '@/lib/session';
import { disconnectedCopy, useSettledConnection } from '@/lib/connection';
import { hostOf } from '@/lib/serverHost';
import { useServerEndpoint } from '@/hooks/useServerEndpoint';

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
  { id: 'mcp', label: 'MCP Servers', icon: Plug },
  { id: 'stats', label: 'Stats', icon: BarChart3 },
];

/** Shown only to admins. Appended rather than filtered out of NAV_ITEMS so a
 * non-admin's sidebar is identical to what it was before this existed — the
 * screen itself and every route behind it are guarded regardless. */
const ADMIN_NAV: { id: SurfaceId; label: string; icon: typeof MessageSquare } = {
  id: 'admin',
  label: 'Admin',
  icon: ShieldCheck,
};

function NavItem({
  label,
  icon,
  active,
  onPress,
  testID,
}: {
  label: string;
  icon: typeof MessageSquare;
  active?: boolean;
  onPress: () => void;
  testID?: string;
}) {
  return (
    <Pressable
      testID={testID}
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
  const instance = useInstanceState();
  // Where this app is actually talking to, by host name. On the desktop the
  // instance's advertised address says more than the loopback URL the
  // renderer uses; everywhere else it is the endpoint the sockets and
  // requests really resolved to. This used to read only a *typed* endpoint,
  // so a phone on its build's default server said "local server".
  const instanceUrl = instance?.mode === 'client' ? instance.client?.hostUrl : instance?.effectiveAdvertiseUrl;
  const endpoint = useServerEndpoint();
  const serverHost = hostOf(instanceUrl) ?? hostOf(endpoint) ?? 'local server';
  // Settled, so an app switch's silent reconnect does not flicker it.
  const connection = useSettledConnection();
  const statusDot =
    connection === 'online' ? 'bg-success' : connection === 'reconnecting' ? 'bg-warning' : 'bg-destructive';
  const { signOut, isAdmin } = useSession();
  const router = useRouter();
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
            L
          </Text>
        </Box>
        <Text className="font-semibold text-foreground">Loxaic</Text>
      </HStack>

      <Box className="px-3 pb-2">
        <Button
          testID="sidebar.newChat"
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
            testID={`sidebar.nav.${item.id}`}
            label={item.label}
            icon={item.icon}
            active={activeSurface === item.id}
            onPress={() => { onNavigate(item.id); }}
          />
        ))}
        {isAdmin && (
          <NavItem
            testID={`sidebar.nav.${ADMIN_NAV.id}`}
            label={ADMIN_NAV.label}
            icon={ADMIN_NAV.icon}
            active={activeSurface === ADMIN_NAV.id}
            onPress={() => { onNavigate(ADMIN_NAV.id); }}
          />
        )}
        <NavItem testID="sidebar.settings" label="Settings" icon={Settings} onPress={onOpenSettings} />
      </VStack>

      <VStack space="sm" className="border-t border-border px-4 py-3">
        <HStack space="xs" className="items-center">
          <Box className={`h-2 w-2 rounded-full ${statusDot}`} />
          <Text testID="sidebar.serverStatus" size="xs" className="text-muted-foreground">
            {disconnectedCopy(connection).status}
          </Text>
        </HStack>
        <HStack space="sm" className="items-center justify-between">
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
              <Text testID="sidebar.serverHost" size="xs" className="text-muted-foreground">
                {serverHost}
              </Text>
            </VStack>
          </HStack>
          <Pressable
            testID="sidebar.signOut"
            onPress={() => {
              void signOut().then(() => { router.replace('/login'); });
            }}
            className="rounded-sm p-1.5 web:hover:bg-muted/50"
          >
            <Icon as={LogOut} size="sm" className="text-muted-foreground" />
          </Pressable>
        </HStack>
      </VStack>
    </VStack>
  );
}
