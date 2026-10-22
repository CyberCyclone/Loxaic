import { describe, expect, it } from 'vitest';
import { toolDetailFields } from './toolDetails';

describe('toolDetailFields', () => {
  it('shows a bash command whole, however long', () => {
    const command = `touch note.txt && ${'echo a-long-line-of-output; '.repeat(20)}`;
    expect(toolDetailFields('bash', { command })).toEqual([{ key: 'command', label: 'Command', value: command, mono: true }]);
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
      { key: 'path', label: 'Path', value: 'a.txt', mono: true },
      { key: 'offset', label: 'From line', value: '40', mono: false },
      { key: 'limit', label: 'Lines', value: '10', mono: false },
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
      { key: 'title', label: 'title', value: 'Bug', mono: true },
      { key: 'labels', label: 'labels', value: '[\n  "a",\n  "b"\n]', mono: true },
      { key: 'draft', label: 'draft', value: 'false', mono: true },
    ]);
    expect(toolDetailFields('mystery', { nested: { a: 1 }, nothing: null })).toEqual([
      { key: 'nested', label: 'nested', value: '{\n  "a": 1\n}', mono: true },
      { key: 'nothing', label: 'nothing', value: 'null', mono: true },
    ]);
  });

  it('gives nothing for empty or missing args', () => {
    expect(toolDetailFields('bash', {})).toEqual([]);
    expect(toolDetailFields('github__get_me', undefined)).toEqual([]);
  });
});
