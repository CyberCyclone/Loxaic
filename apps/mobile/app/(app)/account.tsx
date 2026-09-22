import { ScrollView } from 'react-native';
import { VStack } from '@/components/ui/vstack';
import { HStack } from '@/components/ui/hstack';
import { Text } from '@/components/ui/text';
import { Heading } from '@/components/ui/heading';
import { Badge, BadgeText } from '@/components/ui/badge';
import { MainHeader } from '@/components/shell/MainHeader';
import { useShell } from '@/components/shell/AppShell';
import { SettingsModal } from '@/components/settings/SettingsModal';
import { ChangePasswordForm } from '@/components/account/ChangePasswordForm';
import { useSession } from '@/lib/session';
import { TRUNCATE_TEXT } from '@/lib/truncate';

/**
 * Who you are signed in as, and your password.
 *
 * The first place the app shows the account's own email: the sidebar's name
 * is a local display preference, not the account, and on a shared server
 * "which account am I in?" is a real question.
 */
export default function AccountScreen() {
  const shell = useShell();
  const { user, isAdmin } = useSession();

  return (
    <VStack className="h-full flex-1">
      <MainHeader title="Account" onOpenMenu={shell.overlaySidebar ? shell.openSidebar : undefined} />
      <ScrollView testID="account.scroll" className="flex-1">
        <VStack space="xl" className="w-full max-w-[560px] p-4">
          <VStack space="xs" className="rounded-md border border-border bg-card p-4">
            <HStack space="sm" className="min-w-0 items-center">
              <Text testID="account.name" className="min-w-0 shrink font-medium text-foreground" style={TRUNCATE_TEXT}>
                {user?.name ?? ''}
              </Text>
              {isAdmin && (
                <Badge testID="account.role" variant="outline" className="shrink-0">
                  <BadgeText>Admin</BadgeText>
                </Badge>
              )}
            </HStack>
            <Text testID="account.email" size="sm" className="min-w-0 text-muted-foreground" style={TRUNCATE_TEXT}>
              {user?.email ?? ''}
            </Text>
          </VStack>

          <VStack space="md">
            <Heading size="sm" className="text-foreground">
              Password
            </Heading>
            <ChangePasswordForm />
          </VStack>
        </VStack>
      </ScrollView>
      <SettingsModal open={shell.settingsOpen} onClose={shell.closeSettings} />
    </VStack>
  );
}
