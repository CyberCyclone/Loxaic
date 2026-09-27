import { decodeEntities, lexMarkdown } from './parse';

/**
 * A HuggingFace model card is markdown with raw HTML mixed in — centred
 * banners, badge rows, `<p>`/`<strong>` blocks and HTML tables are the norm —
 * and the renderer (built for model replies) shows HTML as literal text, so a
 * card read as a wall of tags. This turns the HTML a card uses into the
 * markdown it means, so the same renderer draws it on every platform: nothing
 * here produces a component, and nothing is ever handed to a browser as HTML.
 *
 * What it will not do, deliberately:
 * - **Fetch images.** The card is a stranger's file; an `<img>` becomes the
 *   renderer's image link, and a badge (an image inside a link) becomes the
 *   link, labelled by its alt text or where it goes.
 * - **Keep a link that is not http(s) or mailto.** `javascript:` and relative
 *   paths become plain text.
 * - **Guess at tags it does not know.** `<your-token>` in a card's prose is
 *   more often a placeholder than markup, so an unknown tag stays literal, as
 *   it always was.
 *
 * Markdown is split into blocks first (marked's lexer): an HTML block is
 * converted as HTML (whitespace collapsed, text escaped so it cannot turn into
 * markdown), and HTML inside a paragraph or list is converted tag by tag with
 * the markdown around it left alone. Code is never touched.
 */
export function htmlToMarkdown(src: string): string {
  if (!/<[A-Za-z!/]/.test(src)) return src;
  return lexMarkdown(src)
    .map((token) => {
      switch (token.type) {
        case 'html':
          return `${htmlBlockToMarkdown(token.raw)}\n\n`;
        case 'code':
        case 'space':
        case 'hr':
        case 'def':
          return token.raw;
        // A markdown table row and a heading are each one line: a `<br>`
        // turned into a newline there ends the table or the heading. A
        // table's cells also cannot hold an unescaped pipe.
        case 'table':
          return inlineHtmlToMarkdown(token.raw, { oneLine: true, inTable: true });
        case 'heading':
          return inlineHtmlToMarkdown(token.raw, { oneLine: true });
        default:
          return inlineHtmlToMarkdown(token.raw);
      }
    })
    .join('');
}

type Node = { kind: 'text'; text: string } | Element;
interface Element {
  kind: 'el';
  tag: string;
  attrs: Partial<Record<string, string>>;
  children: Node[];
}

const VOID = new Set(['br', 'hr', 'img', 'source', 'wbr', 'input', 'meta', 'link', 'col', 'area', 'track', 'embed']);
// Dropped with everything inside them: none of it is prose.
const DROPPED = new Set(['script', 'style', 'noscript', 'template', 'iframe', 'svg', 'object', 'video', 'audio', 'head', 'title', 'textarea', 'select']);
const BLOCK = new Set([
  'p', 'div', 'section', 'article', 'main', 'header', 'footer', 'nav', 'aside', 'center', 'figure', 'figcaption',
  'address', 'details', 'summary', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'pre',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption', 'colgroup', 'dl', 'dt', 'dd', 'hr', 'body', 'html',
]);
const INLINE = new Set([
  'a', 'b', 'strong', 'i', 'em', 'cite', 'dfn', 'var', 'u', 'ins', 'mark', 's', 'strike', 'del', 'code', 'tt', 'kbd',
  'samp', 'sub', 'sup', 'small', 'big', 'span', 'font', 'abbr', 'q', 'label', 'time', 'picture', 'br', 'img', 'source', 'wbr',
]);
const KNOWN = new Set([...VOID, ...DROPPED, ...BLOCK, ...INLINE]);

