import { useState } from 'react';
import { ScrollView } from 'react-native';
import {
  ChevronRight,
  FileText,
  FilePen,
  FileEdit,
  Terminal,
  Search,
  FolderSearch,
  Globe,
  ListTodo,
  HelpCircle,
  Plug,
} from 'lucide-react-native';
import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { Text } from '@/components/ui/text';
import { Pressable } from '@/components/ui/pressable';
import { Icon } from '@/components/ui/icon';
import type { ToolCall } from '@/lib/types';

const TOOL_ICONS: Record<string, typeof FileText> = {
  fs_read: FileText,
  fs_write: FilePen,
  fs_edit: FileEdit,
  bash: Terminal,
  grep: Search,
  glob: FolderSearch,
  web_fetch: Globe,
  todo_write: ListTodo,
};

const TOOL_TINT: Record<string, string> = {
  fs_read: 'text-primary bg-primary/15',
  fs_write: 'text-destructive bg-destructive/15',
  fs_edit: 'text-warning bg-warning/15',
  bash: 'text-success bg-success/15',
  grep: 'text-muted-foreground bg-muted',
  glob: 'text-muted-foreground bg-muted',
  web_fetch: 'text-muted-foreground bg-muted',
  todo_write: 'text-primary-hover bg-primary/15',
};

/** MCP tools arrive namespaced as `server__tool`; builtins never contain `__`. */
export function splitMcpTool(name: string): { server: string; tool: string } | null {
  const idx = name.indexOf('__');
  if (idx <= 0) return null;
  return { server: name.slice(0, idx), tool: name.slice(idx + 2) };
}

export function ToolCallCard({ tool }: { tool: ToolCall }) {
  const [open, setOpen] = useState(false);
  const mcp = splitMcpTool(tool.tool);
  const ToolIcon = mcp ? Plug : (TOOL_ICONS[tool.tool] ?? HelpCircle);
  const tint = mcp ? 'text-primary bg-primary/15' : (TOOL_TINT[tool.tool] ?? 'text-muted-foreground bg-muted');

  return (
    <Box
      testID={tool.callId ? `chat.toolCall.${tool.callId}` : undefined}
      className="my-1.5 rounded-md border border-border bg-card"
    >
      <Pressable onPress={() => { setOpen((o) => !o); }}>
        <HStack className="items-center gap-2 px-3 py-2">
          <Box className={`h-5 w-5 items-center justify-center rounded-sm ${tint}`}>
            <Icon as={ToolIcon} size="xs" />
          </Box>
          <Text size="sm" className="flex-1 text-card-foreground" numberOfLines={1}>
            {mcp ? (
              <>
                {`${mcp.server} · ${mcp.tool}`}
                {tool.summary && tool.summary !== '{}' ? (
                  <Text size="sm" className="text-muted-foreground">{`  ${tool.summary}`}</Text>
                ) : null}
              </>
            ) : (
              tool.summary
            )}
          </Text>
          {tool.duration && (
            <Text size="xs" className="text-muted-foreground">
              {tool.duration}
            </Text>
          )}
          <Icon
            as={ChevronRight}
            size="xs"
            className="text-muted-foreground"
            style={{ transform: [{ rotate: open ? '90deg' : '0deg' }] }}
          />
        </HStack>
      </Pressable>
      {open && (
        <Box className="border-t border-border">
          {tool.diff ? (
            <ScrollView testID={tool.callId ? `chat.toolCall.result.${tool.callId}` : undefined} style={{ maxHeight: 200 }}>
              {tool.diff.map((line, i) => (
                <Text
                  key={i}
                  numberOfLines={1}
                  className={
                    line.type === 'add'
                      ? 'bg-success/10 text-success'
                      : line.type === 'del'
                        ? 'bg-destructive/10 text-destructive'
                        : 'text-muted-foreground'
                  }
                  style={{ fontFamily: 'monospace', fontSize: 12, paddingHorizontal: 12, paddingVertical: 1 }}
                >
                  {line.text}
                </Text>
              ))}
            </ScrollView>
          ) : (
            <ScrollView testID={tool.callId ? `chat.toolCall.result.${tool.callId}` : undefined} style={{ maxHeight: 200 }}>
              <Text
                className="p-3 text-muted-foreground"
                style={{ fontFamily: 'monospace', fontSize: 12, lineHeight: 18 }}
              >
                {tool.result}
              </Text>
            </ScrollView>
          )}
        </Box>
      )}
    </Box>
  );
}
