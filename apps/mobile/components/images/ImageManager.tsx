import { useState } from 'react';
import { ScrollView } from 'react-native';
import { Box } from '@/components/ui/box';
import { VStack } from '@/components/ui/vstack';
import { HStack } from '@/components/ui/hstack';
import { Text } from '@/components/ui/text';
import { Heading } from '@/components/ui/heading';
import { Input, InputField } from '@/components/ui/input';
import { Button, ButtonText, ButtonSpinner } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { MainHeader } from '@/components/shell/MainHeader';
import { useShell } from '@/components/shell/AppShell';
import { useContainerImages } from '@/hooks/useContainerImages';
import { useServerConfig } from '@/hooks/useServerConfig';
import { useSession } from '@/lib/session';
import { useServerReachable } from '@/lib/connection';
import { imageStatusLine, parseLimitsInput } from '@/lib/customImages';
import { TRUNCATE_TEXT } from '@/lib/truncate';
import type { ImageScope, SandboxImage } from '@loxaic/api-client';

const COPY: Record<ImageScope, { title: string; intro: string; logins: string }> = {
  shared: {
    title: 'Container Images',
    intro:
      'Images loaded here can be chosen by everyone when they start an agent chat. They are pulled with the logins below, which belong to this deployment and are used for nothing else. An image may run as root; every capability is still dropped.',
    logins: 'Registry logins for shared images. Never shown again once saved.',
  },
  personal: {
    title: 'My Images',
    intro:
      'Only you can add or use these, pulled with your own registry logins, which nobody else (admins included) can see or use. People who can open a conversation you start in one can see its name.',
    logins: 'Your registry logins, for private images. Never shown again once saved.',
  },
};

/** The screen behind both Settings → Container Images (admin, shared) and
 * Settings → My Images (anyone's own), which differ only in scope. */
export function ImageManager({ scope }: { scope: ImageScope }) {
  const shell = useShell();
  const { token } = useSession();
  const reachable = useServerReachable();
  const { config } = useServerConfig();
  const images = useContainerImages(scope, token);
  const copy = COPY[scope];
  const blocked = config?.sandbox.customImagesBlocked;

  const [registry, setRegistry] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [reference, setReference] = useState('');
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const run = async (key: string, action: () => Promise<boolean>, onDone?: () => void) => {
    setBusy(key);
    try {
      if (await action()) onDone?.();
    } finally {
      setBusy(null);
    }
  };

  const writable = reachable && !blocked;

  return (
    <VStack className="h-full flex-1">
      <MainHeader title={copy.title} onOpenMenu={shell.overlaySidebar ? shell.openSidebar : undefined} />
      <ScrollView className="flex-1" style={{ flex: 1, minHeight: 0 }} keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets>
        <VStack space="lg" className="p-4">
          <Text testID="images.intro" size="sm" className="text-muted-foreground">
            {copy.intro}
          </Text>
          {blocked && (
            <Text testID="images.blocked" size="sm" className="text-destructive">
              {blocked}
            </Text>
          )}
          {images.error && (
            <Text testID="images.error" size="sm" className="text-destructive">
              {images.error}
            </Text>
          )}

          {images.loading ? (
            <Box className="items-center justify-center p-6">
              <Spinner />
            </Box>
          ) : images.unknown ? (
            <VStack space="sm">
              <Text testID="images.unknown" size="sm" className="text-muted-foreground">
                Couldn&apos;t load images. They will load once your server is back.
              </Text>
              <Button testID="images.retry" variant="outline" onPress={() => { void images.refresh(); }} isDisabled={!reachable}>
                <ButtonText>Try again</ButtonText>
              </Button>
            </VStack>
          ) : (
            <>
              <VStack space="sm">
                <Heading size="sm">Registry logins</Heading>
                <Text size="xs" className="text-muted-foreground">
                  {copy.logins} Public images need none.
                </Text>
                {images.logins.map((l) => (
                  <HStack key={l.id} testID={`images.login.${l.id}`} space="sm" className="items-center justify-between rounded-md border border-border bg-card px-3 py-2">
                    <Text size="sm" className="min-w-0 shrink text-foreground" style={TRUNCATE_TEXT}>
                      {l.registry} · {l.username}
                    </Text>
                    <Button
                      testID={`images.login.remove.${l.id}`}
                      size="sm"
                      variant="outline"
                      className="shrink-0"
                      isDisabled={!reachable || busy !== null}
                      onPress={() => { void run(`login-${l.id}`, () => images.removeLogin(l.id)); }}
                    >
                      <ButtonText>Remove</ButtonText>
                    </Button>
                  </HStack>
                ))}
                <Input>
                  <InputField testID="images.login.registry" placeholder="Registry (docker.io, ghcr.io, …)" value={registry} onChangeText={setRegistry} autoCapitalize="none" autoCorrect={false} />
                </Input>
                <Input>
                  <InputField testID="images.login.username" placeholder="Username" value={username} onChangeText={setUsername} autoCapitalize="none" autoCorrect={false} />
                </Input>
                <Input>
                  <InputField
                    testID="images.login.password"
                    placeholder="Password or access token"
                    value={password}
                    onChangeText={setPassword}
                    secureTextEntry
                    autoCapitalize="none"
                    autoCorrect={false}
                  />
                </Input>
                <Button
                  testID="images.login.save"
                  isDisabled={!writable || busy !== null || !username.trim() || !password}
                  onPress={() => {
                    void run('login', () => images.saveLogin({ registry: registry.trim(), username: username.trim(), password }), () => {
                      setRegistry('');
                      setUsername('');
                      setPassword('');
                    });
                  }}
                >
                  {busy === 'login' ? <ButtonSpinner /> : <ButtonText>Save login</ButtonText>}
                </Button>
              </VStack>

              <VStack space="sm">
                <Heading size="sm">Images</Heading>
                {images.images.length === 0 && (
                  <Text testID="images.empty" size="sm" className="text-muted-foreground">
                    No images yet.
                  </Text>
                )}
                {images.images.map((image) => (
                  <ImageRow
                    key={image.id}
                    image={image}
                    busy={busy !== null}
                    writable={writable}
                    reachable={reachable}
                    onPull={() => { void run(`pull-${image.id}`, () => images.pullImage(image.id)); }}
                    onRemove={() => { void run(`remove-${image.id}`, () => images.removeImage(image.id)); }}
                    onSaveLimits={(limits) => run(`limits-${image.id}`, () => images.updateImage(image.id, { limits }))}
                  />
                ))}
                <Input>
                  <InputField testID="images.add.reference" placeholder="Image, e.g. ghcr.io/owner/image:tag" value={reference} onChangeText={setReference} autoCapitalize="none" autoCorrect={false} />
                </Input>
                <Input>
                  <InputField testID="images.add.label" placeholder="Name shown in the chooser (optional)" value={label} onChangeText={setLabel} />
                </Input>
                <Button
                  testID="images.add.submit"
                  isDisabled={!writable || busy !== null || !reference.trim()}
                  onPress={() => {
                    void run('add', () => images.addImage({ reference: reference.trim(), ...(label.trim() ? { label: label.trim() } : {}) }), () => {
                      setReference('');
                      setLabel('');
                    });
                  }}
                >
                  {busy === 'add' ? <ButtonSpinner /> : <ButtonText>Add and pull</ButtonText>}
                </Button>
              </VStack>
            </>
          )}
        </VStack>
      </ScrollView>
    </VStack>
  );
}