// Opening one of these closes an open element of the listed kinds, up to (not
// past) the named container — how a browser reads `<li>a<li>b` or an HTML
// table written without its closing tags.
const IMPLIED_CLOSE: Partial<Record<string, { closes: string[]; stopAt: string[] }>> = {
  li: { closes: ['li'], stopAt: ['ul', 'ol'] },
  dt: { closes: ['dt', 'dd'], stopAt: ['dl'] },
  dd: { closes: ['dt', 'dd'], stopAt: ['dl'] },
  tr: { closes: ['tr', 'td', 'th'], stopAt: ['table', 'thead', 'tbody', 'tfoot'] },
  td: { closes: ['td', 'th'], stopAt: ['tr', 'table'] },
  th: { closes: ['td', 'th'], stopAt: ['tr', 'table'] },
  thead: { closes: ['thead', 'tbody', 'tfoot', 'tr', 'td', 'th'], stopAt: ['table'] },
  tbody: { closes: ['thead', 'tbody', 'tfoot', 'tr', 'td', 'th'], stopAt: ['table'] },
  tfoot: { closes: ['thead', 'tbody', 'tfoot', 'tr', 'td', 'th'], stopAt: ['table'] },
};

const TAG =
  /<!--[\s\S]*?(?:-->|$)|<![^>]*>|<(\/?)([A-Za-z][A-Za-z0-9-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*\/?>/y;
const ATTR = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

type Mode = 'html' | 'mixed';

const BACKTICKS = /`+/y;
const closers = new Map<number, RegExp>();

/** The run of exactly `n` backticks that closes a code span opened by one. */
function closingRun(n: number): RegExp {
  let re = closers.get(n);
  if (!re) {
    re = new RegExp(`(?<!\`)\`{${String(n)}}(?!\`)`, 'g');
    closers.set(n, re);
  }
  return re;
}

/** Whether the character at `i` follows an odd run of backslashes. */
function escaped(src: string, i: number): boolean {
  let n = 0;
  while (src[i - 1 - n] === '\\') n += 1;
  return n % 2 === 1;
}

/** A tolerant tree builder: stray closing tags are ignored, unclosed ones end
 * at the end of the input. In `mixed` mode a code span is kept verbatim, so
 * a tag inside backticks stays code. */
function parse(src: string, mode: Mode): Node[] {
  const root: Element = { kind: 'el', tag: '#root', attrs: {}, children: [] };
  const stack: Element[] = [root];
  const top = () => stack[stack.length - 1] ?? root;
  const text = (s: string) => {
    if (!s) return;
    const kids = top().children;
    const last = kids.at(-1);
    if (last?.kind === 'text') last.text += s;
    else kids.push({ kind: 'text', text: s });
  };
  const popThrough = (index: number) => {
    stack.length = Math.max(1, index);
  };

  let i = 0;
  while (i < src.length) {
    const lt = src.indexOf('<', i);
    const tick = mode === 'mixed' ? src.indexOf('`', i) : -1;
    const next = lt === -1 ? tick : tick === -1 ? lt : Math.min(lt, tick);
    if (next === -1) {
      text(src.slice(i));
      break;
    }
    text(src.slice(i, next));
    i = next;

    if (src[i] === '`') {
      BACKTICKS.lastIndex = i;
      const run = BACKTICKS.exec(src)?.[0] ?? '`';
      // An escaped backtick is a literal one, not the start of code: taken as
      // code, it left every tag after it unconverted.
      if (escaped(src, i)) {
        text('`');
        i += 1;
        continue;
      }
      const close = closingRun(run.length);
      close.lastIndex = i + run.length;
      const end = close.exec(src);
      const stop = end ? end.index + run.length : i + run.length;
      text(src.slice(i, stop));
      i = stop;
      continue;
    }

    TAG.lastIndex = i;
    const m = TAG.exec(src);
    if (!m) {
      text('<');
      i += 1;
      continue;
    }
    i = TAG.lastIndex;
    const name = group(m, 2)?.toLowerCase();
    if (!name) continue; // a comment or a doctype
    if (!KNOWN.has(name)) {
      text(m[0]);
      continue;
    }
    if (group(m, 1) === '/') {
      for (let s = stack.length - 1; s > 0; s--) {
        if (stack[s]?.tag === name) {
          popThrough(s);
          break;
        }
      }
      continue;
    }
    if (DROPPED.has(name)) {
      // `<svg .../>` has no closing tag to look for; searching for one
      // dropped everything after it.
      if (m[0].endsWith('/>')) continue;
      const close = new RegExp(`</${name}\\s*>`, 'ig');
      close.lastIndex = i;
      const end = close.exec(src);
      i = end ? close.lastIndex : src.length;
      continue;
    }

    const implied = IMPLIED_CLOSE[name];
    if (implied) {
      // The outermost one before the container: a new row closes the open
      // cell *and* the row holding it.
      let outermost = -1;
      for (let s = stack.length - 1; s > 0; s--) {
        const tag = stack[s]?.tag ?? '';
        if (implied.stopAt.includes(tag)) break;
        if (implied.closes.includes(tag)) outermost = s;
      }
      if (outermost > 0) popThrough(outermost);
    } else if (BLOCK.has(name)) {
      // A block inside a paragraph ends the paragraph, as it does in a browser.
      for (let s = stack.length - 1; s > 0; s--) {
        const tag = stack[s]?.tag ?? '';
        if (tag === 'p') {
          popThrough(s);
          break;
        }
        if (BLOCK.has(tag)) break;
      }
    }

    const el: Element = { kind: 'el', tag: name, attrs: parseAttrs(group(m, 3) ?? ''), children: [] };
    top().children.push(el);
    if (!VOID.has(name)) stack.push(el);
  }
  return root.children;
}

