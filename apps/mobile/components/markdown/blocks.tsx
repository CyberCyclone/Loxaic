import type { ReactNode } from 'react';
import type { Tokens } from 'marked';
import { Box } from '@/components/ui/box';
import { Divider } from '@/components/ui/divider';
import { HStack } from '@/components/ui/hstack';
import { VStack } from '@/components/ui/vstack';
import { Text } from '@/components/ui/text';
import { CodeBlock } from '@/components/chat/CodeBlock';
import { renderInlines } from './inlines';
import { md, type MarkdownTone } from './theme';
import type { Token } from './parse';

export interface RenderCtx {
  tone: MarkdownTone;
  size: 'md' | 'sm';
}

function textColor(ctx: RenderCtx): string {
  return md.color[ctx.tone];
}

function listMarker(item: Tokens.ListItem, ordered: boolean, start: number, index: number): string {
  if (item.task) return item.checked ? '☑' : '☐';
  return ordered ? `${String(start + index)}.` : '•';
}

/**
 * The marker column's width, from the widest marker in the list. A fixed 20px
 * (`w-5`) fitted "9." and not "10.": on native the dot wrapped onto a line of
 * its own, on web it ran into the item's text — and a plan (#199) is usually a
 * numbered list long enough to show it. Sized per list rather than per item,
 * so every item's text starts in the same column.
 */
function markerWidth(token: Tokens.List, start: number, ctx: RenderCtx): number {
  const digits = token.ordered ? String(start + token.items.length - 1).length : 1;
  const perDigit = ctx.size === 'sm' ? 8 : 9;
  return 20 + Math.max(0, digits - 1) * perDigit;
}

function renderList(token: Tokens.List, ctx: RenderCtx, key: number): ReactNode {
  const start = typeof token.start === 'number' ? token.start : 1;
  const width = markerWidth(token, start, ctx);
  return (
    <VStack key={key} className="my-1">
      {token.items.map((item, i) => (
        <HStack key={i} className={md.listRow}>
          <Text size={ctx.size} className={md.listMarker} style={{ width }}>
            {listMarker(item, token.ordered, start, i)}
          </Text>
          <VStack className={md.listContent}>{renderBlocks(item.tokens, ctx)}</VStack>
        </HStack>
      ))}
    </VStack>
  );
}

function renderTable(token: Tokens.Table, ctx: RenderCtx, key: number): ReactNode {
  const alignClass = (col: number) => {
    const a = token.align[col];
    return a === 'center' ? 'text-center' : a === 'right' ? 'text-right' : '';
  };
  return (
    <VStack key={key} className="my-2">
      <HStack className={md.tableHeadRow}>
        {token.header.map((cell, c) => (
          <Box key={c} className={md.tableCell}>
            <Text size={ctx.size} className={`${textColor(ctx)} ${md.tableHeadText} ${alignClass(c)}`}>
              {renderInlines(cell.tokens)}
            </Text>
          </Box>
        ))}
      </HStack>
      {token.rows.map((row, r) => (
        <HStack key={r} className={md.tableRow}>
          {row.map((cell, c) => (
            <Box key={c} className={md.tableCell}>
              <Text size={ctx.size} className={`${textColor(ctx)} ${alignClass(c)}`}>
                {renderInlines(cell.tokens)}
              </Text>
            </Box>
          ))}
        </HStack>
      ))}
    </VStack>
  );
}

export function renderBlock(token: Token, ctx: RenderCtx, key = 0): ReactNode {
  switch (token.type) {
    case 'space':
      return null;
    case 'heading': {
      const t = token as Tokens.Heading;
      const sizeClass = md.heading[t.depth - 1] ?? md.heading[5];
      return (
        <Text key={key} className={`${textColor(ctx)} ${md.headingBase} ${sizeClass}`}>
          {renderInlines(t.tokens)}
        </Text>
      );
    }
    case 'paragraph':
      return (
        <Text key={key} size={ctx.size} className={`${textColor(ctx)} ${md.paragraphSpacing}`}>
          {renderInlines((token as Tokens.Paragraph).tokens)}
        </Text>
      );
    // A block-level `text` token: tight list items and lazy paragraphs. Same
    // as a paragraph but without extra vertical margin.
    case 'text':
      return (
        <Text key={key} size={ctx.size} className={textColor(ctx)}>
          {renderInlines((token as Tokens.Text).tokens ?? [token])}
        </Text>
      );
    case 'code': {
      const t = token as Tokens.Code;
      // An empty-string lang (bare ```) falls back to CodeBlock's default label.
      return <CodeBlock key={key} code={t.text} lang={t.lang === '' ? undefined : t.lang} />;
    }
    case 'blockquote':
      return (
        <Box key={key} className={md.blockquote}>
          {renderBlocks((token as Tokens.Blockquote).tokens, ctx)}
        </Box>
      );
    case 'list':
      return renderList(token as Tokens.List, ctx, key);
    case 'table':
      return renderTable(token as Tokens.Table, ctx, key);
    case 'hr':
      return <Divider key={key} className="my-3" />;
    case 'html':
      // Block-level HTML renders as literal text — safe and honest.
      return (
        <Text key={key} size={ctx.size} className={textColor(ctx)}>
          {(token as Tokens.HTML).text}
        </Text>
      );
    case 'def':
      return null;
    // Task-list state lives at block level inside a list item's tokens; the
    // marker column already renders it as ☑/☐.
    case 'checkbox':
      return null;
    default:
      return (
        <Text key={key} size={ctx.size} className={textColor(ctx)}>
          {'raw' in token ? token.raw : ''}
        </Text>
      );
  }
}

export function renderBlocks(tokens: Token[] | undefined, ctx: RenderCtx): ReactNode {
  if (!tokens) return null;
  return tokens.map((t, i) => renderBlock(t, ctx, i));
}
