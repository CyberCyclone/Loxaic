import { useState } from 'react';
import { useRouter } from 'expo-router';
import { Platform } from 'react-native';
import { Box } from '@/components/ui/box';
import { VStack } from '@/components/ui/vstack';
import { HStack } from '@/components/ui/hstack';
import { Text } from '@/components/ui/text';
import { Input, InputField } from '@/components/ui/input';
import { Button, ButtonText, ButtonSpinner } from '@/components/ui/button';
import { Pressable } from '@/components/ui/pressable';
import { currentEndpoint, electronBridge, resolveEndpoint, setEndpoint } from '@/lib/endpoint';
import { getItem, setItem, removeItem } from '@/lib/storage';
import { normalizeUrl, tailnetHint } from '@/lib/server-address';

/**
 * Choosing which server to sign in to, from the sign-in screen itself.
 *
 * Without this a downloaded app is unusable on a phone: the endpoint override
 * lives in Settings, Settings lives inside the authenticated shell, and the
 * onboarding screen that would otherwise ask is desktop-only (`needsOnboarding`
 * comes from the Electron bridge). So a fresh install that cannot reach a
 * server could not be told where one was — it could not sign in because it did
 * not know the address, and could not be given the address without signing in.
 *
 * A browser is the one place it is genuinely unnecessary: the page was served
 * by the very server it signs in to, so there is nothing to point elsewhere.
 *
 * The desktop app has the same lockout — a Client whose stored host URL stops
 * resolving never sees onboarding again (`needsOnboarding` is only true when
 * there is no config at all) and its "Change host" control is behind the auth
 * gate. But it must not be fixed with this override: config.json has exactly
 * one write path, `setMode`, and a stored override would leave the app
 * claiming one server in its config while talking to another. So the desktop
 * gets a route back to onboarding, which writes through that path, and the
 * form below is native-only.
 */
/**
 * What the sign-in screen can offer for reaching a different server here:
 * the address form on native, a route back to onboarding on the desktop, and
 * nothing in a browser — where the page came from the server it signs in to.
 * Exported so the sign-in error can be gated on the same answer the picker
 * renders from, rather than promising "check the address below" over a
 * control that is not there.
 */
export function serverPickerKind(): 'form' | 'reconfigure' | 'none' {
  if (electronBridge()) return 'reconfigure';
  if (Platform.OS === 'web') return 'none';
  return 'form';
}

