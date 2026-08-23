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

export default function LoginScreen() {
  const { token, signIn, signUp } = useSession();
  const router = useRouter();
  const [mode, setMode] = useState<'sign-in' | 'sign-up'>('sign-in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

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
    } catch {
      setError(
        mode === 'sign-in'
          ? 'Sign in failed. Check your email, password, and server connection.'
          : 'Sign up failed. The email may already be registered, or the server is unreachable.',
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
              <Text className="text-lg font-bold text-primary-foreground">OS</Text>
            </Box>
            <Heading size="xl" className="text-foreground">
              Open-Shannon
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
                placeholder="Password"
                value={password}
                onChangeText={setPassword}
                secureTextEntry={!showPassword}
                textContentType="password"
                onSubmitEditing={submit}
              />
              <InputSlot className="pr-3" onPress={() => setShowPassword((v) => !v)}>
                <InputIcon as={showPassword ? EyeOff : Eye} className="text-muted-foreground" />
              </InputSlot>
            </Input>

            {error && (
              <Text size="sm" className="text-destructive">
                {error}
              </Text>
            )}

            <Button
              size="lg"
              className="bg-primary data-[hover=true]:bg-primary-hover"
              onPress={submit}
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
        </VStack>
      </Box>
    </KeyboardAvoidingView>
  );
}
