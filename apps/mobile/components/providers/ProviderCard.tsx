import { Plug, Pencil, Trash2, CircleCheck, CircleAlert, KeyRound, ListFilter } from 'lucide-react-native';
import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { Text } from '@/components/ui/text';
import { Pressable } from '@/components/ui/pressable';
import { Icon } from '@/components/ui/icon';
import { Switch } from '@/components/ui/switch';
import { Spinner } from '@/components/ui/spinner';
import { TRUNCATE_TEXT } from '@/lib/truncate';
import type { InferenceProvider } from '@loxaic/api-client';

function statusLine(provider: InferenceProvider): { text: string; error: boolean } {
  if (provider.lastError) return { text: provider.lastError, error: true };
  if (provider.lastCheckedAt) {
    return { text: `Reachable ${new Date(provider.lastCheckedAt).toLocaleString()}`, error: false };
  }
  return { text: 'Not checked yet — run Test', error: false };
}

interface ProviderCardProps {
  provider: InferenceProvider;
  testing?: boolean;
  onToggle: (enabled: boolean) => void;
  onTest: () => void;
  onEdit: () => void;
  onDelete: () => void;
}

export function ProviderCard({ provider, testing, onToggle, onTest, onEdit, onDelete }: ProviderCardProps) {
  const status = statusLine(provider);
  const allowed = provider.modelAllowlist?.length ?? 0;

  return (
    <Box testID={`providers.row.${provider.id}`} className="rounded-md border border-border bg-card p-3">
      <HStack className="items-start justify-between">
        {/* Both halves: the label shrinks and truncates, and the switch beside
            it does not. Without them a long name grows past its share of the
            row and sits on top of the control. */}
        <Pressable onPress={onEdit} className="min-w-0 flex-1 shrink pr-2">
          <HStack space="xs" className="items-center">
            <Text
              testID={`providers.name.${provider.id}`}
              className="font-medium text-foreground"
              numberOfLines={1}
              style={TRUNCATE_TEXT}
            >
              {provider.name}
            </Text>
            {provider.preset && (
              <Text size="2xs" className="shrink-0 rounded-full bg-primary/15 px-2 py-0.5 text-primary">
                {provider.preset}
              </Text>
            )}
          </HStack>
          <Text size="xs" className="mt-0.5 text-muted-foreground" numberOfLines={1} style={TRUNCATE_TEXT}>
            {provider.baseUrl}
          </Text>
        </Pressable>
        <Switch
          testID={`providers.toggle.${provider.id}`}
          value={provider.enabled}
          onValueChange={onToggle}
        />
      </HStack>

      <HStack space="xs" className="mt-2 items-center">
        <HStack space="xs" className="shrink-0 items-center rounded-full bg-muted px-2 py-0.5">
          <Icon as={KeyRound} size="2xs" className="text-muted-foreground" />
          <Text size="2xs" className="text-muted-foreground">
            {/* Whether there is a key, never the key — no route returns one,
                so this is all a client can ever know. */}
            {provider.hasApiKey ? 'key set' : 'no key'}
          </Text>
        </HStack>
        <HStack space="xs" className="shrink-0 items-center rounded-full bg-muted px-2 py-0.5">
          <Icon as={ListFilter} size="2xs" className="text-muted-foreground" />
          <Text size="2xs" className="text-muted-foreground">
            {allowed > 0 ? `${String(allowed)} model${allowed === 1 ? '' : 's'}` : 'all models'}
          </Text>
        </HStack>
        <HStack space="xs" className="min-w-0 flex-1 items-center">
          <Icon
            as={status.error ? CircleAlert : CircleCheck}
            size="2xs"
            className={status.error ? 'text-destructive' : 'text-muted-foreground'}
          />
          <Text
            testID={`providers.status.${provider.id}`}
            size="2xs"
            className={`min-w-0 flex-1 ${status.error ? 'text-destructive' : 'text-muted-foreground'}`}
            numberOfLines={1}
            style={TRUNCATE_TEXT}
          >
            {status.text}
          </Text>
        </HStack>
      </HStack>

      <HStack space="md" className="mt-3 items-center justify-end border-t border-border pt-2">
        <Pressable
          testID={`providers.test.${provider.id}`}
          onPress={onTest}
          disabled={testing}
          className="flex-row items-center gap-1 p-1"
        >
          {testing ? <Spinner size="small" /> : <Icon as={Plug} size="xs" className="text-muted-foreground" />}
          <Text size="xs" className="text-muted-foreground">
            Test
          </Text>
        </Pressable>
        <Pressable testID={`providers.edit.${provider.id}`} onPress={onEdit} className="p-1">
          <Icon as={Pencil} size="xs" className="text-muted-foreground" />
        </Pressable>
        <Pressable testID={`providers.delete.${provider.id}`} onPress={onDelete} className="p-1">
          <Icon as={Trash2} size="xs" className="text-destructive" />
        </Pressable>
      </HStack>
    </Box>
  );
}
