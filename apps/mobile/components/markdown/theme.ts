// Every className the renderer emits, in one place. All colors are global.css
// tokens, so both themes come from the class names — never hardcode a color
// here.

export type MarkdownTone = 'default' | 'muted';

export const md = {
  color: {
    default: 'text-card-foreground',
    muted: 'text-muted-foreground',
  },
  paragraphSpacing: 'my-1',
  // Chat-scale headings: a model's `#` inside a bubble shouldn't shout like a
  // document title.
  heading: [
    'text-xl', // h1
    'text-lg', // h2
    'text-base', // h3
    'text-sm', // h4
    'text-sm', // h5
    'text-sm', // h6
  ],
  headingBase: 'font-semibold mt-3 mb-1',
  strong: 'font-bold',
  em: 'italic',
  del: 'line-through',
  codespan: 'bg-code rounded-sm px-1 text-[13px]',
  link: 'text-link underline',
  listRow: 'items-start',
  // No fixed width: the column is sized per list (markerWidth in blocks.tsx).
  listMarker: 'shrink-0 text-muted-foreground',
  listContent: 'flex-1',
  blockquote: 'border-l-2 border-border pl-3 my-1',
  tableHeadRow: 'border-b border-border',
  tableRow: 'border-b border-border/50',
  tableCell: 'flex-1 basis-0 px-1 py-1',
  tableHeadText: 'font-semibold',
} as const;

// RN needs an explicit monospace family (no font-stack fallback). Size and
// line height go through classes — on web the Gluestack Text is a raw <span>,
// where a numeric inline lineHeight is a unitless multiplier, not px.
export const monoStyle = { fontFamily: 'monospace' } as const;
