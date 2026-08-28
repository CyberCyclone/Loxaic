import type {
  StreamEventKind,
  StreamSnapshot,
  StreamSnapshotMessage,
  ApiMessage,
} from '@shannon/api-client';
import type { CompactionStats, ContentBlock, FileDiff } from '@shannon/types';
import type { Message, ToolCall } from '@/lib/types';
import { toMessageUsage, usageFromTurn } from '@/lib/usage';
import { computeLineDiff } from '@/lib/diff';

/** Author types the client renders as a message row. Shared by both
 * surfaces — chat and agent build Message[] from the exact same stream
 * protocol now that chat is tool-capable too. */
export function roleOf(authorType: string): Message['role'] | null {
  if (authorType === 'user') return 'user';
  if (authorType === 'assistant') return 'assistant';
  if (authorType === 'summary') return 'summary';
  return null;
}

export function extractCompaction(blocks: ContentBlock[]): CompactionStats | undefined {
  const block = blocks.find((b) => b.kind === 'compaction');
  if (!block) return undefined;
  const { messages_compacted, before_tokens, after_tokens, saved_tokens, before_estimated, skipped, guidance } =
    block;
  return { messages_compacted, before_tokens, after_tokens, saved_tokens, before_estimated, skipped, guidance };
}

export function extractField(blocks: ContentBlock[], kind: 'text' | 'thinking'): string {
  return blocks
    .filter((b) => b.kind === kind)
    .map((b) => (b as { text: string }).text)
    .join('\n');
}

export function toolSummary(tool: string, args: Record<string, unknown>): string {
  switch (tool) {
    case 'fs_read':
    case 'fs_write':
    case 'fs_edit':
      return typeof args.path === 'string' ? args.path : JSON.stringify(args);
    case 'bash':
      return typeof args.command === 'string' ? args.command : JSON.stringify(args);
    case 'grep': {
      const pattern = typeof args.pattern === 'string' ? args.pattern : '';
      const path = typeof args.path === 'string' ? ` in ${args.path}` : '';
      return `"${pattern}"${path}`;
    }
    case 'glob':
      return typeof args.pattern === 'string' ? args.pattern : JSON.stringify(args);
    case 'web_fetch':
      return typeof args.url === 'string' ? args.url : JSON.stringify(args);
    case 'todo_write': {
      const todos = args.todos;
      const n = Array.isArray(todos) ? todos.length : 0;
      return `${String(n)} item${n === 1 ? '' : 's'}`;
    }
    default:
      return JSON.stringify(args);
  }
}

export function diffLinesFor(diff: FileDiff[] | undefined): ToolCall['diff'] {
  if (!diff || diff.length === 0) return undefined;
  const out: ToolCall['diff'] = [];
  for (const f of diff) {
    out.push({
      type: 'meta',
      text: f.oldContent === null ? `+++ ${f.path} (new file)` : `--- / +++ ${f.path}`,
    });
    out.push(...computeLineDiff(f.oldContent, f.newContent));
  }
  return out;
}

/** Cold history load only (REST) — live state is driven entirely by the
 * stream protocol below. Rebuilds Message[] from stored blocks, joining
 * tool_result rows back to their tool_call by call_id. */
export function reconstructMessages(rows: ApiMessage[]): Message[] {
  const out: Message[] = [];
  const byId = new Map<string, Message>();
  const callToMsgId = new Map<string, string>();

  for (const row of rows) {
    if (row.status === 'cancelled') continue;
    const blocks = row.content;

    if (row.authorType === 'user') {
      const msg: Message = { id: row.id, role: 'user', text: extractField(blocks, 'text') };
      out.push(msg);
      byId.set(row.id, msg);
      continue;
    }

    if (row.authorType === 'summary') {
      const msg: Message = {
        id: row.id,
        role: 'summary',
        model: row.model ?? undefined,
        text: extractField(blocks, 'text'),
        compaction: extractCompaction(blocks),
      };
      out.push(msg);
      byId.set(row.id, msg);
      continue;
    }

    if (row.authorType === 'assistant') {
      const thinking = extractField(blocks, 'thinking');
      const tools: ToolCall[] = [];
      for (const b of blocks) {
        if (b.kind !== 'tool_call') continue;
        const callId = b.call_id;
        tools.push({
          tool: b.tool,
          summary: toolSummary(b.tool, (b.args ?? {}) as Record<string, unknown>),
          result: '',
          callId,
        });
        callToMsgId.set(callId, row.id);
      }
      const msg: Message = {
        id: row.id,
        role: 'assistant',
        model: row.model ?? undefined,
        text: extractField(blocks, 'text'),
        thinking: thinking || undefined,
        tools: tools.length > 0 ? tools : undefined,
        usage: toMessageUsage(row.usage),
      };
      out.push(msg);
      byId.set(row.id, msg);
      continue;
    }

    if (row.authorType === 'tool') {
      for (const b of blocks) {
        if (b.kind !== 'tool_result') continue;
        const msgId = callToMsgId.get(b.call_id);
        const msg = msgId ? byId.get(msgId) : undefined;
        const tc = msg?.tools?.find((t) => t.callId === b.call_id);
        if (tc) {
          tc.result = b.output;
          tc.diff = diffLinesFor(b.diff);
        }
      }
    }
  }
  return out;
}

