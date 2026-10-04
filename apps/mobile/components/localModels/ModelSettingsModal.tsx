import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  estimateLocalModel,
  getHfMtpHeads,
  type ContextStagesConfig,
  type FitEstimate,
  type HfMtpHead,
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
import { ContextStagesEditor } from './ContextStagesEditor';
import { MtpSection } from './MtpSection';
import { LookupTableSection } from './LookupTableSection';
import { PlacementBar } from './PlacementBar';
import { mtpPanel, mtpParallelWarning, showsMtp, wantsRepoHeads, withMtp } from '@/lib/mtp';
import {
  EMPTY_STAGES,
  GROUP_ORDER,
  GROUP_TITLES,
  configFromDraft,
  describeFit,
  draftFromConfig,
  parseNumericInput,
  setDraft,
  specMax,
  standardCtx,
  stageErrors,
  type StagesDraft,
} from '@/lib/localModels';
import { useServerReachable } from '@/lib/connection';
import { DisconnectedNote } from '@/components/shell/DisconnectedNote';
import { TRUNCATE_TEXT } from '@/lib/truncate';

interface ModelSettingsModalProps {
  model: LocalModel | null;
  /** The same model as the screen last polled it: what changes on the server
   * while the sheet is open — a head downloading — is read from here, never
   * from `model`, which is a snapshot so the draft is not reset each poll. */
  live?: LocalModel | null;
  onDownloadHead?: (id: string, path: string) => void;
  onRemoveHead?: (id: string) => void;
  specs: LoadSettingSpec[];
  /** This host's RAM, for settings that put part of a model there. */
  hostMemory?: { totalBytes: number; freeBytes: number };
  onClose: () => void;
  onSave: (
    id: string,
    patch: { loadSettings: LoadSettings; displayName: string; contextStages: ContextStagesConfig | null },
  ) => Promise<LocalModel | null>;
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
export function ModelSettingsModal({ model, live, specs, hostMemory, onClose, onSave, onDownloadHead, onRemoveHead }: ModelSettingsModalProps) {
  const [draft, setDraftState] = useState<LoadSettings>({});
  const [text, setText] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  // Advice rather than errors: a value that works but that the admin should
  // know about (a context past what the model was trained for). Never blocks Save.
  const [warnings, setWarnings] = useState<Record<string, string>>({});
  const [stagesDraft, setStagesDraft] = useState<StagesDraft>(EMPTY_STAGES);
  const [stageFits, setStageFits] = useState<FitEstimate[]>([]);
  const [name, setName] = useState('');
  const [fit, setFit] = useState<FitEstimate | null>(null);
  const [saving, setSaving] = useState(false);
  const reachable = useServerReachable();
  const [notice, setNotice] = useState<string | null>(null);
  const estimateSeq = useRef(0);
  // The repository's MTP heads, for a model with none of its own: null while
  // asking, 'error' when HuggingFace could not be asked.
  // Kept with the model it answers for: the sheet stays mounted between
  // models, and another model's answer must not show for a frame as this one's.
  const [headsAnswer, setHeadsAnswer] = useState<{ id: string; heads: HfMtpHead[] | 'error' } | null>(null);
  // Bumped by Retry, after the repository could not be asked.
  const [headsAsk, setHeadsAsk] = useState(0);
  const current = live && live.id === model?.id ? live : model;
  const needsHeads = current ? wantsRepoHeads(current) : false;
  const repoHeads = headsAnswer && headsAnswer.id === model?.id ? headsAnswer.heads : null;

  useEffect(() => {
    // Closing forgets the answer too, so reopening asks afresh from the first
    // frame rather than showing the last answer while the new one comes.
    if (!model) setHeadsAnswer(null);
    if (!model || !needsHeads) return;
    let cancelled = false;
    setHeadsAnswer(null);
    getHfMtpHeads(model.repo)
      .then((d) => { if (!cancelled) setHeadsAnswer({ id: model.id, heads: d.mtpHeads }); })
      .catch(() => { if (!cancelled) setHeadsAnswer({ id: model.id, heads: 'error' }); });
    return () => { cancelled = true; };
  }, [model, needsHeads, headsAsk]);

  useEffect(() => {
    if (!model) return;
    setDraftState(model.loadSettings);
    setText(Object.fromEntries(Object.entries(model.loadSettings).map(([k, v]) => [k, typeof v === 'number' ? String(v) : ''])));
    setErrors({});
    setWarnings({});
    setStagesDraft(draftFromConfig(model.contextStages));
    setStageFits([]);
    setName(model.displayName);
    setFit(model.fit);
    setNotice(null);
  }, [model]);

  // What the stage editor is judged against.
  const standard = model ? standardCtx(draft, model.meta) : null;
  const stageProblems = model ? stageErrors(stagesDraft, standard, model.meta) : [];
  const stagesInvalid = stagesDraft.enabled && stageProblems.some((p) => p !== null);

  // The live estimate: debounced, and only the newest answer lands.
  useEffect(() => {
    if (!model) return;
    const mine = ++estimateSeq.current;
    const timer = setTimeout(() => {
      // The draft stages are priced too, but only once they are sound: an
      // estimate of a stage smaller than standard would be refused.
      const staged = stagesDraft.enabled && !stagesInvalid && stagesDraft.stages.length > 0 ? configFromDraft(stagesDraft) : null;
      estimateLocalModel(model.id, draft, staged)
        .then((r) => {
          if (mine !== estimateSeq.current) return;
          setFit(r.fit);
          setStageFits(r.stages ?? []);
        })
        .catch(() => undefined);
    }, ESTIMATE_DEBOUNCE_MS);
    return () => { clearTimeout(timer); };
    // stagesInvalid is derived from the two drafts already listed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, stagesDraft, model]);

  if (!model || !current) return null;

  const panel = mtpPanel(current, repoHeads);
  const visible = specs.filter((s) => {
    if (s.key === 'cpuMoeLayers') return Boolean(model.meta.expertCount);
    if (s.key === 'vision') return model.hasVision;
    if (s.key === 'mtp') return showsMtp(panel);
    if (s.key === 'mtpDraftMax') return showsMtp(panel) && draft.mtp === true;
    if (s.key === 'tablePlacement') return Boolean(model.meta.lookupTable);
    return true;
  });
  const mtpWarning = mtpParallelWarning(draft);

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
    setWarnings((w) => {
      if (parsed.warning) return { ...w, [spec.key]: parsed.warning };
      const next = { ...w };
      Reflect.deleteProperty(next, spec.key);
      return next;
    });
    choose(spec.key, parsed.value);
  };

  const hasErrors = Object.keys(errors).length > 0 || stagesInvalid;

  const save = async () => {
    setSaving(true);
    try {
      const updated = await onSave(model.id, {
        loadSettings: draft,
        displayName: name.trim() || model.displayName,
        contextStages: configFromDraft(stagesDraft),
      });
      if (!updated) return;
      if (updated.appliesOnNextLoad) {
        setNotice('Saved. It is answering someone right now, and reloads with the new settings as soon as that reply ends.');
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
        {/* A drag on the sheet puts the keyboard away: the number fields open
            iOS's number pad, which has no key that does. Without it the pad
            covered Save for good. */}
        <ModalBody scrollEnabled keyboardDismissMode="on-drag" keyboardShouldPersistTaps="handled">
          <VStack space="lg">
            <HStack testID="localModels.settingsSheet.estimate" space="sm" className="items-center rounded-md bg-muted/50 p-2">
              {fit && <FitBadge label={fit.label} testID="localModels.settingsSheet.fit" />}
              <Text size="xs" className="min-w-0 flex-1 text-muted-foreground">
                {fit ? describeFit(fit) : 'Estimating…'}
              </Text>
            </HStack>

            {current.runtimeStatus === 'loaded' && current.placement && (
              <VStack space="xs">
                <Text size="sm" className="font-medium text-foreground">
                  Where it is now
                </Text>
                <PlacementBar placement={current.placement} testID="localModels.settingsSheet.placement" detailed />
              </VStack>
            )}

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
                  {inGroup.map((spec) =>
                    spec.key === 'mtp' ? (
                      <MtpSection
                        key={spec.key}
                        panel={panel}
                        on={draft.mtp === true}
                        help={spec.help}
                        reachable={reachable}
                        onToggle={(on) => {
                          setDraftState((d) => withMtp(d, on));
                          if (!on) {
                            setText((t) => ({ ...t, mtpDraftMax: '' }));
                            setErrors((e) => {
                              const next = { ...e };
                              Reflect.deleteProperty(next, 'mtpDraftMax');
                              return next;
                            });
                          }
                        }}
                        onDownloadHead={(path) => { onDownloadHead?.(model.id, path); }}
                        onRetryHeads={() => { setHeadsAsk((n) => n + 1); }}
                        onRemoveHead={() => {
                          // The server turns MTP off with the head; the draft follows.
                          if (!current.meta.mtp) setDraftState((d) => withMtp(d, false));
                          onRemoveHead?.(model.id);
                        }}
                      />
                    ) : spec.key === 'tablePlacement' && model.meta.lookupTable ? (
                      <LookupTableSection
                        key={spec.key}
                        value={draft.tablePlacement}
                        tableBytes={model.meta.lookupTable.bytes}
                        help={spec.help}
                        host={hostMemory}
                        onChoose={(v) => { choose('tablePlacement', v); }}
                      />
                    ) : (
                    <SettingControl
                      key={spec.key}
                      spec={spec}
                      value={draft[spec.key]}
                      text={text[spec.key] ?? ''}
                      error={errors[spec.key] ?? null}
                      warning={warnings[spec.key] ?? null}
                      max={specMax(spec, model.meta)}
                      onChoose={(v) => { choose(spec.key, v); }}
                      onType={(raw) => { typeNumber(spec, raw); }}
                    />
                    ),
                  )}
                  {group === 'speculative' && mtpWarning && (
                    <Text testID="localModels.mtp.warning" size="2xs" className="text-warning">
                      {mtpWarning}
                    </Text>
                  )}
                  {group === 'context' && (
                    <ContextStagesEditor
                      draft={stagesDraft}
                      onChange={setStagesDraft}
                      standard={standard}
                      meta={model.meta}
                      fits={stageFits}
                      errors={stageProblems}
                    />
                  )}
                </VStack>
              );
            })}
          </VStack>
        </ModalBody>
        <ModalFooter className="flex-col items-stretch gap-2">
          <DisconnectedNote testID="localModels.settingsSheet.disconnected" what="save" />
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
              isDisabled={saving || hasErrors || !reachable}
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
  warning: string | null;
  max: number | null;
  onChoose: (value: LoadSettings[string] | null) => void;
  onType: (raw: string) => void;
}

function SettingControl({ spec, value, text, error, warning, max, onChoose, onType }: SettingControlProps) {
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
                : max !== null && spec.softMax
                  ? `${String(spec.min ?? 0)}+ · trained for ${String(max)}`
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
      ) : warning ? (
        <Text testID={`${id}.warning`} size="2xs" className="text-warning">
          {warning}
        </Text>
      ) : (
        <Text size="2xs" className="text-muted-foreground">
          {spec.help}
        </Text>
      )}
    </VStack>
  );
}
