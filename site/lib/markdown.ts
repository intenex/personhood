// Markdown rendering. Bodies may contain raw HTML (the agent writes them);
// front matter values are escaped elsewhere and never pass through here.

import { Marked } from 'marked';
import type { Token } from 'marked';
import { smartQuotes } from './util.ts';

export interface MarkdownContext {
  /** Site path prefix, e.g. "/personhood" (or ""). */
  basePath: string;
  /** Public directory for files that sit next to this document, e.g. "/personhood/portraits". */
  assetBase?: string;
  /** Relative paths of files that sit next to this document. */
  assets?: Set<string>;
}

const marked = new Marked({ gfm: true, breaks: false });

/** Render markdown to HTML, fixing up links so they respect the base path. */
export function renderMarkdown(source: string, ctx: MarkdownContext): string {
  const tokens = marked.lexer(source);
  let prev = ''; // last character of text seen in this block, for quote direction
  marked.walkTokens(tokens, (token: Token) => {
    switch (token.type) {
      case 'link':
      case 'image':
        token.href = fixHref(token.href, ctx);
        break;
      case 'paragraph':
      case 'heading':
      case 'list_item':
      case 'blockquote':
      case 'table':
        prev = '';
        break;
      case 'text':
        // Leaf text only; text with child tokens is handled through its children.
        if ('tokens' in token && Array.isArray(token.tokens) && token.tokens.length > 0) break;
        if (!token.escaped) token.text = smartQuotes(token.text, prev);
        prev = token.text.slice(-1) || prev;
        break;
      case 'codespan':
      case 'escape':
        prev = token.text.slice(-1) || prev;
        break;
      case 'br':
        prev = ' ';
        break;
    }
  });
  return marked.parser(tokens);
}

/**
 * - "/posts/x/"       -> "/personhood/posts/x/" (unless already prefixed)
 * - "portrait.svg"    -> "/personhood/portraits/portrait.svg" when that file sits beside the document
 * - everything else   -> unchanged
 */
export function fixHref(href: string, ctx: MarkdownContext): string {
  if (!href) return href;
  if (href.startsWith('/') && !href.startsWith('//')) {
    if (ctx.basePath === '' || href === ctx.basePath || href.startsWith(`${ctx.basePath}/`)) return href;
    return ctx.basePath + href;
  }
  if (ctx.assetBase && ctx.assets && !/^[a-z][a-z0-9+.-]*:/i.test(href) && !href.startsWith('#') && !href.startsWith('//')) {
    const clean = href.replace(/^\.\//, '');
    const path = clean.split(/[?#]/)[0] ?? '';
    if (ctx.assets.has(decodeSafe(path))) return `${ctx.assetBase}/${clean}`;
  }
  return href;
}

function decodeSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
