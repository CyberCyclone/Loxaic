import { describe, expect, it } from 'vitest';
import type { Tokens } from 'marked';
import { decodeEntities, lexMarkdown, type Token } from './parse';

// Flatten a token tree into a compact serializable spec — asserts the shapes
// the renderer in blocks.tsx/inlines.tsx depends on, without rendering.
interface TokenSpec {
  type: string;
  text?: string;
  depth?: number;
  lang?: string;
  href?: string;
  ordered?: boolean;
  task?: boolean;
  checked?: boolean;
  children?: TokenSpec[];
}

function spec(token: Token): TokenSpec {
  const out: TokenSpec = { type: token.type };
  switch (token.type) {
    case 'heading':
      out.depth = (token as Tokens.Heading).depth;
      break;
    case 'code': {
      const lang = (token as Tokens.Code).lang;
      if (lang) out.lang = lang;
      break;
    }
    case 'link':
    case 'image':
      out.href = (token as Tokens.Link).href;
      break;
    case 'list': {
      const list = token as Tokens.List;
      out.ordered = list.ordered;
      out.children = list.items.map((item) => ({
        type: 'list_item',
        task: item.task,
        checked: item.checked ?? false,
        children: item.tokens.map(spec),
      }));
      return out;
    }
  }
  const generic = token as { tokens?: Token[]; text?: string };
  if (generic.tokens?.length) {
    out.children = generic.tokens.map(spec);
  } else if (generic.text !== undefined) {
    out.text = generic.text;
  }
  return out;
}

function specs(src: string): TokenSpec[] {
  return lexMarkdown(src)
    .filter((t) => t.type !== 'space')
    .map(spec);
}

describe('lexMarkdown', () => {
  it('parses headings with inline children at the right depth', () => {
    expect(specs('### **Bold** rest')).toEqual([
      {
        type: 'heading',
        depth: 3,
        children: [
          { type: 'strong', children: [{ type: 'text', text: 'Bold' }] },
          { type: 'text', text: ' rest' },
        ],
      },
    ]);
  });

  it('parses emphasis, code spans, and links inline', () => {
    const [para] = specs('a **b** *c* ~~d~~ `e & f` [g](https://h.i)');
    expect(para.children?.map((c) => c.type)).toEqual([
      'text', 'strong', 'text', 'em', 'text', 'del', 'text', 'codespan', 'text', 'link',
    ]);
    // Code spans keep their content verbatim — no entity processing.
    expect(para.children?.[7].text).toBe('e & f');
    expect(para.children?.[9].href).toBe('https://h.i');
  });

  it('parses nested lists, keeping the sublist inside its parent item', () => {
    const [list] = specs('- one\n  - inner\n- two');
    expect(list.ordered).toBe(false);
    expect(list.children).toHaveLength(2);
    expect(list.children?.[0].children?.map((c) => c.type)).toEqual(['text', 'list']);
  });

  it('parses GFM task lists with checked state', () => {
    const [list] = specs('- [ ] todo\n- [x] done');
    expect(list.children?.map((i) => ({ task: i.task, checked: i.checked }))).toEqual([
      { task: true, checked: false },
      { task: true, checked: true },
    ]);
  });

  it('parses GFM tables into header and rows with inline cell tokens', () => {
    const tokens = lexMarkdown('| A | B |\n|---|:-:|\n| **1** | 2 |');
    expect(tokens[0].type).toBe('table');
    const table = tokens[0] as Tokens.Table;
    expect(table.header.map((h) => h.text)).toEqual(['A', 'B']);
    expect(table.align).toEqual([null, 'center']);
    expect(table.rows[0][0].tokens[0].type).toBe('strong');
  });

  it('treats an unclosed fence as a code block running to the end (streaming)', () => {
    expect(specs('before\n```py\nprint(1)\nprint(2)')).toEqual([
      { type: 'paragraph', children: [{ type: 'text', text: 'before' }] },
      { type: 'code', lang: 'py', text: 'print(1)\nprint(2)' },
    ]);
  });

  it('turns single newlines into br tokens (breaks mode, chat fidelity)', () => {
    const [para] = specs('one\ntwo');
    expect(para.children?.map((c) => c.type)).toEqual(['text', 'br', 'text']);
  });

  it('does not leak tokens between lexes (fresh lexer per call)', () => {
    lexMarkdown('# first document');
    expect(specs('plain text')).toEqual([
      { type: 'paragraph', children: [{ type: 'text', text: 'plain text' }] },
    ]);
  });
});

describe('decodeEntities', () => {
  it('decodes the named entities models actually emit', () => {
    expect(decodeEntities('AT&amp;T, 5 &lt; 6 &gt; 4, &quot;hi&quot;')).toBe('AT&T, 5 < 6 > 4, "hi"');
  });

  it('decodes numeric and hex references', () => {
    expect(decodeEntities('&#65;&#x42;')).toBe('AB');
  });

  it('leaves unknown references and bare ampersands alone', () => {
    expect(decodeEntities('&unknown; a & b')).toBe('&unknown; a & b');
  });
});
