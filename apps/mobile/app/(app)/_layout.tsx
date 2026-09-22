import { Redirect, Slot } from 'expo-router';
import { AppShell } from '@/components/shell/AppShell';
import { useSession } from '@/lib/session';

export default function AppLayout() {
  const { token, needsOnboarding, mustChangePassword } = useSession();
  // An unconfigured desktop install has no server to sign in to yet, so the
  // mode chooser comes before the auth gate rather than after it.
  if (needsOnboarding) return <Redirect href="/onboarding" />;
  if (!token) return <Redirect href="/login" />;
  // After a password reset the server refuses everything the shell would ask
  // for (apps/server/src/auth/middleware.ts), so the gate is here rather than
  // a banner inside it.
  if (mustChangePassword) return <Redirect href="/change-password" />;
  return (
    <AppShell>
      <Slot />
    </AppShell>
  );
}
