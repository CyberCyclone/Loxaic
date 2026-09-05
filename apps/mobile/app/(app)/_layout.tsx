import { Redirect, Slot } from 'expo-router';
import { AppShell } from '@/components/shell/AppShell';
import { useSession } from '@/lib/session';

export default function AppLayout() {
  const { token, needsOnboarding } = useSession();
  // An unconfigured desktop install has no server to sign in to yet, so the
  // mode chooser comes before the auth gate rather than after it.
  if (needsOnboarding) return <Redirect href="/onboarding" />;
  if (!token) return <Redirect href="/login" />;
  return (
    <AppShell>
      <Slot />
    </AppShell>
  );
}
