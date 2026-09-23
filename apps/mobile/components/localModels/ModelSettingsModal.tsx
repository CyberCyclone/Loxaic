import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  estimateLocalModel,
  type FitEstimate,
  type LoadSettingSpec,
  type LoadSettings,
  type LocalModel,
} from '@loxaic/api-client';
import {
  Modal,
  ModalBackdrop,
  ModalBody,
  ModalCloseButton,
  ModalContent,
  ModalFooter,
  ModalHeader,
} from '@/components/ui/modal';
import { HStack } from '@/components/ui/hstack';
import { VStack } from '@/components/ui/vstack';
import { Text } from '@/components/ui/text';
import { Heading } from '@/components/ui/heading';
import { Icon, CloseIcon } from '@/components/ui/icon';
import { Input, InputField } from '@/components/ui/input';
import { Button, ButtonText } from '@/components/ui/button';
import { PresetChips } from '@/components/settings/PresetChips';
import { FitBadge } from './FitBadge';
import { GROUP_ORDER, GROUP_TITLES, formatBytes, parseNumericInput, setDraft, specMax } from '@/lib/localModels';
import { TRUNCATE_TEXT } from '@/lib/truncate';

interface ModelSettingsModalProps {
  model: LocalModel | null;
  specs: LoadSettingSpec[];
  onClose: () => void;
  onSave: (id: string, patch: { loadSettings: LoadSettings; displayName: string }) => Promise<LocalModel | null>;
}

const ESTIMATE_DEBOUNCE_MS = 400;

/**
 * Everything LM Studio lets you set when loading a model, set once by an admin
 * and kept: whenever this model loads, for anyone, it loads with these.
 *
 * The controls come from the server's own spec (ranges, words, help), so the
 * client never has a second copy of what a valid value is. Blank means
 * "llama.cpp's default". A live estimate at the top says whether the model will
 * still fit with what has been chosen.
 */