/** A capture group, which is absent when it did not take part in the match —
 * the types say `string` either way. */
function group(m: RegExpExecArray | RegExpMatchArray, i: number): string | undefined {
  return m[i];
}

function parseAttrs(src: string): Partial<Record<string, string>> {
  const attrs: Partial<Record<string, string>> = {};
  for (const m of src.matchAll(ATTR)) {
    const name = group(m, 1)?.toLowerCase();
    if (name) attrs[name] = decodeEntities(group(m, 2) ?? group(m, 3) ?? group(m, 4) ?? '');
  }
  return attrs;
}

/** An address a card may link to, made safe to put in `(<…>)`, or null. */
function safeUrl(raw: string | undefined): string | null {
  const url = raw?.trim().replace(/^\/\//, 'https://');
  if (!url || !/^(https?:\/\/|mailto:)/i.test(url)) return null;
  return url.replace(/\s/g, '%20').replace(/</g, '%3C').replace(/>/g, '%3E').replace(/\|/g, '%7C');
}

/** Where a link goes, short enough to be its label: host and path. */
function shortUrl(href: string): string {
  if (/^mailto:/i.test(href)) return href.slice('mailto:'.length);
  try {
    const u = new URL(href);
    return `${u.host.replace(/^www\./, '')}${u.pathname === '/' ? '' : u.pathname.replace(/\/$/, '')}`;
  } catch {
    return href;
  }
}

/** An image's file name as words — the label of last resort. */
function imageName(src: string | undefined): string {
  const file = src?.split(/[?#]/)[0]?.split('/').pop() ?? '';
  let name = file;
  try {
    name = decodeURIComponent(file);
  } catch {
    /* a malformed escape: keep it as it is */
  }
  return name.replace(/\.[A-Za-z0-9]+$/, '').replace(/[_-]+/g, ' ').trim();
}

/** Markdown's own characters in HTML text, escaped so they stay text. An
 * underscore inside a word cannot start emphasis and is left alone — it is in
 * every file name and URL a card mentions. */
function escapeText(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i] ?? '';
    if ('\\`*[]<>|~'.includes(c)) out += `\\${c}`;
    else if (c === '_' && !(/[A-Za-z0-9]/.test(s[i - 1] ?? '') && /[A-Za-z0-9]/.test(s[i + 1] ?? ''))) out += '\\_';
    else out += c;
  }
  return out;
}

/** Wraps the text between `marker`s, keeping its edge whitespace outside —
 * `** bold **` is not bold. */
function wrap(marker: string, inner: string): string {
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(inner);
  if (!m?.[2]) return inner;
  return `${m[1]}${marker}${m[2]}${marker}${m[3]}`;
}

function codeSpan(code: string): string {
  const longest = Math.max(0, ...(code.match(/`+/g) ?? []).map((r) => r.length));
  const fence = '`'.repeat(longest + 1);
  const pad = code.startsWith('`') || code.endsWith('`') ? ' ' : '';
  return code.trim() ? `${fence}${pad}${code}${pad}${fence}` : '';
}

function textContent(nodes: Node[]): string {
  return nodes
    .map((n) => (n.kind === 'text' ? n.text : n.tag === 'br' ? '\n' : textContent(n.children)))
    .join('');
}

interface InlineOpts {
  mode: Mode;
  inLink?: boolean;
  /** Where a line break would end the construct: a table row, a heading. */
  oneLine?: boolean;
  /** In a table cell, where a pipe would start the next cell. */
  inTable?: boolean;
}

function inline(nodes: Node[], opts: InlineOpts): string {
  return nodes.map((n) => inlineNode(n, opts)).join('');
}

function inlineNode(node: Node, opts: InlineOpts): string {
  if (node.kind === 'text') {
    return opts.mode === 'html' ? escapeText(node.text.replace(/\s+/g, ' ')) : node.text;
  }
  const { tag, attrs, children } = node;
  switch (tag) {
    case 'br':
      return opts.oneLine ? ' ' : '\n';
    case 'wbr':
    case 'source':
      return '';
    case 'img': {
      const alt = attrs.alt?.trim() ?? '';
      if (opts.inLink) return escapeText(alt);
      const label = alt ? alt : imageName(attrs.src);
      const src = safeUrl(attrs.src);
      return src ? `![${escapeText(label)}](<${src}>)` : escapeText(label);
    }
    case 'a': {
      const href = safeUrl(attrs.href);
      const inner = inline(children, { ...opts, inLink: true });
      if (!href || opts.inLink) return inner;
      const label = inner.trim() ? inner : escapeText(shortUrl(href));
      const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(label);
      return `${m?.[1] ?? ''}[${m?.[2] ?? label}](<${href}>)${m?.[3] ?? ''}`;
    }
    case 'b':
    case 'strong':
      return wrap('**', inline(children, opts));
    case 'i':
    case 'em':
    case 'cite':
    case 'dfn':
    case 'var':
      return wrap('*', inline(children, opts));
    case 's':
    case 'strike':
    case 'del':
      return wrap('~~', inline(children, opts));
    case 'code':
    case 'tt':
    case 'kbd':
    case 'samp':
      {
      const code = codeSpan(decodeEntities(textContent(children)).replace(/\s+/g, ' '));
      // GFM splits a row on every unescaped pipe, code spans included, and
      // reads `\|` there as the pipe itself.
      return opts.inTable ? code.replace(/\|/g, '\\|') : code;
    }
    case 'q':
      return `“${inline(children, opts)}”`;
    case 'hr':
      return opts.mode === 'mixed' && !opts.oneLine ? '\n' : ' ';
    default:
      if (BLOCK.has(tag)) {
        // A block where only inline content can go: a heading or a table
        // cell (html), or a paragraph or list item (mixed).
        const sep = opts.mode === 'mixed' && !opts.oneLine ? '\n' : ' ';
        return `${sep}${inline(children, opts)}${sep}`;
      }
      return inline(children, opts);
  }
}

/** A run of inline HTML as one paragraph: spaces collapsed, lines trimmed, and
 * a line that would start a markdown block escaped. */
function paragraph(nodes: Node[]): string {
  return inline(nodes, { mode: 'html' })
    .replace(/[ \t]+/g, ' ')
    .split('\n')
    .map((line) =>
      line
        .trim()
        .replace(/^(#{1,6}|[+-])(?=\s|$)/, '\\$1')
        .replace(/^(\d+)([.)])(?=\s|$)/, '$1\\$2')
        // A line of only `=` or `-` would make the line above it a heading.
        .replace(/^([=-])(?=[=-]*$)/, '\\$1'),
    )
    .filter(Boolean)
    .join('\n')
    .trim();
}

function blocks(nodes: Node[]): string[] {
  const out: string[] = [];
  let run: Node[] = [];
  const flush = () => {
    const p = paragraph(run);
    if (p) out.push(p);
    run = [];
  };
  for (const node of nodes) {
    if (node.kind === 'text' || !BLOCK.has(node.tag)) {
      run.push(node);
      continue;
    }
    flush();
    out.push(...block(node));
  }
  flush();
  return out;
}

function block(el: Element): string[] {
  const { tag, attrs, children } = el;
  const oneLine = () => paragraph(children).replace(/\n+/g, ' ');
  switch (tag) {
    case 'h1':
    case 'h2':
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6': {
      const text = oneLine();
      return text ? [`${'#'.repeat(Number(tag[1]))} ${text}`] : [];
    }
    case 'summary':
    case 'dt': {
      const text = paragraph(children);
      return text ? [wrap('**', text)] : [];
    }
    case 'hr':
      return ['---'];
    case 'blockquote': {
      const inner = blocks(children).join('\n\n');
      return inner ? [inner.split('\n').map((l) => (l ? `> ${l}` : '>')).join('\n')] : [];
    }
    case 'ul':
    case 'ol':
      return list(el);
    case 'pre': {
      const code = children.find((c): c is Element => c.kind === 'el' && c.tag === 'code');
      const lang = /(?:^|\s)(?:language|lang)-(\S+)/.exec(`${attrs.class ?? ''} ${code?.attrs.class ?? ''}`)?.[1] ?? '';
      const text = decodeEntities(textContent(children)).replace(/^\n/, '').replace(/\n+$/, '');
      if (!text.trim()) return [];
      const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map((r) => r.length));
      const fence = '`'.repeat(longest + 1);
      return [`${fence}${lang}\n${text}\n${fence}`];
    }
    case 'table':
      return table(el);
    default:
      return blocks(children);
  }
}

function list(el: Element): string[] {
  const ordered = el.tag === 'ol';
  let n = Number.parseInt(el.attrs.start ?? '1', 10);
  if (!Number.isFinite(n)) n = 1;
  const items: string[] = [];
  for (const child of el.children) {
    if (child.kind === 'text' && !child.text.trim()) continue;
    const content = child.kind === 'el' && child.tag === 'li' ? blocks(child.children) : blocks([child]);
    const marker = ordered ? `${String(n)}.` : '-';
    n += 1;
    const indent = ' '.repeat(marker.length + 1);
    const lines = content.join('\n\n').split('\n');
    items.push(
      [`${marker} ${lines[0] ?? ''}`.trimEnd(), ...lines.slice(1).map((l) => (l ? `${indent}${l}` : ''))].join('\n'),
    );
  }
  return items.length ? [items.join('\n')] : [];
}

function table(el: Element): string[] {
  const rows: Element[] = [];
  const collect = (nodes: Node[]) => {
    for (const n of nodes) {
      if (n.kind !== 'el') continue;
      if (n.tag === 'tr') rows.push(n);
      else if (n.tag === 'thead' || n.tag === 'tbody' || n.tag === 'tfoot') collect(n.children);
    }
  };
  collect(el.children);
  const cells = rows
    .map((r) =>
      r.children
        .filter((c): c is Element => c.kind === 'el' && (c.tag === 'td' || c.tag === 'th'))
        .map((c) => inline(c.children, { mode: 'html', oneLine: true, inTable: true }).replace(/\s+/g, ' ').trim()),
    )
    .filter((r) => r.length > 0);
  const cols = Math.max(0, ...cells.map((r) => r.length));
  if (!cols) return blocks(el.children.filter((c) => c.kind === 'el' && c.tag === 'caption'));
  const line = (r: string[]) => `| ${Array.from({ length: cols }, (_, c) => r[c] ?? '').join(' | ')} |`;
  const [head = [], ...body] = cells;
  return [[line(head), line(Array<string>(cols).fill('---')), ...body.map(line)].join('\n')];
}

function htmlBlockToMarkdown(src: string): string {
  return blocks(parse(src, 'html')).join('\n\n');
}

function inlineHtmlToMarkdown(src: string, opts: Omit<InlineOpts, 'mode'> = {}): string {
  if (!/<[A-Za-z/]/.test(src)) return src;
  return inline(parse(src, 'mixed'), { ...opts, mode: 'mixed' });
}
