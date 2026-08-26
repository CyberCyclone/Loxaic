import { Lexer, type Token, type TokensList } from 'marked';

// A Lexer instance accumulates into `this.tokens` across lex() calls, so a
// shared instance would leak earlier messages into later ones — always lex
// with a fresh one.
export function lexMarkdown(src: string): TokensList {
  return new Lexer({ gfm: true, breaks: true }).lex(src);
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

// marked's lexer leaves entity references literal in text tokens (its own HTML
// renderer emits them verbatim, where the browser decodes them). We render to
// native Text, so decode here. CommonMark does not process entities inside
// code spans/blocks, so only plain text tokens go through this.
export function decodeEntities(text: string): string {
  if (!text.includes('&')) return text;
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body: string) => {
    if (body.startsWith('#')) {
      const code = body.startsWith('#x') || body.startsWith('#X')
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);
      return Number.isNaN(code) ? match : String.fromCodePoint(code);
    }
    return NAMED_ENTITIES[body] ?? match;
  });
}

export type { Token, TokensList };
