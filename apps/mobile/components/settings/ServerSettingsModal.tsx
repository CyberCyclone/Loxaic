import { useEffect, useRef, useState } from 'react';
import {
  Modal,
  ModalBackdrop,
  ModalContent,
  ModalHeader,
  ModalBody,
  ModalFooter,
  ModalCloseButton,
} from '@/components/ui/modal';
import { Heading } from '@/components/ui/heading';
import { Icon, CloseIcon } from '@/components/ui/icon';
import { VStack } from '@/components/ui/vstack';
import { HStack } from '@/components/ui/hstack';
import { Text } from '@/components/ui/text';
import { Input, InputField } from '@/components/ui/input';
import { Button, ButtonText, ButtonSpinner } from '@/components/ui/button';
import { HostConfigFields, type HostConfigValues } from './HostConfigFields';
import { electronBridge, type InstanceState } from '@/lib/endpoint';
import { useToastHelper } from '@/hooks/useToastHelper';

/**
 * Edits this install's server settings after onboarding — the same
 * `setMode` path onboarding uses, so Save has the same effect a first-run
 * choice would: the stack stops and restarts on the new config. A solo/host
 * edit changes name/port/bind/public-address; a client edit re-probes and
 * repoints at a different host, same two-stage flow as onboarding's client
 * step (Check, then Connect once it answers).
 *
 * Bounded height + scrollable, matching every other settings dialog in this
 * app (see AGENTS.md's ModalBody gotcha) — this one has three text fields
 * plus a pill row and can outgrow a short viewport.
 */
