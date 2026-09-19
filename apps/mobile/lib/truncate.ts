import { Platform } from 'react-native'

/**
 * What actually makes a gluestack `Text` ellipsize on web.
 *
 * Neither of the two obvious mechanisms works on its own:
 *
 * - `numberOfLines={1}` never reaches a renderer that would act on it. The web
 *   override (`components/ui/text/index.web.tsx`) renders a raw `<span>` and
 *   spreads props straight onto it, so the prop is inert.
 * - The `truncate` class is applied and half-works — `overflow: hidden` and
 *   `text-overflow: ellipsis` do land — but its `white-space: nowrap` loses to
 *   `whitespace-pre-wrap`, which `components/ui/text/styles.tsx` puts in the
 *   web base class of *every* Text. UniWind resolves both to inline styles, so
 *   no stylesheet rule matches the element at all and no amount of class
 *   ordering, `!` or `web:` prefixing can win: a computed
 *   `white-space: pre-wrap` on a span with a `truncate` class is what this
 *   looks like from the outside.
 *
 * So the value is set as an inline style, which is the one thing UniWind does
 * not overwrite. Web-only: on native `numberOfLines` is the real mechanism and
 * these are not valid RN style properties.
 *
 * The cast is unavoidable — React Native's `TextStyle` has no web box
 * properties, and this deliberately targets the DOM element underneath.
 *
 * Used with `min-w-0` on the text's flex parent, which is what lets it shrink
 * below its content in the first place (React Native defaults every view to
 * `flexShrink: 0`); truncation without that just moves the overflow.
 */
export const TRUNCATE_TEXT = (
  Platform.OS === 'web' ? { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } : undefined
) as object | undefined
