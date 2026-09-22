import { useState } from 'react';
import { Eye, EyeOff } from 'lucide-react-native';
import { ApiError } from '@loxaic/api-client';
import { VStack } from '@/components/ui/vstack';
import { HStack } from '@/components/ui/hstack';
import { Text } from '@/components/ui/text';
import { Input, InputField } from '@/components/ui/input';
import { Icon } from '@/components/ui/icon';
import { Button, ButtonSpinner, ButtonText } from '@/components/ui/button';
import { Pressable } from '@/components/ui/pressable';
import { useSession } from '@/lib/session';

/** better-auth's own floor; checked here too so the common mistake is caught
 * before a round trip, and the server's answer covers anything else. */
const MIN_LENGTH = 8;

/**
 * Current, new and confirm — used by the Account screen and by the forced
 * change after a reset, which is why it owns its testIDs: one e2e helper
 * fills either.
 *
 * A change always signs out every other device (the server passes
 * revokeOtherSessions unconditionally), and the form says so before it is
 * submitted rather than after.
 */
export function ChangePasswordForm({
  onSuccess,
  currentLabel = 'Current password',
  submitLabel = 'Change password',
}: {
  onSuccess?: () => void;
  currentLabel?: string;
  submitLabel?: string;
}) {
  const { changePassword } = useSession();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const submit = async () => {
    if (busy || !current || !next || !confirm) return;
    setDone(false);
    if (next.length < MIN_LENGTH) {
      setError(`Use at least ${String(MIN_LENGTH)} characters for the new password.`);
      return;
    }
    if (next !== confirm) {
      setError('The new passwords do not match.');
      return;
    }
    // The server refuses this too (PASSWORD_UNCHANGED). After a reset the
    // current password is the temporary one an admin has seen, and keeping it
    // would satisfy the forced change without changing anything.
    if (next === current) {
      setError('Choose a password you have not used before.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await changePassword(current, next);
      setCurrent('');
      setNext('');
      setConfirm('');
      setDone(true);
      onSuccess?.();
    } catch (err) {
      setError(describe(err));
    } finally {
      setBusy(false);
    }
  };

  const field = (
    testID: string,
    label: string,
    value: string,
    onChange: (v: string) => void,
    textContentType: 'password' | 'newPassword',
  ) => (
    <VStack space="xs">
      <Text size="xs" className="text-muted-foreground">
        {label}
      </Text>
      <Input className="h-11">
        <InputField
          testID={testID}
          value={value}
          onChangeText={(v) => {
            onChange(v);
            setDone(false);
          }}
          secureTextEntry={!show}
          autoCapitalize="none"
          autoCorrect={false}
          textContentType={textContentType}
          onSubmitEditing={() => { void submit(); }}
        />
      </Input>
    </VStack>
  );

  return (
    <VStack space="md">
      {field('account.password.current', currentLabel, current, setCurrent, 'password')}
      {field('account.password.new', 'New password', next, setNext, 'newPassword')}
      {field('account.password.confirm', 'Confirm new password', confirm, setConfirm, 'newPassword')}

      <Pressable
        testID="account.password.showPassword"
        onPress={() => { setShow((v) => !v); }}
        className="self-start"
      >
        <HStack space="xs" className="items-center">
          <Icon as={show ? EyeOff : Eye} size="sm" className="text-muted-foreground" />
          <Text size="xs" className="text-muted-foreground">
            {show ? 'Hide passwords' : 'Show passwords'}
          </Text>
        </HStack>
      </Pressable>

      <Text size="xs" className="text-muted-foreground">
        Changing your password signs you out on every other device.
      </Text>

      {error && (
        <Text testID="account.password.error" size="sm" className="text-destructive">
          {error}
        </Text>
      )}
      {done && !error && (
        <Text testID="account.password.success" size="sm" className="text-success">
          Password changed. Other devices have been signed out.
        </Text>
      )}

      <Button
        testID="account.password.submit"
        onPress={() => { void submit(); }}
        isDisabled={busy || !current || !next || !confirm}
        className="self-start"
      >
        {busy && <ButtonSpinner />}
        <ButtonText>{submitLabel}</ButtonText>
      </Button>
    </VStack>
  );
}

function describe(err: unknown): string {
  if (err instanceof ApiError) {
    switch (err.code) {
      case 'INVALID_PASSWORD':
        return 'The current password is wrong.';
      case 'PASSWORD_UNCHANGED':
        return 'Choose a password you have not used before.';
      case 'PASSWORD_TOO_SHORT':
        return `Use at least ${String(MIN_LENGTH)} characters for the new password.`;
      case 'PASSWORD_TOO_LONG':
        return 'That password is too long. Use 128 characters or fewer.';
      default:
        return err.message;
    }
  }
  return 'Could not reach the server. Check your connection and try again.';
}
