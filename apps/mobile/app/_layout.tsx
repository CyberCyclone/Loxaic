import '@/global.css';
import { GluestackUIProvider } from '@/components/ui/gluestack-ui-provider';
import { SafeAreaListener } from 'react-native-safe-area-context';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { Uniwind } from 'uniwind';
import { Slot } from 'expo-router';
import {
  useFonts,
  PublicSans_400Regular,
  PublicSans_500Medium,
  PublicSans_600SemiBold,
  PublicSans_700Bold,
} from '@expo-google-fonts/public-sans';
import { useEffect } from 'react';
import { SessionProvider, useSession } from '@/lib/session';
import { useThemePreference } from '@/hooks/useTheme';
import { useLocalExecutorSync } from '@/hooks/useLocalExecutor';
import { startUpdateChecks } from '@/lib/expo-updates';

function ThemedApp() {
  const [themePref] = useThemePreference();
  const { ready, token } = useSession();
  // Above the auth gate on purpose — see useLocalExecutorSync.
  useLocalExecutorSync(ready ? token : null);
  // Also above the auth gate, and for a related reason: an update that fixes
  // a bug preventing sign-in is exactly the one a signed-out user needs. A
  // no-op everywhere updates don't exist (web, Expo Go, development).
  //
  // Gated on `ready`, which SessionProvider sets after hydrateStorage() has
  // resolved — not on being signed in, so the property above survives. Ungated,
  // this ran before hydration (child effects fire first, and hydration is an
  // await inside the parent's), read an empty cache, and re-applied
  // 'production' over a stored 'beta' at every cold launch.
  useEffect(() => {
    if (!ready) return;
    return startUpdateChecks();
  }, [ready]);
  if (!ready) return null;
  return (
    <GluestackUIProvider mode={themePref}>
      <Slot />
    </GluestackUIProvider>
  );
}

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({
    PublicSans_400Regular,
    PublicSans_500Medium,
    PublicSans_600SemiBold,
    PublicSans_700Bold,
  });
  // Render on error too — system fonts beat a permanently blank app.
  if (!fontsLoaded && !fontError) return null;

  return (
    <SafeAreaListener
      onChange={({ insets }) => {
        Uniwind.updateInsets(insets);
      }}
    >
      <GestureHandlerRootView style={{ flex: 1 }}>
        <SessionProvider>
          <ThemedApp />
        </SessionProvider>
      </GestureHandlerRootView>
    </SafeAreaListener>
  );
}
