import { memo, useMemo } from 'react';
import { lexMarkdown, type Token } from './parse';
import { htmlToMarkdown } from './html';
import { renderBlock, type RenderCtx } from './blocks';
import type { MarkdownTone } from './theme';

interface MarkdownProps {
  text: string;
  tone?: MarkdownTone;
  size?: 'md' | 'sm';
  /** Draw the HTML a model card carries (html.ts) rather than showing it as
   * literal text. Off for model replies, whose stray HTML is shown as written. */
  html?: boolean;
}

interface BlockProps {
  token: Token;
  ctx: RenderCtx;
}

// Streaming makes the whole message text re-lex on every delta, but each
// completed block's `raw` (its verbatim source slice) is byte-identical
// between deltas — so this memo confines per-token re-renders to the tail
// block that is actually growing.
const Block = memo(
  function MarkdownBlock({ token, ctx }: BlockProps) {
    return <>{renderBlock(token, ctx)}</>;
  },
  (prev, next) =>
    prev.token.raw === next.token.raw &&
    prev.ctx.tone === next.ctx.tone &&
    prev.ctx.size === next.ctx.size,
);

export function Markdown({ text, tone = 'default', size = 'md', html = false }: MarkdownProps) {
  const ctx = useMemo<RenderCtx>(() => ({ tone, size }), [tone, size]);
  const tokens = useMemo(() => lexMarkdown(html ? htmlToMarkdown(text) : text), [text, html]);
  // Index keys are safe: streaming deltas are append-only, so earlier blocks
  // keep their indices while only the tail block's content changes.
  return (
    <>
      {tokens.map((token, i) => (
        <Block key={i} token={token} ctx={ctx} />
      ))}
    </>
  );
}
