import { describe, expect, it } from 'vitest';
import { plusMenuPage } from './plusMenuPage';

describe('plusMenuPage', () => {
  it('shows the page that was opened while it has something to show', () => {
    expect(plusMenuPage('thinking', { thinking: true, mcp: true })).toBe('thinking');
    expect(plusMenuPage('mcp', { thinking: true, mcp: true })).toBe('mcp');
    expect(plusMenuPage('main', { thinking: true, mcp: true })).toBe('main');
  });

  it('falls back to the main page, never to another one, when the open page loses its content', () => {
    // The model switched to one with no thinking control while its list was open.
    expect(plusMenuPage('thinking', { thinking: false, mcp: true })).toBe('main');
    expect(plusMenuPage('mcp', { thinking: true, mcp: false })).toBe('main');
  });
});
