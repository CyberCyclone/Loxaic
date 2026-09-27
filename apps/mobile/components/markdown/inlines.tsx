import type { ReactNode } from 'react';
import { Linking, Platform, Text as RNText, type TextStyle } from 'react-native';
import type { Tokens } from 'marked';
import { decodeEntities, type Token } from './parse';
import { md, monoStyle } from './theme';

// Inline spans are raw RN Text, not the Gluestack Text: the Gluestack tva base
// re-applies text-foreground + size md to every element, which would clobber
// the color/size a span should inherit from its parent paragraph. A raw RNText
// inherits from another RNText on both native and web — but on the web the
// paragraph around it is Gluestack's raw <span>, which react-native-web cannot
// see, so the outermost RNText took RNW's root-text defaults instead (black,
// `14px System`): every paragraph, heading and table cell ignored the colour
// and size its block asked for. `renderInlineRun` wraps a block's inlines in
// one RNText that inherits them, and everything inside is an RNText with a
// text ancestor, which RNW already makes inherit.

// `inherit` is a CSS keyword RN's types do not know; only the web sees this.
const INHERIT = {
  color: 'inherit',
  fontFamily: 'inherit',
  fontSize: 'inherit',
  fontStyle: 'inherit',
  fontWeight: 'inherit',
  lineHeight: 'inherit',
  letterSpacing: 'inherit',
  textAlign: 'inherit',
} as unknown as TextStyle;

/** A block's inline content: what goes inside a paragraph, heading or cell. */
export function renderInlineRun(tokens: Token[] | undefined): ReactNode {
  return <RNText style={Platform.OS === 'web' ? INHERIT : undefined}>{renderInlines(tokens)}</RNText>;
}

// Only web and mail addresses open. A link's target is whatever a model or a
// model card's author wrote, and `javascript:` or `file:` is not somewhere a
// tap should go.
function openLink(href: string) {
  if (!/^(https?:|mailto:)/i.test(href.trim())) return;
  void Linking.openURL(href).catch(() => {
    /* invalid/unsupported URL from the model — nothing sensible to do */
  });
}

export function renderInlines(tokens: Token[] | undefined): ReactNode {
  if (!tokens) return null;
  return tokens.map((token, i) => {
    switch (token.type) {
      case 'text': {
        const t = token as Tokens.Text;
        // A block-level `text` token (list items, loose paragraphs) carries
        // its own inline children; a leaf inline `text` token does not.
        if (t.tokens?.length) return <RNText key={i}>{renderInlines(t.tokens)}</RNText>;
        return <RNText key={i}>{decodeEntities(t.text)}</RNText>;
      }
      case 'escape':
        return <RNText key={i}>{(token as Tokens.Escape).text}</RNText>;
      case 'strong':
        return (
          <RNText key={i} className={md.strong}>
            {renderInlines((token as Tokens.Strong).tokens)}
          </RNText>
        );
      case 'em':
        return (
          <RNText key={i} className={md.em}>
            {renderInlines((token as Tokens.Em).tokens)}
          </RNText>
        );
      case 'del':
        return (
          <RNText key={i} className={md.del}>
            {renderInlines((token as Tokens.Del).tokens)}
          </RNText>
        );
      case 'codespan':
        // CommonMark doesn't process entities inside code, so no decode here.
        return (
          <RNText key={i} className={md.codespan} style={monoStyle}>
            {(token as Tokens.Codespan).text}
          </RNText>
        );
      case 'link': {
        const t = token as Tokens.Link;
        return (
          <RNText
            key={i}
            className={md.link}
            role="link"
            onPress={() => {
              openLink(t.href);
            }}
          >
            {renderInlines(t.tokens)}
          </RNText>
        );
      }
      case 'image': {
        // No inline images yet (a View can't live inside Text on native).
        // Render a tappable chip; a future resolveImage hook can hoist real
        // images to block level once attachments land.
        const t = token as Tokens.Image;
        return (
          <RNText
            key={i}
            className={md.link}
            onPress={() => {
              openLink(t.href);
            }}
          >
            [image: {decodeEntities(t.text) || 'link'}]
          </RNText>
        );
      }
      case 'br':
        return <RNText key={i}>{'\n'}</RNText>;
      case 'html':
        // Stray inline HTML from the model renders as literal text — safe
        // fallback, and honest about what the model produced.
        return <RNText key={i}>{(token as Tokens.HTML).text}</RNText>;
      case 'checkbox':
        // Task-list state is rendered as the list marker in blocks.tsx.
        return null;
      default:
        return <RNText key={i}>{'raw' in token ? token.raw : ''}</RNText>;
    }
  });
}
