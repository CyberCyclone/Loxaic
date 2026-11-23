import '@/global.css';
import { GluestackUIProvider } from '@/components/ui/gluestack-ui-provider';
import { SafeAreaListener } from 'react-native-safe-area-context';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { Uniwind } from 'uniwind';
import { Slot } from 'expo-router';
import {
  useFonts,
  InstrumentSans_400Regular,
  InstrumentSans_500Medium,
  InstrumentSans_600SemiBold,
  InstrumentSans_700Bold,
} from '@expo-google-fonts/instrument-sans';
import { JetBrainsMono_400Regular } from '@expo-google-fonts/jetbrains-mono';
import { useEffect } from 'react';
import * as SplashScreen from 'expo-splash-screen';
import { SessionProvider, useSession } from '@/lib/session';
import { useThemePreference } from '@/hooks/useTheme';
import { useLocalExecutorSync } from '@/hooks/useLocalExecutor';
import { startUpdateChecks } from '@/lib/expo-updates';

// Keep the native splash (the mark on the dark background) up until the fonts
// are ready, so the first frame is the app rather than a blank screen.
void SplashScreen.preventAutoHideAsync().catch(() => undefined);

function ThemedApp() {
  const [themePref] = useThemePreference();
  const { ready, token, mustChangePassword } = useSession();
  // Above the auth gate on purpose — see useLocalExecutorSync. Not while a
  // password change is pending: the server refuses that token on every socket
  // until it is done, and the change hands back a new token anyway.
  useLocalExecutorSync(ready && !mustChangePassword ? token : null);
  // Also above the auth gate, and for a related reason: an update that fixes
  // a bug preventing sign-in is exactly the one a signed-out user needs. A
  // no-op everywhere updates don't exist (web, Expo Go, development).
  //
  // No longer gated on `ready`: that gate existed only because this used to
  // read a stored channel preference before hydration had finished. The
  // channel is a property of the build now, so there is nothing to wait for.
  useEffect(() => startUpdateChecks(), []);
  if (!ready) return null;
  return (
    <GluestackUIProvider mode={themePref}>
      <Slot />
    </GluestackUIProvider>
  );
}

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({
    InstrumentSans_400Regular,
    InstrumentSans_500Medium,
    InstrumentSans_600SemiBold,
    InstrumentSans_700Bold,
    JetBrainsMono_400Regular,
  });
  const fontsSettled = fontsLoaded || fontError != null;
  useEffect(() => {
    if (fontsSettled) void SplashScreen.hideAsync().catch(() => undefined);
  }, [fontsSettled]);
  // Render on error too — system fonts beat a permanently blank app.
  if (!fontsSettled) return null;

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