/** A `stream.sync` snapshot is authoritative — folds tool_calls (which now
 * always carry their owning message_id directly) straight onto the
 * assistant message, same shape reconstructMessages produces from cold
 * storage. */
export function snapshotMessageToMessage(sm: StreamSnapshotMessage): Message {
  const role = roleOf(sm.author_type) ?? 'assistant';
  return {
    id: sm.message_id,
    role,
    model: sm.model,
    text: sm.text,
    thinking: sm.thinking || undefined,
    tools:
      sm.tool_calls.length > 0
        ? sm.tool_calls.map((tc) => ({
            tool: tc.tool,
            summary: toolSummary(tc.tool, tc.args),
            result: tc.output ?? '',
            diff: diffLinesFor(tc.diff),
            callId: tc.call_id,
          }))
        : undefined,
    usage: sm.usage ? usageFromTurn(sm.usage) : undefined,
    error: sm.status === 'error',
    stopped: sm.status === 'cancelled',
    compaction: role === 'summary' ? sm.compaction : undefined,
  };
}

export function applySnapshotToMsgs(msgs: Message[], snapshot: StreamSnapshot): Message[] {
  const result = [...msgs];
  for (const sm of snapshot.messages) {
    const converted = snapshotMessageToMessage(sm);
    const idx = result.findIndex((m) => m.id === sm.message_id);
    if (idx >= 0) result[idx] = converted;
    else result.push(converted);
  }
  return result;
}

export function applyEventToMsgs(msgs: Message[], event: StreamEventKind): Message[] {
  switch (event.kind) {
    case 'message.start': {
      if (msgs.some((m) => m.id === event.message_id)) return msgs;
      return [
        ...msgs,
        { id: event.message_id, role: roleOf(event.author_type) ?? 'assistant', model: event.model, text: event.text ?? '' },
      ];
    }
    case 'text.delta':
      return msgs.map((m) => (m.id === event.message_id ? { ...m, text: m.text + event.text } : m));
    case 'thinking.delta':
      return msgs.map((m) => (m.id === event.message_id ? { ...m, thinking: (m.thinking ?? '') + event.text } : m));
    case 'compaction': {
      const { message_id, messages_compacted, before_tokens, after_tokens, saved_tokens, before_estimated, skipped, guidance } =
        event;
      const stats = { messages_compacted, before_tokens, after_tokens, saved_tokens, before_estimated, skipped, guidance };
      return msgs.map((m) => (m.id === message_id ? { ...m, compaction: stats } : m));
    }
    case 'message.end':
      return msgs.map((m) =>
        m.id === event.message_id
          ? {
              ...m,
              usage: event.usage ? usageFromTurn(event.usage) : m.usage,
              error: event.status === 'error',
              stopped: event.status === 'cancelled',
            }
          : m,
      );
    case 'tool.call':
      return msgs.map((m) =>
        m.id === event.message_id
          ? {
              ...m,
              tools: [
                ...(m.tools ?? []),
                { tool: event.tool, summary: toolSummary(event.tool, event.args), result: '', callId: event.call_id },
              ],
            }
          : m,
      );
    case 'tool.result':
      return msgs.map((m) => {
        if (!m.tools?.some((t) => t.callId === event.call_id)) return m;
        return {
          ...m,
          tools: m.tools.map((t) =>
            t.callId === event.call_id ? { ...t, result: event.output, diff: diffLinesFor(event.diff) } : t,
          ),
        };
      });
    default:
      // model.loading/iteration/approval.request/todos — hook-level state,
      // not per-message; handled by the caller.
      return msgs;
  }
}
