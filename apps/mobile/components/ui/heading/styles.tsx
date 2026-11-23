import { tva } from '@gluestack-ui/utils/nativewind-utils';
import { isWeb } from '@gluestack-ui/utils/nativewind-utils';
const baseStyle = isWeb
  ? 'tracking-sm bg-transparent border-0 box-border display-inline list-none margin-0 padding-0 position-relative text-start no-underline whitespace-pre-wrap word-wrap-break-word'
  : '';

export const headingStyle = tva({
  // The family alone sets the weight: `font-heading` is Instrument Sans
  // SemiBold, registered as its own family. Any bold weight on top (ours, or
  // the `fontWeight: 'bold'` @expo/html-elements gives every H1–H6, which
  // `font-normal` overrides) made Android drop the face and draw Roboto Bold.
  base: `text-foreground font-heading font-normal tracking-sm my-0 ${baseStyle}`,
  variants: {
    isTruncated: {
      true: 'truncate',
    },
    bold: {
      true: 'font-bold',
    },
    underline: {
      true: 'underline',
    },
    strikeThrough: {
      true: 'line-through',
    },
    sub: {
      true: 'text-xs',
    },
    italic: {
      true: 'italic',
    },
    highlight: {
      true: 'bg-yellow-500',
    },
    size: {
      '5xl': 'text-6xl',
      '4xl': 'text-5xl',
      '3xl': 'text-4xl',
      '2xl': 'text-3xl',
      'xl': 'text-2xl',
      'lg': 'text-xl',
      'md': 'text-lg',
      'sm': 'text-base',
      'xs': 'text-sm',
    },
  },
});