function ImageRow({
  image,
  busy,
  writable,
  reachable,
  onPull,
  onRemove,
  onSaveLimits,
}: {
  image: SandboxImage;
  busy: boolean;
  writable: boolean;
  reachable: boolean;
  onPull: () => void;
  onRemove: () => void;
  onSaveLimits: (limits: { memoryMb: number; cpus: number; pids: number }) => Promise<void>;
}) {
  const [memory, setMemory] = useState(String(image.limits?.memoryMb ?? ''));
  const [cpus, setCpus] = useState(String(image.limits?.cpus ?? ''));
  const [pids, setPids] = useState(String(image.limits?.pids ?? ''));
  const [limitsError, setLimitsError] = useState<string | null>(null);
  const status = imageStatusLine(image);

  return (
    <VStack testID={`images.image.${image.id}`} space="xs" className="rounded-md border border-border bg-card p-3">
      <Text testID={`images.image.label.${image.id}`} size="sm" className="text-foreground">
        {image.label}
      </Text>
      <Text size="2xs" className="text-muted-foreground" style={TRUNCATE_TEXT}>
        {image.reference}
      </Text>
      <Text
        testID={`images.image.status.${image.id}`}
        size="xs"
        className={image.status === 'failed' ? 'text-destructive' : 'text-muted-foreground'}
      >
        {status}
      </Text>
      {image.check && image.check.warnings.length > 0 && (
        <VStack testID={`images.image.warnings.${image.id}`}>
          {image.check.warnings.map((w) => (
            <Text key={w.code} size="2xs" className="text-muted-foreground">
              {w.message}
            </Text>
          ))}
        </VStack>
      )}
      {image.limits && (
        <VStack space="xs" className="pt-1">
          <Text size="2xs" className="text-muted-foreground">
            Limits for each sandbox: memory (MB), CPUs, processes
          </Text>
          <HStack space="xs">
            <Input className="flex-1">
              <InputField testID={`images.image.limits.memory.${image.id}`} value={memory} onChangeText={setMemory} keyboardType="number-pad" />
            </Input>
            <Input className="flex-1">
              <InputField testID={`images.image.limits.cpus.${image.id}`} value={cpus} onChangeText={setCpus} keyboardType="decimal-pad" />
            </Input>
            <Input className="flex-1">
              <InputField testID={`images.image.limits.pids.${image.id}`} value={pids} onChangeText={setPids} keyboardType="number-pad" />
            </Input>
          </HStack>
          {limitsError && (
            <Text testID={`images.image.limits.error.${image.id}`} size="2xs" className="text-destructive">
              {limitsError}
            </Text>
          )}
          <Button
            testID={`images.image.limits.save.${image.id}`}
            size="sm"
            variant="outline"
            isDisabled={!reachable || busy}
            onPress={() => {
              const parsed = parseLimitsInput({ memoryMb: memory, cpus, pids });
              if (!parsed.ok) {
                setLimitsError(parsed.error);
                return;
              }
              setLimitsError(null);
              void onSaveLimits(parsed.limits);
            }}
          >
            <ButtonText>Save limits</ButtonText>
          </Button>
        </VStack>
      )}
      <HStack space="xs" className="pt-1">
        <Button testID={`images.image.pull.${image.id}`} size="sm" variant="outline" isDisabled={!writable || busy || image.status === 'pulling'} onPress={onPull}>
          <ButtonText>{image.status === 'failed' && !image.usable ? 'Try again' : 'Update'}</ButtonText>
        </Button>
        <Button testID={`images.image.remove.${image.id}`} size="sm" variant="outline" isDisabled={!reachable || busy} onPress={onRemove}>
          <ButtonText>Remove</ButtonText>
        </Button>
      </HStack>
    </VStack>
  );
}
