import { Redirect, useRouter } from 'expo-router';
import { KeyboardAvoidingView, Platform, ScrollView } from 'react-native';
import { VStack } from '@/components/ui/vstack';
import { Heading } from '@/components/ui/heading';
import { Text } from '@/components/ui/text';
import { Pressable } from '@/components/ui/pressable';
import { ChangePasswordForm } from '@/components/account/ChangePasswordForm';
import { useSession } from '@/lib/session';
import { TRUNCATE_TEXT } from '@/lib/truncate';

/**
 * The forced change after a password reset.
 *
 * Top level, beside /login, deliberately outside the app shell: until the
 * password is changed the server refuses every request the shell would make
 * (conversations, models, sockets), so there is nothing behind this screen to
 * show. The app layout sends a flagged user here; changing the password — the
 * one thing the server lets them do — clears the flag and lets them in.
 */
export default function ChangePasswordScreen() {
  const { token, user, mustChangePassword, signOut } = useSession();
  const router = useRouter();

  if (!token) return <Redirect href="/login" />;
  if (!mustChangePassword) return <Redirect href="/" />;

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
      <ScrollView
        style={{ flex: 1, minHeight: 0 }}
        className="bg-background"
        contentContainerStyle={{ flexGrow: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24, paddingVertical: 32 }}
        keyboardShouldPersistTaps="handled"
      >
        <VStack testID="changePassword.screen" space="xl" className="w-full max-w-[380px]">
          <VStack space="xs">
            <Heading size="xl" className="text-foreground">
              Choose a new password
            </Heading>
            <Text size="sm" className="min-w-0 text-muted-foreground" style={TRUNCATE_TEXT}>
              {user?.email ?? ''}
            </Text>
          </VStack>
          <Text testID="changePassword.reason" size="sm" className="text-foreground">
            An administrator reset your password. Enter the temporary password they gave you as the current one, then
            choose a new password to continue.
          </Text>
          <ChangePasswordForm
            currentLabel="Temporary password"
            submitLabel="Set password and continue"
            onSuccess={() => { router.replace('/'); }}
          />
          <Pressable
            testID="changePassword.signOut"
            onPress={() => { void signOut().then(() => { router.replace('/login'); }); }}
            className="self-center"
          >
            <Text size="sm" className="text-link">
              Sign out
            </Text>
          </Pressable>
        </VStack>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
