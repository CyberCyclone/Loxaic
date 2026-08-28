import { useState } from 'react';
import { ScrollView } from 'react-native';
import { Copy, Check } from 'lucide-react-native';
import * as Clipboard from 'expo-clipboard';
import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { Text } from '@/components/ui/text';
import { Pressable } from '@/components/ui/pressable';
import { Icon } from '@/components/ui/icon';

interface CodeBlockProps {
  code: string;
  lang?: string;
}

// No syntax highlighting in the source design either — just a monospace pane
// with a copy button. Horizontal ScrollView replaces web's overflow-x:auto.
export function CodeBlock({ code, lang }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    await Clipboard.setStringAsync(code);
    setCopied(true);
    setTimeout(() => { setCopied(false); }, 1500);
  };

  return (
    <Box className="my-2 overflow-hidden rounded-md border border-border bg-code">
      <HStack className="items-center justify-between border-b border-border px-3 py-1.5">
        <Text size="xs" className="text-muted-foreground">
          {lang ?? 'code'}
        </Text>
        <Pressable onPress={() => { void copy(); }} className="flex-row items-center gap-1 p-1">
          <Icon as={copied ? Check : Copy} size="xs" className="text-muted-foreground" />
          {copied && (
            <Text size="xs" className="text-muted-foreground">
              Copied
            </Text>
          )}
        </Pressable>
      </HStack>
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        {/* Size/leading via classes: on web this Text is a raw <span>, where a
            numeric inline lineHeight is a unitless multiplier, not px. */}
        <Text
          className="p-3 text-card-foreground text-[13px] leading-[19.5px]"
          style={{ fontFamily: 'monospace' }}
        >
          {code}
        </Text>
      </ScrollView>
    </Box>
  );
}
