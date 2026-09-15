import { useCallback, useRef, useState } from 'react';
import { Redirect, useRouter } from 'expo-router';
import { KeyboardAvoidingView, Platform, ScrollView } from 'react-native';
import { Eye, EyeOff } from 'lucide-react-native';
import { Box } from '@/components/ui/box';
import { VStack } from '@/components/ui/vstack';
import { HStack } from '@/components/ui/hstack';
import { Heading } from '@/components/ui/heading';
import { Text } from '@/components/ui/text';
import { Input, InputField, InputSlot, InputIcon } from '@/components/ui/input';
import { Button, ButtonText, ButtonSpinner } from '@/components/ui/button';
import { Pressable } from '@/components/ui/pressable';
import { useSession } from '@/lib/session';
import { TailnetStatusCard } from '@/components/settings/TailnetStatusCard';
import { currentEndpoint } from '@/lib/endpoint';
import { ServerPicker, serverPickerKind } from '@/components/auth/ServerPicker';
import { tailnetHint } from '@/lib/server-address';

export default function LoginScreen() {
  const { token, needsOnboarding, signIn, signUp } = useSession();
  const router = useRouter();
  const [mode, setMode] = useState<'sign-in' | 'sign-up'>('sign-in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [serverOpen, setServerOpen] = useState(false);
  const scrollRef = useRef<ScrollView>(null);
  // Stable, so the picker's effect fires on a new result rather than on every
  // render of this screen, which would yank the view down while typing.
  const revealServerResult = useCallback(() => {
    scrollRef.current?.scrollToEnd({ animated: true });
  }, []);

  if (needsOnboarding) return <Redirect href="/onboarding" />;
  if (token) return <Redirect href="/" />;

  const submit = async () => {
    if (!email.trim() || !password) return;
    setBusy(true);
    setError(null);
    try {
      if (mode === 'sign-in') {
        await signIn(email.trim(), password);
      } else {
        await signUp(email.trim(), password, name.trim() || undefined);
      }
      router.replace('/');
    } catch (err) {
      // A request that never reached a server is a different problem from a
      // rejected password, and the fix is on a different control. Opening the
      // server field here is the whole point: on a fresh install there is no
      // other route to it, and "check your server connection" is useless
      // advice when nothing on screen lets you act on it.
      const unreachable = isUnreachable(err);
      // Only where there is something below to check. In a browser there is
      // no picker (the page came from the server it signs in to), and a
      // sentence pointing at a control that renders nothing is the failure
      // this screen was changed to fix, turned the other way round.
      const picker = serverPickerKind();
      if (unreachable && picker === 'form') setServerOpen(true);
      const endpoint = currentEndpoint();
      // A tailnet address fails like a wrong one when Tailscale is simply off
      // on this device, and turning it on is the fix, not the address below.
      // Not in a browser: there the endpoint is the page's own origin, so a
      // Funnel- or Serve-hosted page just proved it reachable from here.
      const hint = picker === 'none' ? null : tailnetHint(endpoint);
      setError(
        unreachable
          ? `Could not reach ${endpoint ?? 'a server'}.${hint ? ` ${hint}` : ''}${
              picker === 'form'
                ? ' Check the address below.'
                : picker === 'reconfigure'
                  ? ' Use "Connect to a different server" below.'
                  : ' Check that the server is running and reachable from here.'
            }`
          : mode === 'sign-in'
            ? 'Sign in failed. Check your email and password.'
            : 'Sign up failed. The email may already be registered.',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      // 'height' on Android, unlike onboarding's `undefined`, deliberately:
      // under edge-to-edge (SDK 57) adjustResize no longer shrinks the window,
      // so with `undefined` the keyboard sat over the open server form — tested
      // on an API 36 emulator, the field did not move at all. Onboarding is
      // desktop-only, which is why it never showed there.
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      {/* A ScrollView, not a centred Box: with the server form open the column
          is taller than the space the keyboard leaves, and a Box can only let
          the keyboard cover it. Centred while it fits, scrolls once it does
          not — the same shape as onboarding. */}
      <ScrollView
        ref={scrollRef}
        style={{ flex: 1, minHeight: 0 }}
        className="bg-background"
        contentContainerStyle={{
          flexGrow: 1,
          alignItems: 'center',
          justifyContent: 'center',
          paddingHorizontal: 24,
          paddingVertical: 32,
        }}
        keyboardShouldPersistTaps="handled"
      >
        <VStack space="xl" className="w-full max-w-[380px]">
          <VStack space="xs" className="items-center">
            <Box className="h-12 w-12 items-center justify-center rounded-md bg-primary">
              <Text className="text-lg font-bold text-primary-foreground">L</Text>
            </Box>
            <Heading size="xl" className="text-foreground">
              Loxaic
            </Heading>
            <Text size="sm" className="text-muted-foreground">
              {mode === 'sign-in'
                ? 'Sign in to your server'
                : 'Create an account on your server'}
            </Text>
          </VStack>

          <VStack space="md">
            {mode === 'sign-up' && (
              <Input className="h-12">
                <InputField
                  testID="login.name"
                  placeholder="Name"
                  value={name}
                  onChangeText={setName}
                  autoCapitalize="words"
                  textContentType="name"
                />
              </Input>
            )}
            <Input className="h-12">
              <InputField
                testID="login.email"
                placeholder="Email"
                value={email}
                onChangeText={setEmail}
                autoCapitalize="none"
                keyboardType="email-address"
                textContentType="emailAddress"
              />
            </Input>
            <Input className="h-12">
              <InputField
                testID="login.password"
                placeholder="Password"
                value={password}
                onChangeText={setPassword}
                secureTextEntry={!showPassword}
                textContentType="password"
                onSubmitEditing={() => { void submit(); }}
              />
              <InputSlot
                testID="login.showPassword"
                className="pr-3"
                onPress={() => { setShowPassword((v) => !v); }}
              >
                <InputIcon as={showPassword ? EyeOff : Eye} className="text-muted-foreground" />
              </InputSlot>
            </Input>

            {error && (
              <Text testID="login.error" size="sm" className="text-destructive">
                {error}
              </Text>
            )}

            <Button
              testID="login.submit"
              size="lg"
              className="bg-primary data-[hover=true]:bg-primary-hover"
              onPress={() => { void submit(); }}
              isDisabled={busy}
            >
              {busy && <ButtonSpinner className="text-primary-foreground" />}
              <ButtonText className="text-primary-foreground">
                {mode === 'sign-in' ? 'Sign in' : 'Create account'}
              </ButtonText>
            </Button>
          </VStack>

          <HStack space="xs" className="justify-center">
            <Text size="sm" className="text-muted-foreground">
              {mode === 'sign-in' ? 'No account?' : 'Already registered?'}
            </Text>
            <Pressable
              testID="login.toggleMode"
              onPress={() => {
                setMode(mode === 'sign-in' ? 'sign-up' : 'sign-in');
                setError(null);
              }}
            >
              <Text size="sm" className="text-link">
                {mode === 'sign-in' ? 'Create one' : 'Sign in'}
              </Text>
            </Pressable>
          </HStack>

          <ServerPicker open={serverOpen} onToggle={setServerOpen} onResult={revealServerResult} />

          {/* A host that just chose to expose itself lands here before it can
              sign in, and this is the one moment its approval link is certain
              to be needed. Renders nothing off the desktop. */}
          <TailnetStatusCard testIDPrefix="login.tailnet" />
        </VStack>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

/**
 * Whether the request failed to reach a server at all, as opposed to reaching
 * one that said no.
 *
 * Deliberately generous: a fetch that never got a response surfaces as
 * "Network request failed" on React Native, a `TypeError` on web, and an
 * `AbortError` on a timeout, and none of them carry a status. Treating an
 * unknown failure as reachable would hide the one control that fixes it, so
 * the default leans the other way.
 */
function isUnreachable(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === 'AbortError' || err.name === 'TypeError') return true;
  return /network|fetch|failed to connect|timeout|refused/i.test(err.message);
}
