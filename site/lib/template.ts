// The tiny template language used by site/theme/.
//
//   {{ name }}      insert a value, HTML-escaped
//   {{{ name }}}    insert a value raw (only for HTML fragments the builder makes)
//   {{> partial }}  include partials/partial.html (partials may include partials)
//   {{! comment }}  removed from the output
//
// Names may be dotted (`{{ site.title }}`). There is deliberately no logic:
// the builder hands the theme ready-made fragments instead.

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { esc } from './util.ts';

export type TemplateValue = string | number | boolean | null | undefined | TemplateVars;
export interface TemplateVars {
  [key: string]: TemplateValue;
}

export interface Theme {
  /** Absolute path of the theme directory. */
  dir: string;
  layout: string;
  partials: Map<string, string>;
  css: string;
  /** Short content hash of style.css, used to bust caches. */
  version: string;
  /** Files (relative paths) copied to /theme/ in the output. */
  assets: string[];
}

export class ThemeError extends Error {}

const MAX_PARTIAL_DEPTH = 8;
const CONTENT_SLOT = /\{\{\{\s*content\s*\}\}\}/;

/** Load and validate a theme directory. Throws ThemeError if it can't be used. */
export function loadTheme(dir: string): Theme {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new ThemeError(`theme directory not found: ${dir}`);
  }
  const layoutPath = join(dir, 'layout.html');
  const cssPath = join(dir, 'style.css');
  if (!existsSync(layoutPath)) throw new ThemeError(`missing required template layout.html in ${dir}`);
  if (!existsSync(cssPath)) throw new ThemeError(`missing required stylesheet style.css in ${dir}`);

  const layout = readFileSync(layoutPath, 'utf8');
  const css = readFileSync(cssPath, 'utf8');
  if (!CONTENT_SLOT.test(layout)) {
    throw new ThemeError('layout.html must contain {{{ content }}} (triple braces) where the page goes');
  }
  if (css.trim() === '') throw new ThemeError('style.css is empty');
  checkCssBalance(css);

  const partials = new Map<string, string>();
  const partialDir = join(dir, 'partials');
  if (existsSync(partialDir)) {
    for (const file of readdirSync(partialDir)) {
      if (file.endsWith('.html')) {
        partials.set(file.slice(0, -'.html'.length), readFileSync(join(partialDir, file), 'utf8'));
      }
    }
  }

  // Expand the layout once now so a missing or recursive partial fails here,
  // inside the theme check, rather than halfway through writing pages.
  expandPartials(layout, partials, 0);

  const assets = listFiles(dir).filter((rel) => {
    if (rel.endsWith('.html')) return false;
    if (rel === 'README.md') return false;
    if (rel.split('/').some((part) => part.startsWith('.'))) return false;
    return true;
  });

  return {
    dir,
    layout,
    partials,
    css,
    version: createHash('sha256').update(css).digest('hex').slice(0, 10),
    assets,
  };
}

/**
 * Render a template. Values are substituted in a single pass, so text inside
 * a value (say, a post that mentions "{{ title }}") is never re-interpreted.
 */
export function render(template: string, vars: TemplateVars, partials: Map<string, string>, warnings?: Set<string>): string {
  const expanded = expandPartials(template, partials, 0);
  return expanded.replace(/\{\{\{\s*([^{}]*?)\s*\}\}\}|\{\{\s*([^{}]*?)\s*\}\}/g, (_match, rawName: string | undefined, escName: string | undefined) => {
    const name = (rawName ?? escName ?? '').trim();
    const value = lookup(vars, name);
    if (value === undefined) {
      warnings?.add(`unknown placeholder {{${name}}}`);
      return '';
    }
    if (value === null || typeof value === 'object') return '';
    return rawName !== undefined ? String(value) : esc(value);
  });
}

function expandPartials(template: string, partials: Map<string, string>, depth: number): string {
  const withoutComments = template.replace(/\{\{![\s\S]*?\}\}/g, '');
  return withoutComments.replace(/\{\{>\s*([\w.-]+)\s*\}\}/g, (_m, name: string) => {
    if (depth >= MAX_PARTIAL_DEPTH) throw new ThemeError(`partials nested more than ${MAX_PARTIAL_DEPTH} deep (is "${name}" including itself?)`);
    const partial = partials.get(name);
    if (partial === undefined) throw new ThemeError(`missing partial "${name}" (expected partials/${name}.html)`);
    return expandPartials(partial, partials, depth + 1);
  });
}

function lookup(vars: TemplateVars, name: string): TemplateValue {
  if (!/^[A-Za-z_][\w-]*(\.[A-Za-z_][\w-]*)*$/.test(name)) return undefined;
  let current: TemplateValue = vars;
  for (const part of name.split('.')) {
    if (current === null || typeof current !== 'object' || !Object.hasOwn(current, part)) return undefined;
    current = current[part];
  }
  return current;
}

/** Cheap sanity check: an unbalanced brace usually breaks everything after it. */
function checkCssBalance(css: string): void {
  const stripped = css
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, '""');
  let depth = 0;
  for (const ch of stripped) {
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth < 0) throw new ThemeError('style.css has an unmatched "}"');
    }
  }
  if (depth !== 0) throw new ThemeError('style.css has an unclosed "{"');
}

function listFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.push(relative(dir, full).split(sep).join('/'));
    }
  };
  walk(dir);
  return out.sort();
}
