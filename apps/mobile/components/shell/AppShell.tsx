import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { Keyboard } from 'react-native';
import { usePathname, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { Pressable } from '@/components/ui/pressable';
import { Sidebar } from './Sidebar';
import { UpdateReadyBanner } from './UpdateReadyBanner';
import { ConnectionBanner } from './ConnectionBanner';
import { startMonitor } from '@/lib/connectionMonitor';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import type { SurfaceId } from '@/lib/types';

interface ShellState {
  /** True when the sidebar is a slide-over (medium/narrow layouts). */
  overlaySidebar: boolean;
  openSidebar: () => void;
  openSettings: () => void;
  settingsOpen: boolean;
  closeSettings: () => void;
}

const ShellContext = createContext<ShellState | null>(null);

export function useShell(): ShellState {
  const ctx = useContext(ShellContext);
  if (!ctx) throw new Error('useShell must be used within AppShell');
  return ctx;
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const breakpoint = useBreakpoint();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const pathname = usePathname();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // One connection monitor for the signed-in app, whichever screen is open —
  // screens come and go with the Slot, and their sockets with them.
  useEffect(() => startMonitor(), []);

  const overlaySidebar = breakpoint !== 'wide';
  // The first segment, not the whole path: a routine's chat lives at
  // `/routines/<id>`, and matching on the full path would leave the sidebar
  // with nothing highlighted the moment you opened one.
  const activeSurface = (pathname.split('/')[1] || 'chat') as SurfaceId;

  const navigate = useCallback(
    (surface: SurfaceId) => {
      setSidebarOpen(false);
      router.push(`/${surface}` as never);
    },
    [router],
  );

  const shell = useMemo<ShellState>(
    () => ({
      overlaySidebar,
      openSidebar: () => {
        // With a composer focused, the software keyboard would otherwise sit
        // on top of the slide-over and hide the drawer's footer (sign-out).
        Keyboard.dismiss();
        setSidebarOpen(true);
      },
      openSettings: () => { setSettingsOpen(true); },
      settingsOpen,
      closeSettings: () => { setSettingsOpen(false); },
    }),
    [overlaySidebar, settingsOpen],
  );

  const sidebar = (
    <Sidebar
      activeSurface={activeSurface}
      onNavigate={navigate}
      onOpenSettings={() => {
        setSidebarOpen(false);
        setSettingsOpen(true);
      }}
      onNewChat={() => { navigate('chat'); }}
    />
  );

  return (
    <ShellContext.Provider value={shell}>
      {/* Inset the whole shell below the status bar / above the home indicator.
          Web reports zero insets, so this is a no-op there. */}
      <Box
        className="flex-1 bg-background"
        style={{
          paddingTop: insets.top,
          paddingBottom: insets.bottom,
          paddingLeft: insets.left,
          paddingRight: insets.right,
        }}
      >
        {/* Above everything, the sidebar included: whether the server can be
            reached is a fact about the whole app. */}
        <ConnectionBanner />
        <HStack className="h-full flex-1 bg-background">
          {!overlaySidebar && sidebar}
          <Box className="h-full flex-1">
            {/* One banner for the whole shell: an update being ready is a fact
                about the app, not about the screen someone is on. */}
            <UpdateReadyBanner />
            <Box className="flex-1">{children}</Box>
          </Box>

          {overlaySidebar && sidebarOpen && (
            <>
              <Pressable
                testID="shell.sidebarScrim"
                onPress={() => { setSidebarOpen(false); }}
                className="absolute inset-0 bg-black/40"
              />
              <Box className="absolute bottom-0 left-0 top-0 shadow-lg">{sidebar}</Box>
            </>
          )}
        </HStack>
      </Box>
    </ShellContext.Provider>
  );
}
