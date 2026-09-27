import { describe, expect, it } from 'vitest';
import { htmlToMarkdown } from './html';
import { lexMarkdown } from './parse';

// The head of unsloth's Qwen3-Coder card, as HuggingFace serves it — the card
// that showed as a wall of tags in the quant sheet.
const UNSLOTH = `<div>
<p style="margin-bottom: 0; margin-top: 0;">
  <strong>See <a href="https://huggingface.co/collections/unsloth/qwen3-680edabfb790c8c34a242f95">our collection</a> for all versions of Qwen3 including GGUF, 4-bit & 16-bit formats.</strong>
</p>
<p style="margin-bottom: 0;">
  <em>Learn to run Qwen3-Coder correctly - <a href="https://docs.unsloth.ai/basics/qwen3-coder">Read our Guide</a>.</em>
</p>
<div style="display: flex; gap: 5px; align-items: center; ">
  <a href="https://github.com/unslothai/unsloth/">
    <img src="https://github.com/unslothai/unsloth/raw/main/images/unsloth%20new%20logo.png" width="133">
  </a>
  <a href="https://discord.gg/unsloth">
    <img src="https://github.com/unslothai/unsloth/raw/main/images/Discord%20button.png" width="173">
  </a>
</div>
<h1 style="margin-top: 0rem;">✨ Read our Qwen3-Coder Guide <a href="https://docs.unsloth.ai/basics/qwen3-coder">here</a>!</h1>
</div>

- Fine-tune Qwen3 (14B) for free using our Google [Colab notebook](https://colab.research.google.com/x)!
- Read our Blog about Qwen3 support: [unsloth.ai/blog/qwen3](https://unsloth.ai/blog/qwen3)
`;

/** Every token type, recursively — what the renderer will be asked to draw. */
function types(md: string): string[] {
  const out: string[] = [];
  const walk = (tokens: { type: string; tokens?: unknown; items?: unknown }[]) => {
    for (const t of tokens) {
      out.push(t.type);
      if (Array.isArray(t.tokens)) walk(t.tokens as never);
      if (Array.isArray(t.items)) walk(t.items as never);
    }
  };
  walk(lexMarkdown(md));
  return out;
}

