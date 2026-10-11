// Small, dependency-free helpers shared by the site builder.

/** Escape a value for use in HTML text or a double-quoted attribute. */
export function esc(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Escape for XML text/attributes (Atom, sitemap). */
export function escXml(value: unknown): string {
  return esc(value).replace(/&#39;/g, '&apos;');
}

/** Normalise a base path: "" for root, otherwise "/segment" with no trailing slash. */
export function normalizeBasePath(input: unknown): string {
  if (typeof input !== 'string') return '';
  const trimmed = input.trim().replace(/\/+$/, '');
  if (trimmed === '' || trimmed === '/') return '';
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

/** Strip a trailing slash from an absolute base URL. */
export function normalizeBaseUrl(input: unknown, fallback: string): string {
  const value = typeof input === 'string' && input.trim() ? input.trim() : fallback;
  return value.replace(/\/+$/, '');
}

/** Only allow http(s), mailto and site-relative URLs into href attributes. */
export function safeUrl(input: unknown, fallback = '#'): string {
  if (typeof input !== 'string') return fallback;
  const url = input.trim();
  if (url === '') return fallback;
  if (/^(https?:|mailto:)/i.test(url)) return url;
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return fallback; // javascript:, data:, etc.
  return url;
}

export function asString(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed === '' ? undefined : trimmed;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

export function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

export function asDate(value: unknown): Date | undefined {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? undefined : value;
  if (typeof value === 'string' || typeof value === 'number') {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? undefined : d;
  }
  return undefined;
}

export function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map(asString).filter((v): v is string => v !== undefined);
  }
  const single = asString(value);
  if (single === undefined) return [];
  return single.split(',').map((s) => s.trim()).filter(Boolean);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Dates. Everything is shown in UTC so builds are deterministic wherever they run.

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad2 = (n: number): string => String(n).padStart(2, '0');

/** "11 October 2026" */
export function fmtLong(d: Date): string {
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** "11 Oct" */
export function fmtShort(d: Date): string {
  return `${d.getUTCDate()} ${MONTHS_SHORT[d.getUTCMonth()]}`;
}

/** "11 October" */
export function fmtDayMonth(d: Date): string {
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/** "21:40" (UTC) */
export function fmtTime(d: Date): string {
  return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}

export function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** <time> element with a long date. */
export function timeEl(d: Date, text = fmtLong(d), cls = ''): string {
  return `<time datetime="${esc(d.toISOString())}"${cls ? ` class="${cls}"` : ''}>${esc(text)}</time>`;
}

// ---------------------------------------------------------------------------
// Text

const OPENS_QUOTE = /[\s([{\u2014\u2013\u2018\u201C/-]/;

/**
 * Typographer's quotes: "straight" to \u201Ccurly\u201D, it's to it\u2019s, ... to \u2026.
 * `prev` is the character before `text` (for quotes at the start of a fragment).
 * Returns the converted text; a backslash-escaped quote in markdown stays straight.
 */
export function smartQuotes(text: string, prev = ''): string {
  let out = '';
  let p = prev;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    let rep = ch;
    if (ch === '"') {
      rep = p === '' || OPENS_QUOTE.test(p) ? '\u201C' : '\u201D';
    } else if (ch === "'") {
      const next = text[i + 1] ?? '';
      if (/[\p{L}\p{N}]/u.test(p) && /\p{L}/u.test(next)) rep = '\u2019';
      else rep = p === '' || OPENS_QUOTE.test(p) ? '\u2018' : '\u2019';
    } else if (ch === '.' && text.startsWith('...', i) && text[i + 3] !== '.') {
      rep = '\u2026';
      i += 2;
    }
    out += rep;
    p = rep;
  }
  return out;
}

/** Make a filesystem- and URL-safe slug. */
export function slugify(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-.]+|-+$/g, '')
    .slice(0, 120);
}

/** Turn "2026-10-11-first-light" into "First light". */
export function humanizeSlug(slug: string): string {
  const words = slug.replace(/^\d{4}-\d{2}-\d{2}-?/, '').replace(/[-_]+/g, ' ').trim();
  if (!words) return slug;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Strip tags and collapse whitespace from rendered HTML. */
export function plainText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<[^>]*>/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&');
}

/** Strip common inline markdown syntax from a one-line string (for titles). */
export function stripInlineMarkdown(s: string): string {
  return s
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(.*?)\1/g, '$2')
    .replace(/<[^>]*>/g, '')
    .trim();
}

/** Truncate at a word boundary. */
export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).replace(/[\s,;:.]+$/, '')}…`;
}

export function plural(n: number, one: string, many: string): string {
  return `${n.toLocaleString('en-GB')} ${n === 1 ? one : many}`;
}

export function fmtUsd(n: number): string {
  if (n !== 0 && Math.abs(n) < 0.01) return `$${n.toFixed(3)}`;
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function fmtPercent(n: number): string {
  return `${Math.round(n * 100)}%`;
}

/** Join ["a","b","c"] as "a, b and c". */
export function joinList(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}