export function ModelSettingsModal({ model, specs, onClose, onSave }: ModelSettingsModalProps) {
  const [draft, setDraftState] = useState<LoadSettings>({});
  const [text, setText] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [name, setName] = useState('');
  const [fit, setFit] = useState<FitEstimate | null>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const estimateSeq = useRef(0);

  useEffect(() => {
    if (!model) return;
    setDraftState(model.loadSettings);
    setText(Object.fromEntries(Object.entries(model.loadSettings).map(([k, v]) => [k, typeof v === 'number' ? String(v) : ''])));
    setErrors({});
    setName(model.displayName);
    setFit(model.fit);
    setNotice(null);
  }, [model]);

  // The live estimate: debounced, and only the newest answer lands.
  useEffect(() => {
    if (!model) return;
    const mine = ++estimateSeq.current;
    const timer = setTimeout(() => {
      estimateLocalModel(model.id, draft)
        .then((r) => { if (mine === estimateSeq.current) setFit(r.fit); })
        .catch(() => undefined);
    }, ESTIMATE_DEBOUNCE_MS);
    return () => { clearTimeout(timer); };
  }, [draft, model]);

  if (!model) return null;

  const visible = specs.filter((s) => {
    if (s.key === 'cpuMoeLayers') return Boolean(model.meta.expertCount);
    if (s.key === 'vision') return model.hasVision;
    return true;
  });

  const choose = (key: string, value: LoadSettings[string] | null) => {
    setDraftState((d) => setDraft(d, key, value ?? null));
  };

  const typeNumber = (spec: LoadSettingSpec, raw: string) => {
    setText((t) => ({ ...t, [spec.key]: raw }));
    const parsed = parseNumericInput(spec, raw, model.meta);
    if ('error' in parsed) {
      setErrors((e) => ({ ...e, [spec.key]: parsed.error }));
      return;
    }
    setErrors((e) => {
      const next = { ...e };
      Reflect.deleteProperty(next, spec.key);
      return next;
    });
    choose(spec.key, parsed.value);
  };

  const hasErrors = Object.keys(errors).length > 0;

  const save = async () => {
    setSaving(true);
    try {
      const updated = await onSave(model.id, { loadSettings: draft, displayName: name.trim() || model.displayName });
      if (!updated) return;
      if (updated.appliesOnNextLoad) {
        setNotice('Saved. This model is answering someone right now, so the new settings apply the next time it loads.');
      } else onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal isOpen onClose={onClose} size="lg">
      <ModalBackdrop />
      {/* Both halves (see AGENTS.md): twenty-odd settings are far past any fold. */}
      <ModalContent testID="localModels.settingsSheet" className="max-h-[85%]">
        <ModalHeader>
          <VStack className="min-w-0 flex-1 shrink pr-2">
            <Heading size="sm" numberOfLines={1} style={TRUNCATE_TEXT}>
              {model.displayName}
            </Heading>
            <Text size="xs" className="text-muted-foreground">
              Loads with these settings for everyone
            </Text>
          </VStack>
          <ModalCloseButton testID="localModels.settingsSheet.close">
            <Icon as={CloseIcon} />
          </ModalCloseButton>
        </ModalHeader>
        <ModalBody scrollEnabled>
          <VStack space="lg">
            <HStack testID="localModels.settingsSheet.estimate" space="sm" className="items-center rounded-md bg-muted/50 p-2">
              {fit && <FitBadge label={fit.label} testID="localModels.settingsSheet.fit" />}
              <Text size="xs" className="min-w-0 flex-1 text-muted-foreground">
                {fit
                  ? `Needs about ${formatBytes(fit.requiredBytes)}${fit.availableBytes ? ` of ${formatBytes(fit.availableBytes)} ${fit.target === 'cpu' ? 'RAM' : 'GPU memory'}` : ''}`
                  : 'Estimating…'}
              </Text>
            </HStack>

            <VStack space="xs">
              <Text size="xs" className="text-muted-foreground">
                Name in the picker
              </Text>
              <Input>
                <InputField testID="localModels.setting.displayName" value={name} onChangeText={setName} />
              </Input>
            </VStack>

            {GROUP_ORDER.map((group) => {
              const inGroup = visible.filter((s) => s.group === group);
              if (inGroup.length === 0) return null;
              return (
                <VStack key={group} space="md">
                  <Text size="sm" className="font-medium text-foreground">
                    {GROUP_TITLES[group]}
                  </Text>
                  {inGroup.map((spec) => (
                    <SettingControl
                      key={spec.key}
                      spec={spec}
                      value={draft[spec.key]}
                      text={text[spec.key] ?? ''}
                      error={errors[spec.key] ?? null}
                      max={specMax(spec, model.meta)}
                      onChoose={(v) => { choose(spec.key, v); }}
                      onType={(raw) => { typeNumber(spec, raw); }}
                    />
                  ))}
                </VStack>
              );
            })}
          </VStack>
        </ModalBody>
        <ModalFooter className="flex-col items-stretch gap-2">
          {notice && (
            <Text testID="localModels.settingsSheet.notice" size="xs" className="text-muted-foreground">
              {notice}
            </Text>
          )}
          <HStack space="sm" className="justify-between">
            <Button
              testID="localModels.settingsSheet.reset"
              variant="outline"
              size="sm"
              onPress={() => {
                setDraftState({});
                setText({});
                setErrors({});
              }}
            >
              <ButtonText>Reset to defaults</ButtonText>
            </Button>
            <Button
              testID="localModels.settingsSheet.save"
              size="sm"
              className="bg-primary"
              isDisabled={saving || hasErrors}
              onPress={() => { void save(); }}
            >
              <ButtonText className="text-primary-foreground">{saving ? 'Saving…' : 'Save'}</ButtonText>
            </Button>
          </HStack>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}

interface SettingControlProps {
  spec: LoadSettingSpec;
  value: LoadSettings[string];
  text: string;
  error: string | null;
  max: number | null;
  onChoose: (value: LoadSettings[string] | null) => void;
  onType: (raw: string) => void;
}

function SettingControl({ spec, value, text, error, max, onChoose, onType }: SettingControlProps) {
  const id = `localModels.setting.${spec.key}`;
  let control: ReactNode;
  if (spec.type === 'bool') {
    control = (
      <PresetChips
        chips={[
          { value: 'default', label: 'Default', key: 'default' },
          { value: 'on', label: 'On', key: 'on' },
          { value: 'off', label: 'Off', key: 'off' },
        ]}
        value={value === undefined ? 'default' : value ? 'on' : 'off'}
        onChoose={(v) => { onChoose(v === 'default' ? null : v === 'on'); }}
        testIDPrefix={id}
      />
    );
  } else if (spec.type === 'enum') {
    control = (
      <PresetChips
        chips={[
          { value: '', label: 'Default', key: 'default' },
          ...(spec.values ?? []).map((v) => ({ value: v, label: v, key: v })),
        ]}
        value={typeof value === 'string' ? value : ''}
        onChoose={(v) => { onChoose(v === '' ? null : v); }}
        testIDPrefix={id}
      />
    );
  } else {
    const words = spec.words ?? [];
    control = (
      <VStack space="xs">
        {words.length > 0 && (
          <PresetChips
            chips={[
              { value: '', label: 'Default', key: 'default' },
              ...words.filter((w) => w !== 'auto').map((w) => ({ value: w, label: w === 'all' ? 'All on GPU' : w, key: w })),
              { value: 'number', label: 'Set a number', key: 'number' },
            ]}
            value={typeof value === 'string' ? value : typeof value === 'number' ? 'number' : ''}
            onChoose={(v) => {
              if (v === 'number') onType(text || String(max ?? 0));
              else onChoose(v === '' ? null : v);
            }}
            testIDPrefix={id}
          />
        )}
        {(words.length === 0 || typeof value === 'number') && (
          <HStack space="sm" className="items-center">
            <Input className="w-32">
              <InputField
                testID={`${id}.input`}
                value={typeof value === 'number' ? text || String(value) : text}
                onChangeText={onType}
                placeholder="Default"
                keyboardType={spec.type === 'int' ? 'number-pad' : 'decimal-pad'}
                inputMode={spec.type === 'int' ? 'numeric' : 'decimal'}
              />
            </Input>
            <Text size="2xs" className="text-muted-foreground">
              {spec.key === 'gpuLayers' && max !== null
                ? `of ${String(max)} layers on the GPU`
                : max !== null
                  ? `${String(spec.min ?? 0)}–${String(max)}`
                  : spec.min !== undefined
                    ? `from ${String(spec.min)}`
                    : ''}
            </Text>
          </HStack>
        )}
      </VStack>
    );
  }
  return (
    <VStack space="xs">
      <Text size="sm" className="text-foreground">
        {spec.label}
      </Text>
      {control}
      {error ? (
        <Text testID={`${id}.error`} size="2xs" className="text-destructive">
          {error}
        </Text>
      ) : (
        <Text size="2xs" className="text-muted-foreground">
          {spec.help}
        </Text>
      )}
    </VStack>
  );
}
