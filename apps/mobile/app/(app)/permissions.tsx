import { useCallback, useEffect, useState } from 'react';
import { ScrollView } from 'react-native';
import { Box } from '@/components/ui/box';
import { VStack } from '@/components/ui/vstack';
import { HStack } from '@/components/ui/hstack';
import { Text } from '@/components/ui/text';
import { Spinner } from '@/components/ui/spinner';
import { Pressable } from '@/components/ui/pressable';
import { Button, ButtonText } from '@/components/ui/button';
import { Input, InputField } from '@/components/ui/input';
import { MainHeader } from '@/components/shell/MainHeader';
import { useShell } from '@/components/shell/AppShell';
import { describeRequestError, useServerReachable } from '@/lib/connection';
import { useToastHelper } from '@/hooks/useToastHelper';
import {
  addCommandRule,
  deleteCommandRule,
  getCommandRules,
  getPrefs,
  updatePrefs,
  type CommandRule,
} from '@loxaic/api-client';

const ACTIONS: { action: CommandRule['action']; title: string; help: string }[] = [
  { action: 'allow', title: 'Allowed', help: 'Run without asking, in every mode.' },
  { action: 'ask', title: 'Always ask', help: 'Asked about every time, even in auto mode.' },
  { action: 'deny', title: 'Denied', help: 'Never run. The agent is told your rule refused it.' },
];

/**
 * What `bash` may run without asking: the person's command rules
 * (apps/server/src/permissions/bash/rules.ts). "Allow always" on a prompt adds
 * one; this screen is where they are seen, added by hand and taken back —
 * there was no such place for the old whole-tool grant, which is part of why
 * it could not stay.
 */
