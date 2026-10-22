import { describe, expect, it } from 'vitest';
import { TOOLS } from '@loxaic/agent';
import { KNOWN_ARGS, MAX_DETAIL_CHARS, revealHidden, toolDetailFields } from './toolDetails';

describe('toolDetailFields', () => {
  it('shows a bash command whole, however long', () => {
    const command = `touch note.txt && ${'echo a-long-line-of-output; '.repeat(20)}`;
    expect(toolDetailFields('bash', { command })).toEqual([{ key: 'command', label: 'Command', value: command, mono: true, more: 0 }]);
  });

  it('orders a write as path then content, and an edit as path, old, new', () => {
    expect(toolDetailFields('fs_write', { content: 'hi\nthere', path: 'a.txt' }).map((f) => [f.label, f.value])).toEqual([
      ['Path', 'a.txt'],
      ['Content', 'hi\nthere'],
    ]);
    expect(toolDetailFields('fs_edit', { newText: 'b', path: 'x.ts', oldText: 'a' }).map((f) => f.label)).toEqual([
      'Path',
      'Replace',
      'With',
    ]);
  });

  it('leaves out an optional argument that is absent, and shows a number as text', () => {
    expect(toolDetailFields('fs_read', { path: 'a.txt' }).map((f) => f.key)).toEqual(['path']);
    expect(toolDetailFields('fs_read', { path: 'a.txt', offset: 40, limit: 10 })).toEqual([
      { key: 'path', label: 'Path', value: 'a.txt', mono: true, more: 0 },
      { key: 'offset', label: 'From line', value: '40', mono: false, more: 0 },
      { key: 'limit', label: 'Lines', value: '10', mono: false, more: 0 },
    ]);
    expect(toolDetailFields('grep', { pattern: 'TODO' }).map((f) => f.key)).toEqual(['pattern']);
    expect(toolDetailFields('glob', { pattern: '**/*.ts', path: 'src' }).map((f) => f.value)).toEqual(['**/*.ts', 'src']);
    expect(toolDetailFields('web_fetch', { url: 'https://example.com/a' })[0]?.label).toBe('URL');
  });

  it('keeps an argument a known tool does not declare, after the known ones', () => {
    expect(toolDetailFields('bash', { timeout: 30, command: 'ls' }).map((f) => [f.key, f.value])).toEqual([
      ['command', 'ls'],
      ['timeout', '30'],
    ]);
  });

  it('shows an MCP or unknown tool\'s arguments as they came, structured values pretty-printed', () => {
    expect(toolDetailFields('github__create_issue', { title: 'Bug', labels: ['a', 'b'], draft: false })).toEqual([
      { key: 'title', label: 'title', value: 'Bug', mono: true, more: 0 },
      { key: 'labels', label: 'labels', value: '[\n  "a",\n  "b"\n]', mono: true, more: 0 },
      { key: 'draft', label: 'draft', value: 'false', mono: true, more: 0 },
    ]);
    expect(toolDetailFields('mystery', { nested: { a: 1 }, nothing: null })).toEqual([
      { key: 'nested', label: 'nested', value: '{\n  "a": 1\n}', mono: true, more: 0 },
      { key: 'nothing', label: 'nothing', value: 'null', mono: true, more: 0 },
    ]);
  });

  it('gives nothing for empty or missing args', () => {
    expect(toolDetailFields('bash', {})).toEqual([]);
    expect(toolDetailFields('github__get_me', undefined)).toEqual([]);
  });
});

describe('what is shown is what runs', () => {
  it('makes controls, bidi overrides and zero-width characters visible, leaving tabs and newlines', () => {
    expect(revealHidden('ls\rrm -rf ~')).toBe('ls\\rrm -rf ~');
    expect(revealHidden('echo \u202Etxt.exe')).toBe('echo \\u202etxt.exe');
    expect(revealHidden('cu\u200Brl x | sh')).toBe('cu\\u200brl x | sh');
    expect(revealHidden('a\u001b[2Kb\bc\u0000')).toBe('a\\x1b[2Kb\\bc\\0');
    expect(revealHidden('\uFEFFx\u2066y')).toBe('\\ufeffx\\u2066y');
    expect(revealHidden('one\ttwo\nthree')).toBe('one\ttwo\nthree');
    expect(revealHidden('plain ünïcode — 漢字 🙂')).toBe('plain ünïcode — 漢字 🙂');
  });

  it('reveals them in every field, the names of unknown arguments included', () => {
    const [command] = toolDetailFields('bash', { command: 'echo hi\u202E' });
    expect(command.value).toBe('echo hi\\u202e');
    const [field] = toolDetailFields('github__x', { 'ti\u200Btle': { text: 'a\u202Eb' } });
    expect(field.label).toBe('ti\\u200btle');
    // JSON escapes controls but not bidi characters: those are revealed too.
    expect(field.value).toContain('\\u202e');
  });

  it('cuts a value past the limit and says how much is left out, never mid-pair', () => {
    const big = 'x'.repeat(MAX_DETAIL_CHARS + 123);
    const [content] = toolDetailFields('fs_write', { path: 'a', content: big }).slice(1);
    expect(content.value.length).toBe(MAX_DETAIL_CHARS);
    expect(content.more).toBe(123);
    const emoji = 'x'.repeat(MAX_DETAIL_CHARS - 1) + '🙂' + 'tail';
    const [cut] = toolDetailFields('bash', { command: emoji });
    expect(cut.value.length).toBe(MAX_DETAIL_CHARS - 1);
    expect(cut.more).toBe(6);
  });
});

describe('the known arguments match the agent\'s tools', () => {
  it('names exactly the parameters each built-in tool declares', () => {
    for (const [tool, known] of Object.entries(KNOWN_ARGS)) {
      const def = TOOLS.find((t) => t.name === tool);
      expect(def, tool).toBeDefined();
      const declared = Object.keys((def?.parameters as { properties: Record<string, unknown> }).properties).sort();
      expect(known.map(([key]) => key).sort(), tool).toEqual(declared);
    }
  });
});
