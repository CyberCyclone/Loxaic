import { Input, InputField } from '@/components/ui/input';
import { HStack } from '@/components/ui/hstack';
import { VStack } from '@/components/ui/vstack';
import { Text } from '@/components/ui/text';
import { Pressable } from '@/components/ui/pressable';
import { Switch } from '@/components/ui/switch';
import type { InstanceConfigInput } from '@/lib/endpoint';

export type HostBind = 'lan' | 'localhost';

/**
 * The tailnet part of the form. `authKey` is write-only: it is never
 * pre-filled (the stored key never leaves the main process) and an empty
 * field means "leave whatever is stored alone"; `clearAuthKey` is the one
 * explicit way to forget a stored key.
 */
export interface TailnetFormValues {
  enabled: boolean;
  hostname: string;
  funnel: boolean;
  authKey: string;
  clearAuthKey: boolean;
  controlUrl: string;
}

export const EMPTY_TAILNET: TailnetFormValues = {
  enabled: false,
  hostname: '',
  funnel: false,
  authKey: '',
  clearAuthKey: false,
  controlUrl: '',
};

export interface HostConfigValues {
  port: string;
  bind: HostBind;
  advertiseUrl: string;
  tailnet: TailnetFormValues;
}

/** The `host.tailnet` payload for setMode. Strings are sent as typed — an
 * emptied hostname falls back to the default on the main process, an emptied
 * control URL clears a stored one — and the auth key only when it is meant to
 * change. */
export function tailnetInputFrom(values: TailnetFormValues): NonNullable<InstanceConfigInput['host']>['tailnet'] {
  const key = values.authKey.trim();
  return {
    enabled: values.enabled,
    hostname: values.hostname.trim(),
    funnel: values.funnel,
    controlUrl: values.controlUrl.trim(),
    ...(values.clearAuthKey ? { authKey: '' } : key ? { authKey: key } : {}),
  };
}

type Field = 'port' | 'bind' | 'advertiseUrl' | 'tailnet';

const BINDS: HostBind[] = ['lan', 'localhost'];

const BIND_LABEL: Record<HostBind, string> = {
  lan: 'This network (LAN)',
  localhost: 'Only this machine',
};

/**
 * The port/bind/public-address/tailnet form shared by onboarding's Host step
 * and Settings' Server section — the same fields, submitted through the same
 * `setMode({ mode, host })` path either way. Solo passes `fields={['port']}`:
 * it's always loopback and never advertised, so the rest would be dead
 * controls there.
 */
