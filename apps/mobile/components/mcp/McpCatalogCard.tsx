import { useState } from 'react';
import { Sparkles } from 'lucide-react-native';
import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { VStack } from '@/components/ui/vstack';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { Input, InputField } from '@/components/ui/input';
import { Button, ButtonText, ButtonSpinner } from '@/components/ui/button';
import type { McpCatalogEntry, McpServerInput } from '@shannon/api-client';

interface McpCatalogCardProps {
  entry: McpCatalogEntry;
  onEnable: (input: McpServerInput) => Promise<unknown>;
}

/** A built-in server the user hasn't configured yet: credentials in, one tap. */
export function McpCatalogCard({ entry, onEnable }: McpCatalogCardProps) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const complete = entry.secretKeys.every((k) => (values[k.env] ?? '').trim().length > 0);

  const handleEnable = async () => {
    setSaving(true);
    setError(null);
    try {
      const secrets: Record<string, string> = {};
      for (const k of entry.secretKeys) secrets[k.env] = values[k.env].trim();
      await onEnable({ builtinKey: entry.key, secrets });
    } catch {
      setError(`Failed to enable ${entry.name}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Box className="rounded-md border border-border bg-card p-3">
      <HStack space="xs" className="items-center">
        <Icon as={Sparkles} size="xs" className="text-primary" />
        <Text className="font-medium text-foreground">{entry.name}</Text>
        <Text size="2xs" className="rounded-full bg-primary/15 px-2 py-0.5 text-primary">
          built-in
        </Text>
      </HStack>
      <Text size="xs" className="mt-1 text-muted-foreground">
        {entry.description}
      </Text>

      <VStack space="xs" className="mt-3">
        {entry.secretKeys.map((k) => (
          <VStack key={k.env} space="xs">
            <Text size="xs" className="text-muted-foreground">
              {k.label}
            </Text>
            <Input className="border-border bg-background">
              <InputField
                value={values[k.env] ?? ''}
                onChangeText={(v) => setValues((prev) => ({ ...prev, [k.env]: v }))}
                placeholder={k.env}
                autoCapitalize="none"
                autoCorrect={false}
                secureTextEntry
              />
            </Input>
          </VStack>
        ))}
        {error && (
          <Text size="xs" className="text-destructive">
            {error}
          </Text>
        )}
        <Button
          size="sm"
          className="mt-1 self-start bg-primary"
          onPress={handleEnable}
          isDisabled={!complete || saving}
        >
          {saving && <ButtonSpinner />}
          <ButtonText className="text-primary-foreground">Enable {entry.name}</ButtonText>
        </Button>
      </VStack>
    </Box>
  );
}