describe('htmlToMarkdown', () => {
  it('turns a real model card into markdown with no HTML left in it', () => {
    const md = htmlToMarkdown(UNSLOTH);
    expect(md).toContain(
      '**See [our collection](<https://huggingface.co/collections/unsloth/qwen3-680edabfb790c8c34a242f95>) for all versions of Qwen3 including GGUF, 4-bit & 16-bit formats.**',
    );
    expect(md).toContain('*Learn to run Qwen3-Coder correctly - [Read our Guide](<https://docs.unsloth.ai/basics/qwen3-coder>).*');
    expect(md).toContain('# ✨ Read our Qwen3-Coder Guide [here](<https://docs.unsloth.ai/basics/qwen3-coder>)!');
    // The markdown after the HTML is untouched.
    expect(md).toContain('- Fine-tune Qwen3 (14B) for free using our Google [Colab notebook](https://colab.research.google.com/x)!');
    expect(types(md)).not.toContain('html');
    expect(md).not.toMatch(/<\/?(div|p|strong|em|a|img|h1)\b/);
  });

  it('turns a badge — an image inside a link — into the link, labelled by where it goes', () => {
    const md = htmlToMarkdown(UNSLOTH);
    expect(md).toContain('[github.com/unslothai/unsloth](<https://github.com/unslothai/unsloth/>)');
    expect(md).toContain('[discord.gg/unsloth](<https://discord.gg/unsloth>)');
    expect(md).not.toContain('logo.png');
  });

  it('labels a badge by its alt text when it has one', () => {
    expect(htmlToMarkdown('<a href="https://x.org/"><img src="https://x.org/b.svg" alt="Docs"></a>\n').trim()).toBe(
      '[Docs](<https://x.org/>)',
    );
  });

  it('never fetches an image: it becomes the renderer’s image link, named by its alt or file', () => {
    const md = htmlToMarkdown('<p align="center"><img src="https://x.org/img/bench%20chart.png"></p>\n');
    expect(md.trim()).toBe('![bench chart](<https://x.org/img/bench%20chart.png>)');
    expect(types(md)).toContain('image');
  });

  it('drops links it should not follow, keeping their words', () => {
    expect(htmlToMarkdown('<p><a href="javascript:alert(1)">click</a> <a href="./LICENSE">licence</a></p>\n').trim()).toBe(
      'click licence',
    );
    expect(htmlToMarkdown('<p><img src="data:image/png;base64,AAAA" alt="x"></p>\n').trim()).toBe('x');
  });

  it('drops scripts, styles and comments with everything inside them', () => {
    const md = htmlToMarkdown('<div><style>.a{color:red}</style><!-- hidden --><script>alert(1)</script>Hello</div>\n');
    expect(md.trim()).toBe('Hello');
  });

  it('turns an HTML table into a markdown table', () => {
    const md = htmlToMarkdown(
      '<table>\n<tr><th>Benchmark</th><th>Score</th></tr>\n<tr><td>HumanEval</td><td><b>92.1</b></td></tr>\n<tr><td>MBPP</td><td>80 | 81</td></tr>\n</table>\n',
    );
    expect(md.trim()).toBe(
      ['| Benchmark | Score |', '| --- | --- |', '| HumanEval | **92.1** |', '| MBPP | 80 \\| 81 |'].join('\n'),
    );
    expect(types(md)).toContain('table');
  });

  it('reads a table written without its closing tags, as a browser does', () => {
    const md = htmlToMarkdown('<table><tr><td>a<td>b<tr><td>c<td>d</table>\n');
    expect(md.trim()).toBe(['| a | b |', '| --- | --- |', '| c | d |'].join('\n'));
  });

  it('turns HTML lists, line breaks and code into their markdown', () => {
    const md = htmlToMarkdown(
      '<ul>\n  <li>one</li>\n  <li>two<br>still two</li>\n</ul>\n\n<ol start="3"><li>three<li>four</ol>\n\n<pre><code class="language-bash">llama-server -m &lt;model&gt;.gguf\n</code></pre>\n',
    );
    expect(md).toContain('- one\n- two\n  still two');
    expect(md).toContain('3. three\n4. four');
    expect(md).toContain('```bash\nllama-server -m <model>.gguf\n```');
  });

  it('keeps HTML text as text, even where it looks like markdown', () => {
    const md = htmlToMarkdown('<p>\n  # not a heading, *not emphasis*, a_b_c and _this_\n</p>\n');
    expect(md.trim()).toBe('\\# not a heading, \\*not emphasis\\*, a_b_c and \\_this\\_');
    expect(types(md)).not.toContain('heading');
    expect(types(md)).not.toContain('em');
  });

  it('converts HTML inside a paragraph and leaves the markdown around it alone', () => {
    const md = htmlToMarkdown('Run it with **care**: see <a href="https://x.org/g">the <b>guide</b></a>.<br>Next line.\n');
    expect(md).toBe('Run it with **care**: see [the **guide**](<https://x.org/g>).\nNext line.\n');
  });

  it('never touches code, where a tag is only text', () => {
    const src = 'Use `<b>` for bold.\n\n```html\n<div>kept</div>\n```\n';
    expect(htmlToMarkdown(src)).toBe(src);
  });

  it('leaves a tag it does not know literal: in prose it is usually a placeholder', () => {
    expect(htmlToMarkdown('Replace <your-token> with <b>yours</b>.\n')).toBe('Replace <your-token> with **yours**.\n');
  });

  it('returns a card with no HTML unchanged', () => {
    const src = '# Title\n\nSome *text* and a [link](https://x.org).\n';
    expect(htmlToMarkdown(src)).toBe(src);
  });

  it('keeps a markdown table whole when a cell has a line break or a pipe in code', () => {
    const src = '| Model | Score |\n| --- | --- |\n| Qwen3 | 92.1<br>(pass@1) |\n| Tiny | <code>a|b</code> |\n';
    const md = htmlToMarkdown(src);
    expect(md).toBe('| Model | Score |\n| --- | --- |\n| Qwen3 | 92.1 (pass@1) |\n| Tiny | `a\\|b` |\n');
    const table = lexMarkdown(md).find((t) => t.type === 'table') as { rows: unknown[][] } | undefined;
    expect(table?.rows).toHaveLength(2);
    expect(table?.rows.every((r) => r.length === 2)).toBe(true);
  });

  it('keeps a pipe in an HTML table cell’s code inside its cell', () => {
    const md = htmlToMarkdown('<table><tr><th>Flag</th></tr><tr><td><code>a|b</code></td></tr></table>\n');
    expect(md.trim()).toBe(['| Flag |', '| --- |', '| `a\\|b` |'].join('\n'));
  });

  it('keeps a heading on one line when it has a line break in it', () => {
    expect(htmlToMarkdown('# Qwen3<br>Coder\n')).toBe('# Qwen3 Coder\n');
  });

  it('keeps everything after a self-closing tag it drops', () => {
    const md = htmlToMarkdown('<p><svg width="16" height="16"/> Fast and <b>small</b>.</p>\n');
    expect(md.trim()).toBe('Fast and **small**.');
  });

  it('reads an escaped backtick as a backtick, and still converts the tags after it', () => {
    // The later code span is what the escaped backtick used to pair with.
    const md = htmlToMarkdown('Quote with \\` then see <a href="https://x.org/d">docs</a> and `code`.\n');
    expect(md).toBe('Quote with \\` then see [docs](<https://x.org/d>) and `code`.\n');
  });

  it('never turns HTML text into a setext heading or a rule', () => {
    const md = htmlToMarkdown('<p>Results<br>=======<br>---</p>\n');
    expect(md.trim()).toBe('Results\n\\=======\n\\---');
    expect(types(md)).not.toContain('heading');
    expect(types(md)).not.toContain('hr');
  });

  it('turns details and summary into a bold line and its content', () => {
    const md = htmlToMarkdown('<details>\n<summary>Show benchmarks</summary>\n\nFast.\n\n</details>\n');
    expect(md).toContain('**Show benchmarks**');
    expect(md).toContain('Fast.');
    expect(types(md)).not.toContain('html');
  });
});