export function HostConfigFields({
  testIDPrefix,
  values,
  onChange,
  lanAddress,
  defaultPort,
  defaultTailnetHostname = 'loxaic-host',
  hasTailnetAuthKey = false,
  fields = ['port', 'bind', 'advertiseUrl', 'tailnet'],
}: {
  testIDPrefix: string;
  values: HostConfigValues;
  onChange: (values: HostConfigValues) => void;
  lanAddress: string | null;
  /** What the bridge reports as the default — never a literal here. */
  defaultPort: number;
  defaultTailnetHostname?: string;
  hasTailnetAuthKey?: boolean;
  fields?: Field[];
}) {
  const show = (f: Field) => fields.includes(f);
  const tailnet = values.tailnet;
  const setTailnet = (patch: Partial<TailnetFormValues>) => {
    onChange({ ...values, tailnet: { ...tailnet, ...patch } });
  };
  const tailnetHost = tailnet.hostname.trim() || defaultTailnetHostname;

  const port = values.port || String(defaultPort);
  const advertised = values.advertiseUrl.trim();
  // A loopback bind with no public address is reachable by nobody else, and
  // the sentence has to say so rather than print a localhost URL under a
  // heading that promises others can use it.
  const tailnetOn = show('tailnet') && values.tailnet.enabled;
  const loopbackOnly = !advertised && !tailnetOn && values.bind === 'localhost';
  const reachableAt =
    advertised ||
    (tailnetOn
      ? `https://${tailnetHost}.<your-tailnet>.ts.net once approved`
      : loopbackOnly
        ? `http://localhost:${port}`
        : lanAddress
          ? `http://${lanAddress}:${port}`
          : `http://<this machine's LAN address>:${port}`);

  return (
    <VStack space="md">
      {show('port') && (
        <VStack space="xs">
          <Text size="sm" className="text-muted-foreground">Port</Text>
          <Input className="h-12">
            <InputField
              testID={`${testIDPrefix}.port`}
              placeholder="4100"
              value={values.port}
              onChangeText={(v) => { onChange({ ...values, port: v }); }}
              keyboardType="number-pad"
            />
          </Input>
        </VStack>
      )}

      {show('bind') && (
        <VStack space="xs">
          <Text size="sm" className="text-muted-foreground">Reachable at</Text>
          <HStack space="xs">
            {BINDS.map((b) => (
              <Pressable
                key={b}
                testID={`${testIDPrefix}.bind.${b}`}
                onPress={() => { onChange({ ...values, bind: b }); }}
                className={`rounded-full px-3 py-1.5 ${values.bind === b ? 'bg-primary/15' : 'bg-muted'}`}
              >
                <Text size="sm" className={values.bind === b ? 'text-primary' : 'text-muted-foreground'}>
                  {BIND_LABEL[b]}
                </Text>
              </Pressable>
            ))}
          </HStack>
        </VStack>
      )}

      {show('advertiseUrl') && (
        <VStack space="xs">
          <Text size="sm" className="text-muted-foreground">Public address (optional)</Text>
          <Input className="h-12">
            <InputField
              testID={`${testIDPrefix}.advertiseUrl`}
              placeholder="https://loxaic.example.com"
              value={values.advertiseUrl}
              onChangeText={(v) => { onChange({ ...values, advertiseUrl: v }); }}
              autoCapitalize="none"
            />
          </Input>
          <Text size="2xs" className="text-muted-foreground">
            If people reach this machine through a reverse proxy, a domain, or a public IP,
            enter that URL. Sign-in cookies and the address other devices are told to use come
            from this.
          </Text>
        </VStack>
      )}

      {show('tailnet') && (
        <VStack space="sm">
          <HStack space="sm" className="items-center">
            <Switch
              testID={`${testIDPrefix}.tailnet`}
              value={tailnet.enabled}
              onValueChange={(enabled: boolean) => { setTailnet({ enabled }); }}
            />
            <Text size="sm" className="flex-1 text-foreground">Expose on Tailscale</Text>
          </HStack>
          <Text size="2xs" className="text-muted-foreground">
            Other devices on your tailnet reach this machine at a private https address, with no
            Tailscale app needed here. Phones still need the Tailscale app, unless you also publish
            to the internet below.
          </Text>

          {tailnet.enabled && (
            <VStack space="md" className="mt-1">
              <VStack space="xs">
                <Text size="sm" className="text-muted-foreground">Name on the tailnet</Text>
                <Input className="h-12">
                  <InputField
                    testID={`${testIDPrefix}.tailnet.hostname`}
                    placeholder={defaultTailnetHostname}
                    value={tailnet.hostname}
                    onChangeText={(v) => { setTailnet({ hostname: v }); }}
                    autoCapitalize="none"
                  />
                </Input>
              </VStack>

              <HStack space="sm" className="items-center">
                <Switch
                  testID={`${testIDPrefix}.tailnet.funnel`}
                  value={tailnet.funnel}
                  onValueChange={(funnel: boolean) => { setTailnet({ funnel }); }}
                />
                <Text size="sm" className="flex-1 text-foreground">Also publish to the internet (Funnel)</Text>
              </HStack>
              <Text size="2xs" className="text-muted-foreground">
                Anyone with the address reaches the sign-in page, not only your tailnet. This is how a
                phone without the Tailscale app reaches you. Funnel has to be allowed in your
                tailnet&apos;s policy.
              </Text>

              <VStack space="xs">
                <Text size="sm" className="text-muted-foreground">Auth key (optional)</Text>
                <Input className="h-12">
                  <InputField
                    testID={`${testIDPrefix}.tailnet.authKey`}
                    placeholder={hasTailnetAuthKey && !tailnet.clearAuthKey ? 'Stored — leave blank to keep it' : 'tskey-auth-…'}
                    value={tailnet.authKey}
                    onChangeText={(v) => { setTailnet({ authKey: v, clearAuthKey: false }); }}
                    autoCapitalize="none"
                    secureTextEntry
                  />
                </Input>
                <HStack space="sm" className="items-center">
                  <Text size="2xs" className="flex-1 text-muted-foreground">
                    Approves this machine without a browser. Without one, you approve it in a browser
                    the first time. Kept on this machine only.
                  </Text>
                  {hasTailnetAuthKey && !tailnet.clearAuthKey && (
                    <Pressable
                      testID={`${testIDPrefix}.tailnet.forgetKey`}
                      onPress={() => { setTailnet({ authKey: '', clearAuthKey: true }); }}
                    >
                      <Text size="2xs" className="text-destructive">Forget stored key</Text>
                    </Pressable>
                  )}
                </HStack>
              </VStack>

              <VStack space="xs">
                <Text size="sm" className="text-muted-foreground">Control server (advanced)</Text>
                <Input className="h-12">
                  <InputField
                    testID={`${testIDPrefix}.tailnet.controlUrl`}
                    placeholder="Leave blank for Tailscale"
                    value={tailnet.controlUrl}
                    onChangeText={(v) => { setTailnet({ controlUrl: v }); }}
                    autoCapitalize="none"
                  />
                </Input>
                <Text size="2xs" className="text-muted-foreground">
                  For a self-hosted control plane such as Headscale, e.g. https://headscale.example.com.
                </Text>
              </VStack>
            </VStack>
          )}
        </VStack>
      )}

      {(show('bind') || show('advertiseUrl')) && (
        <Text testID={`${testIDPrefix}.reachableAt`} size="xs" className="text-muted-foreground">
          {loopbackOnly
            ? `Only this machine can reach it, at ${reachableAt}. Choose "This network" or set a public address for others to connect.`
            : `Others will reach you at ${reachableAt}`}
        </Text>
      )}
    </VStack>
  );
}
