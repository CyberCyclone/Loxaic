import { useCallback, useEffect, useState } from 'react';
import { Redirect, useRouter } from 'expo-router';
import { KeyboardAvoidingView, Platform, ScrollView } from 'react-native';
import { Boxes, Laptop, Server, TriangleAlert } from 'lucide-react-native';
import { Box } from '@/components/ui/box';
import { VStack } from '@/components/ui/vstack';
import { HStack } from '@/components/ui/hstack';
import { Heading } from '@/components/ui/heading';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { Input, InputField } from '@/components/ui/input';
import { Button, ButtonText, ButtonSpinner } from '@/components/ui/button';
import { Pressable } from '@/components/ui/pressable';
import { useSession } from '@/lib/session';
import { electronBridge, type InstanceConfigInput, type InstanceState } from '@/lib/endpoint';
import { EMPTY_TAILNET, HostConfigFields, tailnetInputFrom, type HostConfigValues } from '@/components/settings/HostConfigFields';
import { TailnetStatusCard } from '@/components/settings/TailnetStatusCard';
import { Switch } from '@/components/ui/switch';

type Step = 'choose' | 'solo' | 'host' | 'client';

/**
 * First-run instance setup for the desktop app: run this machine alone
 * (Solo), serve other people from it (Host), or join someone else's (Client).
 *
 * Unauthenticated and outside the `(app)` group on purpose — the endpoint has
 * to be settable *before* a token can exist, and the only endpoint UI before
 * this lived inside Settings, behind the auth gate. A fresh install pointed at
 * a server the build's env vars don't know about had no way in at all.
 *
 * Electron-only for now: it drives the main process over the bridge, which no
 * other platform has. Expo clients reach a host through the Settings endpoint
 * field; giving them a full join flow is #77's business, not this screen's.
 */