export function ServerSettingsModal({
  open,
  onClose,
  state,
}: {
  open: boolean;
  onClose: () => void;
  state: InstanceState;
}) {
  const bridge = electronBridge();
  const { showToast } = useToastHelper();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [hostName, setHostName] = useState('');
  const [hostConfig, setHostConfig] = useState<HostConfigValues>({ port: '', bind: 'lan', advertiseUrl: '' });

  const [hostUrl, setHostUrl] = useState('');
  const [probe, setProbe] = useState<{ ok: boolean; reason?: string; cluster?: { name: string } } | null>(null);

  // Re-seed from the live state every time the dialog *opens*, not just once —
  // a save that landed since the last open must not show stale values. But
  // only on the open transition: `state` gets a new identity on every stack
  // push (an executor connecting, a sidecar changing state), and re-running
  // this body then would overwrite whatever the person is mid-typing with the
  // previously-saved values. The ref lets the effect read the *current* state
  // at open time without depending on it.
  const stateRef = useRef(state);
  stateRef.current = state;
  useEffect(() => {
    if (!open) return;
    const state = stateRef.current;
    setError(null);
    if (state.mode === 'client') {
      setHostUrl(state.apiBaseUrl ?? '');
      setProbe(null);
    } else {
      setHostName(state.host?.name ?? '');
      setHostConfig({
        port: String(state.host?.port ?? state.defaultPort),
        bind: state.host?.bind ?? 'lan',
        advertiseUrl: state.host?.advertiseUrl ?? '',
      });
    }
  }, [open]);

  if (!bridge) return null;

  const checkHostUrl = async () => {
    if (!hostUrl.trim()) return;
    setBusy(true);
    setProbe(await bridge.instance.probeHost(hostUrl));
    setBusy(false);
  };

  const saveHost = async () => {
    setBusy(true);
    setError(null);
    try {
      await bridge.instance.setMode({
        mode: (state.mode ?? state.storedMode) === 'solo' ? 'solo' : 'host',
        host: {
          name: hostName.trim(),
          // The *stored* port is the honest fallback for a blank or garbled
          // entry, not the default: an admin editing only the public address
          // on a host running on 4177 must not be silently rebound to 4100 —
          // every LAN client has 4177 written down.
          port: Number(hostConfig.port) || (state.host?.port ?? state.defaultPort),
          bind: hostConfig.bind,
          // Sent unconditionally: buildConfig reads an *omitted* key as "keep
          // the previous value", so an empty field could never clear a stored
          // public address. normalizeAdvertiseUrl('') is what clears it.
          advertiseUrl: hostConfig.advertiseUrl.trim(),
        },
      });
      showToast('Server restarted');
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const saveClient = async () => {
    setBusy(true);
    setError(null);
    try {
      await bridge.instance.setMode({ mode: 'client', client: { hostUrl } });
      showToast('Connected');
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal isOpen={open} onClose={onClose} size="md">
      <ModalBackdrop />
      <ModalContent testID="settings.server.dialog" className="max-h-[85%]">
        <ModalHeader>
          <Heading size="sm">Server settings</Heading>
          <ModalCloseButton>
            <Icon as={CloseIcon} />
          </ModalCloseButton>
        </ModalHeader>
        <ModalBody scrollEnabled>
          <VStack space="lg">
            {error && (
              <Text testID="settings.server.error" size="sm" className="text-destructive">
                {error}
              </Text>
            )}

            {state.mode === 'client' ? (
              <VStack space="md">
                <VStack space="xs">
                  <Text size="sm" className="text-muted-foreground">Host address</Text>
                  <Input className="h-12">
                    <InputField
                      testID="settings.server.client.url"
                      value={hostUrl}
                      onChangeText={(v) => { setHostUrl(v); setProbe(null); }}
                      autoCapitalize="none"
                      onSubmitEditing={() => { void checkHostUrl(); }}
                    />
                  </Input>
                </VStack>

                {probe && !probe.ok && (
                  <Text testID="settings.server.client.error" size="sm" className="text-destructive">
                    Couldn&apos;t reach a Loxaic there: {probe.reason}
                  </Text>
                )}
                {probe?.ok && (
                  <Text testID="settings.server.client.found" size="sm" className="text-muted-foreground">
                    Found {probe.cluster?.name ?? 'a Loxaic host'}.
                  </Text>
                )}
              </VStack>
            ) : (
              <VStack space="md">
                <VStack space="xs">
                  <Text size="sm" className="text-muted-foreground">
                    Host name — shown against this machine&apos;s models
                  </Text>
                  <Input className="h-12">
                    <InputField testID="settings.server.name" value={hostName} onChangeText={setHostName} />
                  </Input>
                </VStack>

                <HostConfigFields defaultPort={state.defaultPort}
                  testIDPrefix="settings.server"
                  values={hostConfig}
                  onChange={setHostConfig}
                  lanAddress={state.lanAddress}
                  fields={state.mode === 'solo' ? ['port'] : ['port', 'bind', 'advertiseUrl']}
                />
              </VStack>
            )}
          </VStack>
        </ModalBody>
        <ModalFooter className="justify-end">
          <HStack space="sm">
            <Button variant="outline" size="sm" isDisabled={busy} onPress={onClose}>
              <ButtonText>Cancel</ButtonText>
            </Button>
            {state.mode === 'client' ? (
              probe?.ok ? (
                <Button testID="settings.server.save" size="sm" isDisabled={busy} onPress={() => { void saveClient(); }}>
                  {busy ? <ButtonSpinner /> : <ButtonText>Connect</ButtonText>}
                </Button>
              ) : (
                <Button
                  testID="settings.server.client.check"
                  size="sm"
                  isDisabled={busy || !hostUrl.trim()}
                  onPress={() => { void checkHostUrl(); }}
                >
                  {busy ? <ButtonSpinner /> : <ButtonText>Check</ButtonText>}
                </Button>
              )
            ) : (
              <Button
                testID="settings.server.save"
                size="sm"
                isDisabled={busy || !hostName.trim()}
                onPress={() => { void saveHost(); }}
              >
                {busy ? <ButtonSpinner /> : <ButtonText>Save</ButtonText>}
              </Button>
            )}
          </HStack>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