export default function PermissionsScreen() {
  const shell = useShell();
  const reachable = useServerReachable();
  const { showToast } = useToastHelper();
  // null: not loaded, or could not be — kept apart from "no rules".
  const [rules, setRules] = useState<CommandRule[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [retired, setRetired] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pattern, setPattern] = useState('');
  const [action, setAction] = useState<CommandRule['action']>('allow');
  const [addError, setAddError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadFailed(false);
    try {
      const [loaded, prefs] = await Promise.all([getCommandRules(), getPrefs().catch(() => null)]);
      setRules(loaded);
      setRetired(prefs?.bashGrantRetired === true);
    } catch {
      setLoadFailed(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);
  // Asked again when the server comes back: "could not ask" is not "none".
  useEffect(() => {
    if (reachable && loadFailed) void load();
  }, [reachable, loadFailed, load]);

  const locked = busy || !reachable;

  const add = async () => {
    const trimmed = pattern.trim();
    if (!trimmed) return;
    setBusy(true);
    setAddError(null);
    try {
      setRules(await addCommandRule(trimmed, action));
      setPattern('');
    } catch (err) {
      setAddError(describeRequestError(err, 'Could not add the rule.'));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (rule: CommandRule) => {
    setBusy(true);
    try {
      setRules(await deleteCommandRule(rule.id));
    } catch (err) {
      showToast(describeRequestError(err, 'Could not remove the rule.'), 5000);
    } finally {
      setBusy(false);
    }
  };

  const dismissRetired = () => {
    setRetired(false);
    void updatePrefs({ bashGrantNoticeSeen: true }).catch(() => {
      setRetired(true);
    });
  };

  const body = () => {
    if (loadFailed && !rules) {
      return (
        <Text testID="permissions.unavailable" size="sm" className="p-4 text-muted-foreground">
          Your command rules could not be loaded. Check the connection to the server.
        </Text>
      );
    }
    if (!rules) {
      return (
        <Box className="flex-1 items-center justify-center p-6">
          <Spinner />
        </Box>
      );
    }
    return (
      <VStack space="lg" className="p-4">
        <Text size="xs" className="text-muted-foreground">
          Reading, listing and searching (ls, cat, grep, git log, gh pr view …) never ask. Anything else asks
          before it runs, unless a rule below allows it. In auto mode, a command no rule covers is checked by the
          model first wherever the workspace is not sealed off — a GitHub workspace, a folder on your machine, or
          a sandbox with the network on. A rule is words with an optional * for any arguments: `npm test`, or
          `gh pr view *`.
        </Text>

        {retired ? (
          <VStack testID="permissions.retiredNotice" space="sm" className="rounded-md border border-warning/30 bg-warning/10 p-3">
            <Text size="sm" className="text-foreground">
              Your old “Allow always” for every bash command has been replaced by per-command rules. Commands that
              change something now ask once each, and “Allow always” on that prompt adds a rule for just that
              command.
            </Text>
            <HStack className="justify-end">
              <Button testID="permissions.retiredNotice.dismiss" size="sm" variant="outline" onPress={dismissRetired}>
                <ButtonText>Got it</ButtonText>
              </Button>
            </HStack>
          </VStack>
        ) : null}

        {ACTIONS.map(({ action: kind, title, help }) => {
          const list = rules.filter((r) => r.action === kind);
          return (
            <VStack key={kind} testID={`permissions.section.${kind}`} space="xs">
              <Text size="sm" className="font-medium text-foreground">
                {title}
              </Text>
              <Text size="2xs" className="text-muted-foreground">
                {help}
              </Text>
              {list.length === 0 ? (
                <Text size="xs" className="text-muted-foreground">
                  None.
                </Text>
              ) : (
                list.map((rule) => (
                  <HStack
                    key={rule.id}
                    space="sm"
                    className="items-center justify-between rounded-md border border-border bg-card px-3 py-2"
                  >
                    <VStack className="min-w-0 shrink">
                      <Text testID={`permissions.rule.${kind}.${rule.pattern}`} size="sm" className="font-mono text-foreground">
                        {rule.pattern}
                      </Text>
                      <Text size="2xs" className="text-muted-foreground">
                        {rule.source === 'prompt' ? 'From “Allow always”' : 'Added here'}
                      </Text>
                    </VStack>
                    <Pressable
                      testID={`permissions.rule.${kind}.${rule.pattern}.remove`}
                      onPress={() => { void remove(rule); }}
                      disabled={locked}
                      className="shrink-0 rounded-md px-2 py-1 web:hover:bg-muted/50"
                    >
                      <Text size="xs" className={locked ? 'text-muted-foreground' : 'text-destructive'}>
                        Remove
                      </Text>
                    </Pressable>
                  </HStack>
                ))
              )}
            </VStack>
          );
        })}

        <VStack space="sm" className="border-t border-border pt-4">
          <Text size="sm" className="font-medium text-foreground">
            Add a rule
          </Text>
          <Input isDisabled={locked}>
            <InputField
              testID="permissions.add.pattern"
              value={pattern}
              onChangeText={(t) => {
                setPattern(t);
                setAddError(null);
              }}
              placeholder="npm run test *"
              autoCapitalize="none"
              autoCorrect={false}
              onSubmitEditing={() => { void add(); }}
            />
          </Input>
          <HStack space="xs" className="flex-wrap">
            {ACTIONS.map(({ action: kind, title }) => (
              <Pressable
                key={kind}
                testID={`permissions.add.action.${kind}`}
                aria-selected={action === kind}
                onPress={() => { setAction(kind); }}
                className={`rounded-full border px-3 py-1 ${action === kind ? 'border-primary bg-primary/15' : 'border-border'}`}
              >
                <Text size="xs" className={action === kind ? 'text-primary' : 'text-muted-foreground'}>
                  {title}
                </Text>
              </Pressable>
            ))}
          </HStack>
          {addError ? (
            <Text testID="permissions.add.error" size="xs" className="text-destructive">
              {addError}
            </Text>
          ) : null}
          <HStack className="justify-end">
            <Button testID="permissions.add.submit" size="sm" onPress={() => { void add(); }} isDisabled={locked || !pattern.trim()}>
              <ButtonText>Add rule</ButtonText>
            </Button>
          </HStack>
        </VStack>
      </VStack>
    );
  };

  return (
    <VStack className="h-full flex-1">
      <MainHeader title="Command permissions" onOpenMenu={shell.overlaySidebar ? shell.openSidebar : undefined} />
      <ScrollView testID="permissions.scroll" className="flex-1" keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets>
        {body()}
      </ScrollView>
    </VStack>
  );
}
