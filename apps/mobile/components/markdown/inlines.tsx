import type { ReactNode } from 'react';
import { Linking, Text as RNText } from 'react-native';
import type { Tokens } from 'marked';
import { decodeEntities, type Token } from './parse';
import { md, monoStyle } from './theme';

// Inline spans are raw RN Text, not the Gluestack Text: the Gluestack tva base
// re-applies text-foreground + size md to every element, which would clobber
// the color/size a span should inherit from its parent paragraph. Raw RNText
// inherits on both native and web.

function openLink(href: string) {
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
