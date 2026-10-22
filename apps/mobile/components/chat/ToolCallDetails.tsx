import { ScrollView } from 'react-native';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import { toolDetailFields } from '@/lib/toolDetails';
import { WRAP_ANYWHERE } from '@/lib/truncate';

/** How tall one argument grows inside a transcript card before it scrolls. */
export const CARD_VALUE_MAX_HEIGHT = 200;

interface ToolCallDetailsProps {
  tool: string;
  args: Record<string, unknown> | undefined;
  /** Each value's testID, from the argument's name. */
  argTestID?: (key: string) => string;
  /** In a transcript card each value scrolls past a height; in a sheet the
   * sheet's body is what scrolls, so values grow. */
  capped?: boolean;
}

/**
 * Every argument of a tool call, in full (#267): what the card shows while a
 * call runs and what the approval sheet shows before it does.
 *
 * The line height is a class, never an inline number: on web this `Text` is a
 * `<span>`, where `lineHeight: 18` means 18 × the font size — taller than the
 * box, which is how the result body came to show one line, centred and cut.
 */
export function ToolCallDetails({ tool, args, argTestID, capped = false }: ToolCallDetailsProps) {
  const fields = toolDetailFields(tool, args);
  if (fields.length === 0) {
    return (
      <Text size="xs" className="text-muted-foreground">
        No arguments
      </Text>
    );
  }
  return (
    <VStack space="sm">
      {fields.map((field) => {
        const value = (
          <Text
            testID={argTestID?.(field.key)}
            selectable
            className={`text-[12px] leading-[18px] text-foreground ${field.mono ? 'font-mono' : ''}`}
            style={WRAP_ANYWHERE}
          >
            {field.value}
          </Text>
        );
        return (
          <VStack key={field.key} space="xs" className="min-w-0">
            <Text size="2xs" className="uppercase text-muted-foreground">
              {field.label}
            </Text>
            {capped ? (
              <ScrollView style={{ maxHeight: CARD_VALUE_MAX_HEIGHT }} nestedScrollEnabled>
                {value}
              </ScrollView>
            ) : (
              value
            )}
            {field.more > 0 ? (
              <Text
                testID={argTestID ? `${argTestID(field.key)}.more` : undefined}
                size="2xs"
                className="text-warning"
              >
                {`… and ${field.more.toLocaleString()} more characters, not shown`}
              </Text>
            ) : null}
          </VStack>
        );
      })}
    </VStack>
  );
}
