import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

let theme = 'dark';
vi.mock('uniwind', () => ({ useUniwind: () => ({ theme }) }));

const { SVG_COLORS, chartSeries, useSvgColors } = await import('./designTokens');

const CSS = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'global.css'), 'utf8');

/** The `--name: r g b;` triples of one `@variant` block in global.css, as hex. */
function cssTokens(variant: 'light' | 'dark'): Record<string, string> {
  const start = CSS.indexOf(`@variant ${variant} {`);
  const block = CSS.slice(start, CSS.indexOf('}', start));
  const out: Record<string, string> = {};
  for (const [, name, r, g, b] of block.matchAll(/--([a-z0-9-]+): (\d+) (\d+) (\d+);/g)) {
    out[name] = '#' + [r, g, b].map((v) => Number(v).toString(16).padStart(2, '0')).join('');
  }
  return out;
}

describe('SVG_COLORS', () => {
  for (const variant of ['light', 'dark'] as const) {
    it(`matches global.css in ${variant}`, () => {
      const css = cssTokens(variant);
      for (const [name, hex] of Object.entries(SVG_COLORS[variant])) {
        expect({ name, hex }).toEqual({ name, hex: css[name] });
      }
    });
  }

  it('lists the same tokens in both themes', () => {
    expect(Object.keys(SVG_COLORS.light).sort()).toEqual(Object.keys(SVG_COLORS.dark).sort());
  });
});

describe('useSvgColors', () => {
  it('picks the palette of the applied theme', () => {
    theme = 'light';
    expect(useSvgColors()).toBe(SVG_COLORS.light);
    theme = 'dark';
    expect(useSvgColors()).toBe(SVG_COLORS.dark);
  });
});

describe('chartSeries', () => {
  it('is chart-1 to chart-6 in order', () => {
    const c = SVG_COLORS.dark;
    expect(chartSeries(c)).toEqual([c['chart-1'], c['chart-2'], c['chart-3'], c['chart-4'], c['chart-5'], c['chart-6']]);
  });
});