export default function OnboardingScreen() {
  const bridge = electronBridge();
  const { completeOnboarding } = useSession();
  const router = useRouter();
  const [state, setState] = useState<InstanceState | null>(null);
  const [step, setStep] = useState<Step>('choose');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Solo form
  const [soloConfig, setSoloConfig] = useState<HostConfigValues>({ port: '', bind: 'localhost', advertiseUrl: '', tailnet: { ...EMPTY_TAILNET } });

  // Host form
  const [hostName, setHostName] = useState('');
  const [hostConfig, setHostConfig] = useState<HostConfigValues>({ port: '', bind: 'lan', advertiseUrl: '', tailnet: { ...EMPTY_TAILNET } });
  const [engine, setEngine] = useState<{ ok: boolean; engine?: string; reason?: string } | null>(null);

  // Client form
  const [hostUrl, setHostUrl] = useState('');
  const [viaTsnet, setViaTsnet] = useState(false);
  const [probe, setProbe] = useState<{ ok: boolean; reason?: string; cluster?: { name: string } } | null>(null);

  useEffect(() => {
    if (!bridge) return;
    void bridge.instance.getState().then((s) => {
      setState(s);
      setHostName((n) => n || s.defaultHostName);
      setSoloConfig((v) => ({ ...v, port: v.port || String(s.defaultPort) }));
      setHostConfig((v) => ({ ...v, port: v.port || String(s.defaultPort) }));
      if (s.error) setError(s.error);
    });
  }, [bridge]);

  const apply = useCallback(
    async (config: InstanceConfigInput) => {
      if (!bridge) return;
      setBusy(true);
      setError(null);
      try {
        const next = await bridge.instance.setMode(config);
        setState(next);
        if (next.error) {
          setError(next.error);
          return;
        }
        // The endpoint follows over the bridge (see subscribeToDesktopEndpoint),
        // so by the time we route away the app is already pointed at the new
        // server — no restart, and no window where the UI is live against the
        // old one.
        //
        // completeOnboarding is what actually lets us leave. The session's
        // needsOnboarding flag latched true when the bootstrap found no config,
        // and the app layout redirects here while it is set; without clearing
        // it — and running the session bootstrap the early return skipped —
        // the replace below bounces straight back to this screen.
        await completeOnboarding();
        router.replace('/');
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [bridge, router, completeOnboarding],
  );

  // Nothing to configure off the desktop app: the endpoint is same-origin on
  // web, and native picks it up from its build config or Settings.
  if (!bridge) return <Redirect href="/login" />;

  // Deliberately no "already configured, go away" redirect. Reaching this
  // screen is always intentional — either a gate sent an unconfigured install
  // here, or the user asked to change modes — and redirecting on a stored
  // config would make switching modes after setup impossible, which is
  // exactly what Settings needs to offer.

  const chooseHost = async () => {
    setStep('host');
    setEngine(null);
    setEngine(await bridge.instance.probeEngine());
  };

  const checkHostUrl = async () => {
    if (!hostUrl.trim()) return;
    setBusy(true);
    // Through the sidecar, a first run waits here until this machine is
    // approved — the card below shows the link while it does.
    setProbe(await bridge.instance.probeHost(hostUrl, viaTsnet ? { via: 'tsnet' } : undefined));
    setBusy(false);
  };

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
      {/* A ScrollView, not a centred Box: the Host step with its tailnet
          fields is taller than a short window, and gluestack's min-h-0 on
          every Box/VStack lets a flex column *compress* its children into
          each other rather than overflow — the same failure the Inspector
          hit (see AGENTS.md). Centred while it fits, scrolls once it does
          not. */}
      <ScrollView
        style={{ flex: 1, minHeight: 0 }}
        className="bg-background"
        contentContainerStyle={{ flexGrow: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24, paddingVertical: 32 }}
        keyboardShouldPersistTaps="handled"
      >
        <VStack space="xl" className="w-full max-w-[520px]">
          <VStack space="xs" className="items-center">
            <Box className="h-12 w-12 items-center justify-center rounded-md bg-primary">
              <Text className="text-lg font-bold text-primary-foreground">L</Text>
            </Box>
            <Heading size="xl" className="text-foreground">
              Set up Loxaic
            </Heading>
            <Text size="sm" className="text-center text-muted-foreground">
              {step === 'choose'
                ? 'This machine can run Loxaic for you, serve it to others, or connect to one already running.'
                : step === 'solo'
                  ? 'Runs everything locally, for you alone.'
                  : step === 'host'
                    ? 'Other people sign in to this machine and use its models.'
                    : 'Connect to a Loxaic already running somewhere else.'}
            </Text>
          </VStack>

          {error && (
            <HStack space="sm" className="items-start rounded-md bg-destructive/10 p-3">
              <Icon as={TriangleAlert} size="sm" className="mt-0.5 text-destructive" />
              <Text testID="onboarding.error" size="sm" className="flex-1 text-destructive">
                {error}
              </Text>
            </HStack>
          )}

          {step === 'choose' && (
            <VStack space="md">
              <ModeCard
                testID="onboarding.mode.solo"
                icon={Laptop}
                title="Just this machine"
                body="Runs everything locally for you alone. No container engine needed."
                onPress={() => { setStep('solo'); }}
                disabled={busy}
              />
              <ModeCard
                testID="onboarding.mode.host"
                icon={Server}
                title="Host for others"
                body="Serves this machine's models to people on your network. Requires Docker or Podman."
                onPress={() => { void chooseHost(); }}
                disabled={busy}
              />
              <ModeCard
                testID="onboarding.mode.client"
                icon={Boxes}
                title="Connect to a host"
                body="Use a Loxaic running on another machine. Nothing runs here."
                onPress={() => { setStep('client'); }}
                disabled={busy}
              />
            </VStack>
          )}

          {step === 'solo' && (
            <VStack space="md">
              <HostConfigFields defaultPort={state?.defaultPort ?? 4100}
                testIDPrefix="onboarding.solo"
                values={soloConfig}
                onChange={setSoloConfig}
                lanAddress={state?.lanAddress ?? null}
                fields={['port']}
              />
              <Text size="xs" className="text-muted-foreground">
                Only change the port if 4100 is already used by something else on this machine.
              </Text>
              <HStack space="sm">
                <Button variant="outline" className="flex-1" onPress={() => { setStep('choose'); }}>
                  <ButtonText>Back</ButtonText>
                </Button>
                <Button
                  testID="onboarding.solo.submit"
                  className="flex-1"
                  isDisabled={busy}
                  onPress={() => {
                    void apply({
                      mode: 'solo',
                      host: { port: Number(soloConfig.port) || state?.defaultPort },
                    });
                  }}
                >
                  {busy ? <ButtonSpinner /> : <ButtonText>Continue</ButtonText>}
                </Button>
              </HStack>
            </VStack>
          )}

          {step === 'host' && (
            <VStack space="md">
              <VStack space="xs">
                <Text size="sm" className="text-muted-foreground">
                  Host name — shown against this machine&apos;s models
                </Text>
                <Input className="h-12">
                  <InputField
                    testID="onboarding.host.name"
                    placeholder="e.g. Studio GPU"
                    value={hostName}
                    onChangeText={setHostName}
                  />
                </Input>
              </VStack>

              <HostConfigFields defaultPort={state?.defaultPort ?? 4100}
                testIDPrefix="onboarding.host"
                values={hostConfig}
                onChange={setHostConfig}
                lanAddress={state?.lanAddress ?? null}
                defaultTailnetHostname={state?.defaultTailnetHostname}
                hasTailnetAuthKey={state?.hasTailnetAuthKey}
              />

              {engine && !engine.ok && (
                <HStack space="sm" className="items-start rounded-md bg-destructive/10 p-3">
                  <Icon as={TriangleAlert} size="sm" className="mt-0.5 text-destructive" />
                  <Text testID="onboarding.host.engineError" size="sm" className="flex-1 text-destructive">
                    {engine.reason}
                  </Text>
                </HStack>
              )}
              {engine?.ok && (
                <Text testID="onboarding.host.engineOk" size="sm" className="text-muted-foreground">
                  Found {engine.engine} — agent commands will run isolated in containers.
                </Text>
              )}

              <HStack space="sm">
                <Button variant="outline" className="flex-1" onPress={() => { setStep('choose'); }}>
                  <ButtonText>Back</ButtonText>
                </Button>
                <Button
                  testID="onboarding.host.submit"
                  className="flex-1"
                  isDisabled={busy || !engine?.ok || !hostName.trim()}
                  onPress={() => {
                    void apply({
                      mode: 'host',
                      host: {
                        name: hostName.trim(),
                        port: Number(hostConfig.port) || state?.defaultPort,
                        bind: hostConfig.bind,
                        // Unconditional, same as Settings: an omitted key
                        // means "keep the previous value" to buildConfig.
                        advertiseUrl: hostConfig.advertiseUrl.trim(),
                        tailnet: tailnetInputFrom(hostConfig.tailnet),
                      },
                    });
                  }}
                >
                  {busy ? <ButtonSpinner /> : <ButtonText>Start hosting</ButtonText>}
                </Button>
              </HStack>
            </VStack>
          )}

          {step === 'client' && (
            <VStack space="md">
              <VStack space="xs">
                <Text size="sm" className="text-muted-foreground">Host address</Text>
                <Input className="h-12">
                  <InputField
                    testID="onboarding.client.url"
                    placeholder={viaTsnet ? 'https://box.tail1234.ts.net' : 'http://192.168.1.20:4100'}
                    value={hostUrl}
                    onChangeText={(v) => { setHostUrl(v); setProbe(null); }}
                    autoCapitalize="none"
                    onSubmitEditing={() => { void checkHostUrl(); }}
                  />
                </Input>
              </VStack>

              <HStack space="sm" className="items-center">
                <Switch
                  testID="onboarding.client.tsnet"
                  value={viaTsnet}
                  onValueChange={(v: boolean) => { setViaTsnet(v); setProbe(null); }}
                  isDisabled={busy}
                />
                <Text size="sm" className="flex-1 text-foreground">Connect through Tailscale</Text>
              </HStack>
              <Text size="2xs" className="text-muted-foreground">
                For a host on your tailnet. This machine joins it by itself — no Tailscale app
                needed — and you approve it once in a browser.
              </Text>
              {viaTsnet && <TailnetStatusCard testIDPrefix="onboarding.client.tailnet" />}

              {probe && !probe.ok && (
                <Text testID="onboarding.client.error" size="sm" className="text-destructive">
                  Couldn&apos;t reach a Loxaic there: {probe.reason}
                </Text>
              )}
              {probe?.ok && (
                <Text testID="onboarding.client.found" size="sm" className="text-muted-foreground">
                  Found {probe.cluster?.name ?? 'a Loxaic host'}. You&apos;ll sign in next.
                </Text>
              )}

              <HStack space="sm">
                <Button variant="outline" className="flex-1" onPress={() => { setStep('choose'); }}>
                  <ButtonText>Back</ButtonText>
                </Button>
                {probe?.ok ? (
                  <Button
                    testID="onboarding.client.submit"
                    className="flex-1"
                    isDisabled={busy}
                    onPress={() => { void apply({ mode: 'client', client: { hostUrl, ...(viaTsnet ? { via: 'tsnet' as const } : {}) } }); }}
                  >
                    {busy ? <ButtonSpinner /> : <ButtonText>Connect</ButtonText>}
                  </Button>
                ) : (
                  <Button
                    testID="onboarding.client.check"
                    className="flex-1"
                    isDisabled={busy || !hostUrl.trim()}
                    onPress={() => { void checkHostUrl(); }}
                  >
                    {busy ? <ButtonSpinner /> : <ButtonText>Check</ButtonText>}
                  </Button>
                )}
              </HStack>
            </VStack>
          )}
        </VStack>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function ModeCard({
  testID,
  icon,
  title,
  body,
  onPress,
  disabled,
}: {
  testID: string;
  icon: React.ComponentProps<typeof Icon>['as'];
  title: string;
  body: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      testID={testID}
      onPress={disabled ? undefined : onPress}
      className="rounded-md border border-border bg-muted p-4"
      style={disabled ? { opacity: 0.6 } : undefined}
    >
      <HStack space="md" className="items-start">
        <Icon as={icon} size="md" className="mt-0.5 text-primary" />
        <VStack space="xs" className="flex-1">
          <Text className="font-medium text-foreground">{title}</Text>
          <Text size="sm" className="text-muted-foreground">{body}</Text>
        </VStack>
      </HStack>
    </Pressable>
  );
}
