import { useState } from 'react';
import { Redirect, useRouter } from 'expo-router';
import { KeyboardAvoidingView, Platform } from 'react-native';
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
import { ServerPicker } from '@/components/auth/ServerPicker';

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
      if (unreachable) setServerOpen(true);
      setError(
        unreachable
          ? `Could not reach ${currentEndpoint() ?? 'a server'}. Check the address below.`
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
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <Box className="flex-1 items-center justify-center bg-background px-6">
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

          <ServerPicker open={serverOpen} onToggle={setServerOpen} />

          {/* A host that just chose to expose itself lands here before it can
              sign in, and this is the one moment its approval link is certain
              to be needed. Renders nothing off the desktop. */}
          <TailnetStatusCard testIDPrefix="login.tailnet" />
        </VStack>
      </Box>
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
