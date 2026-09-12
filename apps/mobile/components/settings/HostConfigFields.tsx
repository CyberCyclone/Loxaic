import { Input, InputField } from '@/components/ui/input';
import { HStack } from '@/components/ui/hstack';
import { VStack } from '@/components/ui/vstack';
import { Text } from '@/components/ui/text';
import { Pressable } from '@/components/ui/pressable';

export type HostBind = 'lan' | 'localhost';

export interface HostConfigValues {
  port: string;
  bind: HostBind;
  advertiseUrl: string;
}

type Field = 'port' | 'bind' | 'advertiseUrl';

const BINDS: HostBind[] = ['lan', 'localhost'];

const BIND_LABEL: Record<HostBind, string> = {
  lan: 'This network (LAN)',
  localhost: 'Only this machine',
};

/**
 * The port/bind/public-address form shared by onboarding's Host step and
 * Settings' Server section — the same three fields, submitted through the
 * same `setMode({ mode, host })` path either way. Solo passes `fields={['port']}`:
 * it's always loopback and never advertised, so bind/advertiseUrl would be
 * dead controls there.
 */
export function HostConfigFields({
  testIDPrefix,
  values,
  onChange,
  lanAddress,
  defaultPort,
  fields = ['port', 'bind', 'advertiseUrl'],
}: {
  testIDPrefix: string;
  values: HostConfigValues;
  onChange: (values: HostConfigValues) => void;
  lanAddress: string | null;
  /** What the bridge reports as the default — never a literal here. */
  defaultPort: number;
  fields?: Field[];
}) {
  const show = (f: Field) => fields.includes(f);

  const port = values.port || String(defaultPort);
  const advertised = values.advertiseUrl.trim();
  // A loopback bind with no public address is reachable by nobody else, and
  // the sentence has to say so rather than print a localhost URL under a
  // heading that promises others can use it.
  const loopbackOnly = !advertised && values.bind === 'localhost';
  const reachableAt =
    advertised ||
    (loopbackOnly
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
