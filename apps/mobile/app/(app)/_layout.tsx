import { Redirect, Slot } from 'expo-router';
import { AppShell } from '@/components/shell/AppShell';
import { useSession } from '@/lib/session';

export default function AppLayout() {
  const { token } = useSession();
  if (!token) return <Redirect href="/login" />;
  return (
    <AppShell>
      <Slot />
    </AppShell>
  );
}