export function ServerPicker({ open, onToggle }: { open: boolean; onToggle: (open: boolean) => void }) {
  const router = useRouter();
  const [url, setUrl] = useState(() => getItem('loxaic-endpoint') ?? currentEndpoint() ?? '');
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [testing, setTesting] = useState(false);

  const active = currentEndpoint();

  // The bridge is checked before Platform.OS, and the order is load-bearing:
  // Electron's renderer *is* react-native-web, so `Platform.OS === 'web'` is
  // true there too. Checking the platform first made the desktop branch below
  // unreachable — the sign-in screen rendered nothing at all on the one
  // client that most needs it.
  //
  // The desktop route: back to the screen that owns config.json, which is
  // reachable at any time by design — onboarding deliberately has no
  // "already configured, go away" redirect, precisely so a mode can be
  // changed after setup.
  if (electronBridge()) {
    return (
      <VStack space="xs" className="items-center">
        <Text testID="login.server.current" size="2xs" className="text-muted-foreground">
          Server: {active ?? 'not set'}
        </Text>
        <Pressable testID="login.server.reconfigure" onPress={() => { router.push('/onboarding'); }}>
          <Text size="sm" className="text-link">Connect to a different server</Text>
        </Pressable>
      </VStack>
    );
  }

  // A real browser: the page came from the very server it signs in to.
  if (Platform.OS === 'web') return null;

  const save = () => {
    const next = normalizeUrl(url);
    if (next === null) {
      // Emptied deliberately: drop the override and let detection start over,
      // rather than pinning the app to a blank string.
      removeItem('loxaic-endpoint');
      setEndpoint(null);
      // setEndpoint(null) only clears the resolution; nothing re-runs the
      // detection, and the api-client keeps the previous base URL. Left
      // there, the collapsed line read "Server: not set" while the next
      // sign-in posted the password to the very address just removed —
      // and stored its token under the unscoped key, so the following
      // launch signed the person straight out. resolveEndpoint assigns
      // directly and fires no listener, so the result is routed back
      // through setEndpoint, the same as Settings' own clear branch.
      void resolveEndpoint(true).then((next) => {
        if (next) setEndpoint(next);
      });
      setResult(null);
      onToggle(false);
      return;
    }
    if (next instanceof Error) {
      setResult({ ok: false, message: next.message });
      return;
    }
    setUrl(next);
    setItem('loxaic-endpoint', next);
    // setEndpoint rather than storage alone: the api-client holds its own base
    // URL and the sockets captured one when their effect last ran, so both
    // have to be told or the change appears to work and silently doesn't.
    setEndpoint(next);
    setResult({ ok: true, message: 'Saved. Try signing in again.' });
  };

  const test = async () => {
    const next = normalizeUrl(url);
    if (next === null || next instanceof Error) {
      setResult({ ok: false, message: next instanceof Error ? next.message : 'Enter an address first.' });
      return;
    }
    setUrl(next);
    setTesting(true);
    setResult(null);
    const controller = new AbortController();
    // Deliberately longer than the 1.5s budget endpoint.ts gives its automatic
    // probes. That one exists so launch is never blocked on a dead address;
    // this one is someone standing there having just pressed the button, and a
    // Funnel address goes out to the public internet and back.
    const timer = setTimeout(() => { controller.abort(); }, 6000);
    try {
      const res = await fetch(`${next}/health`, { signal: controller.signal });
      setResult(
        res.ok
          ? { ok: true, message: 'Reachable' }
          : { ok: false, message: `Server answered ${String(res.status)}` },
      );
    } catch (err) {
      // A tailnet address with Tailscale off fails both ways — the name does
      // not resolve, or a 100.x address hangs until the timeout — so the hint
      // goes after either message. Appended, not substituted: a timeout on a
      // connected tailnet (server down, wrong port, a Funnel host) still needs
      // "Timed out" to be diagnosable.
      const base =
        err instanceof Error && err.name === 'AbortError'
          ? 'Timed out. Check the address, and that this device is on the same network or tailnet.'
          : 'Could not reach it.';
      const hint = tailnetHint(next);
      setResult({ ok: false, message: hint ? `${base} ${hint}` : base });
    } finally {
      clearTimeout(timer);
      setTesting(false);
    }
  };

  if (!open) {
    return (
      <VStack space="xs" className="items-center">
        {/* Shown even collapsed: "what is it even trying to reach?" is the
            first question when sign-in fails, and it is unanswerable from
            anywhere else on this screen. */}
        <Text testID="login.server.current" size="2xs" className="text-muted-foreground">
          Server: {active ?? 'not set'}
        </Text>
        <Pressable testID="login.server.toggle" onPress={() => { onToggle(true); }}>
          <Text size="sm" className="text-link">Connect to a different server</Text>
        </Pressable>
      </VStack>
    );
  }

  return (
    <Box className="rounded-md border border-border bg-card p-3">
      <VStack space="xs">
        <Text size="sm" className="text-foreground">Server address</Text>
        <Input className="h-12 border-border">
          <InputField
            testID="login.server.input"
            placeholder="https://box.tail1234.ts.net"
            value={url}
            onChangeText={(v) => { setUrl(v); setResult(null); }}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            onSubmitEditing={() => { void test(); }}
          />
        </Input>
        <Text size="2xs" className="text-muted-foreground">
          The address of the machine running Loxaic — a tailnet address, a Funnel address, or
          its address on your network. Leave blank to go back to finding one automatically.
        </Text>

        <HStack space="sm" className="items-center">
          <Button
            testID="login.server.test"
            variant="outline"
            size="sm"
            isDisabled={testing}
            onPress={() => { void test(); }}
          >
            {testing ? <ButtonSpinner /> : <ButtonText>Test</ButtonText>}
          </Button>
          <Button testID="login.server.save" size="sm" className="bg-primary" onPress={save}>
            <ButtonText className="text-primary-foreground">Save</ButtonText>
          </Button>
          <Pressable testID="login.server.cancel" onPress={() => { onToggle(false); }}>
            <Text size="sm" className="text-muted-foreground">Cancel</Text>
          </Pressable>
        </HStack>

        {result && (
          <Text
            testID="login.server.result"
            size="2xs"
            className={result.ok ? 'text-success' : 'text-destructive'}
          >
            {result.message}
          </Text>
        )}
      </VStack>
    </Box>
  );
}
