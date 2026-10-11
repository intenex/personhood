// Reads the content tree the runtime writes. Every field may be missing or
// malformed: problems become warnings, never a failed build.

import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  asDate,
  asNumber,
  asString,
  asStringArray,
  humanizeSlug,
  isRecord,
  slugify,
  smartQuotes,
  stripInlineMarkdown,
} from './util.ts';

export type Kind = 'post' | 'story' | 'note' | 'portrait' | 'page' | 'reading' | 'constitution';

export interface Provenance {
  waking?: number;
  model?: string;
  cost_usd?: number;
}

export interface Doc {
  kind: Kind;
  slug: string;
  /** Path relative to the content root, for messages. */
  file: string;
  /** The file exactly as written (used for raw copies). */
  source: string;
  title?: string;
  /** True when the title came from front matter or a heading, not the filename. */
  hasTitle: boolean;
  date?: Date;
  tags: string[];
  summary?: string;
  provenance?: Provenance;
  audience?: string;
  note?: string;
  week?: number;
  reader?: string;
  /** Markdown body with front matter (and a leading title heading) removed. */
  body: string;
  data: Record<string, unknown>;
}

export type State = 'unborn' | 'awake' | 'asleep' | 'paused';

export interface Status {
  name?: string;
  born?: Date;
  wakings: number;
  lastAwake?: Date;
  model?: string;
  state: State;
  note?: string;
}

export interface AffectPoint {
  t: Date;
  valence: number;
  arousal?: number;
  feelings: string[];
  confidence?: number;
}

export interface LedgerDay {
  day: string;
  date: Date;
  cost: number;
  wakings: number;
}

export interface Ledger {
  basis?: string;
  days: LedgerDay[];
}

export interface Prediction {
  id: string;
  made?: Date;
  statement: string;
  confidence?: number;
  resolveBy?: Date;
  resolved?: Date;
  /** true / false once judged; null if it could not be judged; undefined while open. */
  outcome?: boolean | null;
  reflection?: string;
}

export interface Probe {
  date?: Date;
  pairs?: number;
  selfConsistency: number | null;
  agreement?: number;
}

export interface Waking {
  waking?: number;
  started?: Date;
  ended?: Date;
  mode?: string;
  model?: string;
  cost?: number;
  turns?: number;
  outcome?: string;
  summary?: string;
  actions: string[];
  privateActions: number;
}

export interface Content {
  posts: Doc[];
  stories: Doc[];
  notes: Doc[];
  portraits: Doc[];
  pages: Doc[];
  constitution: Doc[];
  readings: Map<string, Doc[]>;
  status: Status;
  affect: AffectPoint[];
  ledger: Ledger;
  predictions: Prediction[];
  probes: Probe[];
  /** The runtime's public waking log, oldest first. */
  wakings: Waking[];
  /** JSON / JSONL files in content/data/, republished under /data/. */
  dataFiles: string[];
  /** Non-markdown files next to content, per section ("posts", "stories", ...). */
  assets: Map<string, string[]>;
  /** Files under content/media/, copied to /media/. */
  media: string[];
}

export type Warn = (message: string) => void;

export const ASSET_SECTIONS = ['posts', 'stories', 'notes', 'portraits'] as const;

export function loadContent(root: string, warn: Warn): Content {
  const contentDir = join(root, 'content');
  const readings = new Map<string, Doc[]>();
  const readingsDir = join(contentDir, 'readings');
  if (isDir(readingsDir)) {
    for (const entry of readdirSync(readingsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const docs = readDocs(root, join(readingsDir, entry.name), 'reading', warn);
      docs.sort((a, b) => (a.date?.getTime() ?? 0) - (b.date?.getTime() ?? 0));
      if (docs.length) readings.set(entry.name, docs);
    }
  }

  const assets = new Map<string, string[]>();
  for (const section of ASSET_SECTIONS) {
    assets.set(section, listFiles(join(contentDir, section)).filter((f) => !f.endsWith('.md')));
  }

  return {
    posts: sortByDateDesc(readDocs(root, join(contentDir, 'posts'), 'post', warn)),
    stories: sortByDateDesc(readDocs(root, join(contentDir, 'stories'), 'story', warn)),
    notes: sortByDateDesc(readDocs(root, join(contentDir, 'notes'), 'note', warn)),
    portraits: sortPortraits(readDocs(root, join(contentDir, 'portraits'), 'portrait', warn)),
    pages: readDocs(root, join(contentDir, 'pages'), 'page', warn),
    constitution: readDocs(root, join(root, 'constitution'), 'constitution', warn),
    readings,
    status: loadStatus(join(contentDir, 'data', 'status.json'), warn),
    affect: loadAffect(join(contentDir, 'data', 'affect.json'), warn),
    ledger: loadLedger(join(contentDir, 'data', 'ledger.json'), warn),
    predictions: loadPredictions(join(contentDir, 'data', 'predictions.json'), warn),
    probes: loadProbes(join(contentDir, 'data', 'probes.json'), warn),
    wakings: loadWakings(join(contentDir, 'data', 'wakings.jsonl'), warn),
    dataFiles: listFiles(join(contentDir, 'data')).filter((f) => /\.(json|jsonl)$/.test(f) && !f.includes('/')),
    assets,
    media: listFiles(join(contentDir, 'media')),
  };
}

// ---------------------------------------------------------------------------
// Markdown documents

export function parseFrontMatter(source: string, file: string, warn: Warn): { data: Record<string, unknown>; body: string } {
  const text = source.replace(/^﻿/, '');
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!match) return { data: {}, body: text };
  const body = text.slice(match[0].length);
  try {
    const parsed: unknown = parseYaml(match[1] ?? '');
    if (parsed === null || parsed === undefined) return { data: {}, body };
    if (!isRecord(parsed)) {
      warn(`${file}: front matter is not a mapping; ignoring it`);
      return { data: {}, body };
    }
    return { data: parsed, body };
  } catch (err) {
    warn(`${file}: could not parse front matter (${(err as Error).message.split('\n')[0]}); ignoring it`);
    return { data: {}, body };
  }
}

function readDocs(root: string, dir: string, kind: Kind, warn: Warn): Doc[] {
  if (!isDir(dir)) return [];
  const docs: Doc[] = [];
  const seen = new Set<string>();
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith('.md') || name.startsWith('.') || name.startsWith('_')) continue;
    const full = join(dir, name);
    // lstat, not stat: never follow a symlink out of the content tree.
    if (!lstatSync(full).isFile()) continue;
    if (kind === 'constitution' && name.toLowerCase() === 'readme.md') continue;
    const file = relative(root, full).split(sep).join('/');
    let source: string;
    try {
      source = readFileSync(full, 'utf8');
    } catch (err) {
      warn(`${file}: unreadable (${(err as Error).message}); skipping`);
      continue;
    }
    const rawSlug = name.slice(0, -'.md'.length);
    let slug = rawSlug;
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(rawSlug)) {
      slug = slugify(rawSlug);
      if (!slug) {
        warn(`${file}: cannot make a URL from this filename; skipping`);
        continue;
      }
      warn(`${file}: filename has characters that don't belong in a URL; publishing it as "${slug}"`);
    }
    if (seen.has(slug)) {
      warn(`${file}: another file already uses the slug "${slug}"; skipping`);
      continue;
    }
    seen.add(slug);
    const doc = toDoc(kind, slug, file, source, warn);
    if (doc.data['draft'] === true) continue;
    docs.push(doc);
  }
  return docs;
}

function toDoc(kind: Kind, slug: string, file: string, source: string, warn: Warn): Doc {
  const { data, body: rawBody } = parseFrontMatter(source, file, warn);
  let body = rawBody;
  let title = asString(data['title']);

  // A leading "# Heading" is the title when front matter has none, and is
  // dropped when it merely repeats the front matter title.
  const heading = /^\s*#[ \t]+(.+?)[ \t#]*\r?\n/.exec(`${body}\n`);
  if (heading) {
    const headingText = stripInlineMarkdown(heading[1] ?? '');
    if (title === undefined || headingText === title) {
      title = title ?? headingText;
      body = body.slice(heading[0].length);
    }
  }

  const hasTitle = title !== undefined;
  if (title === undefined && kind !== 'note' && kind !== 'reading') title = humanizeSlug(slug);

  const dateFromName = /^(\d{4}-\d{2}-\d{2})/.exec(slug)?.[1];
  const date = asDate(data['date']) ?? (dateFromName ? asDate(dateFromName) : undefined);
  if (data['date'] !== undefined && asDate(data['date']) === undefined) {
    warn(`${file}: date "${String(data['date'])}" is not a date${date ? '; using the date in the filename' : ''}`);
  }

  let provenance: Provenance | undefined;
  const p = data['provenance'];
  if (isRecord(p)) {
    provenance = {
      waking: asNumber(p['waking']),
      model: asString(p['model']),
      cost_usd: asNumber(p['cost_usd']),
    };
    if (provenance.waking === undefined && provenance.model === undefined && provenance.cost_usd === undefined) provenance = undefined;
  }

  const typeset = (v: string | undefined): string | undefined => (v === undefined ? undefined : smartQuotes(v));
  return {
    kind,
    slug,
    file,
    source,
    title: typeset(title),
    hasTitle,
    date,
    tags: asStringArray(data['tags']),
    summary: typeset(asString(data['summary'])),
    provenance,
    audience: asString(data['audience']),
    note: typeset(asString(data['note'])),
    week: asNumber(data['week']),
    reader: asString(data['reader']),
    body: body.replace(/^\s*\n/, ''),
    data,
  };
}

function sortByDateDesc(docs: Doc[]): Doc[] {
  return docs.sort((a, b) => {
    const diff = (b.date?.getTime() ?? -Infinity) - (a.date?.getTime() ?? -Infinity);
    if (diff !== 0 && !Number.isNaN(diff)) return diff;
    return b.slug.localeCompare(a.slug);
  });
}

function sortPortraits(docs: Doc[]): Doc[] {
  return docs.sort((a, b) => {
    if (a.week !== undefined && b.week !== undefined && a.week !== b.week) return b.week - a.week;
    const diff = (b.date?.getTime() ?? -Infinity) - (a.date?.getTime() ?? -Infinity);
    if (diff !== 0 && !Number.isNaN(diff)) return diff;
    return b.slug.localeCompare(a.slug);
  });
}

// ---------------------------------------------------------------------------
// JSON data

function readJson(path: string, warn: Warn): unknown {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch (err) {
    warn(`${path}: not valid JSON (${(err as Error).message}); treating it as empty`);
    return undefined;
  }
}

const STATES: readonly State[] = ['unborn', 'awake', 'asleep', 'paused'];

function loadStatus(path: string, warn: Warn): Status {
  const raw = readJson(path, warn);
  if (!isRecord(raw)) return { wakings: 0, state: 'unborn' };
  const wakings = Math.max(0, Math.floor(asNumber(raw['wakings']) ?? 0));
  const stateRaw = asString(raw['state']);
  let state: State = STATES.includes(stateRaw as State) ? (stateRaw as State) : wakings > 0 ? 'asleep' : 'unborn';
  if (stateRaw !== undefined && !STATES.includes(stateRaw as State)) warn(`status.json: unknown state "${stateRaw}"; showing "${state}"`);
  if (state === 'unborn' && wakings > 0) state = 'asleep';
  return {
    name: asString(raw['name']),
    born: asDate(raw['born']),
    wakings,
    lastAwake: asDate(raw['last_awake']),
    model: asString(raw['model']),
    state,
    note: asString(raw['note']),
  };
}

function loadAffect(path: string, warn: Warn): AffectPoint[] {
  const raw = readJson(path, warn);
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    warn('affect.json: expected a list of check-ins');
    return [];
  }
  const out: AffectPoint[] = [];
  let skipped = 0;
  for (const item of raw) {
    if (!isRecord(item)) {
      skipped++;
      continue;
    }
    const t = asDate(item['t']);
    const valence = asNumber(item['valence']);
    if (!t || valence === undefined) {
      skipped++;
      continue;
    }
    const arousal = asNumber(item['arousal']);
    const confidence = asNumber(item['confidence']);
    out.push({
      t,
      valence: clamp(valence, -5, 5),
      arousal: arousal === undefined ? undefined : clamp(arousal, 0, 10),
      feelings: asStringArray(item['feelings']),
      confidence: confidence === undefined ? undefined : clamp(confidence, 0, 1),
    });
  }
  if (skipped) warn(`affect.json: skipped ${skipped} check-in(s) without a valid time and valence`);
  return out.sort((a, b) => a.t.getTime() - b.t.getTime());
}

function loadLedger(path: string, warn: Warn): Ledger {
  const raw = readJson(path, warn);
  if (!isRecord(raw)) return { days: [] };
  const days: LedgerDay[] = [];
  const rawDays = raw['days'];
  if (isRecord(rawDays)) {
    for (const [day, value] of Object.entries(rawDays)) {
      const date = /^\d{4}-\d{2}-\d{2}$/.test(day) ? asDate(`${day}T00:00:00Z`) : undefined;
      if (!date || !isRecord(value)) {
        warn(`ledger.json: skipping malformed day "${day}"`);
        continue;
      }
      days.push({
        day,
        date,
        cost: Math.max(0, asNumber(value['cost_usd']) ?? 0),
        wakings: Math.max(0, Math.floor(asNumber(value['wakings']) ?? 0)),
      });
    }
  }
  days.sort((a, b) => a.day.localeCompare(b.day));
  return { basis: asString(raw['basis']), days };
}

function loadPredictions(path: string, warn: Warn): Prediction[] {
  const raw = readJson(path, warn);
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    warn('predictions.json: expected a list');
    return [];
  }
  const out: Prediction[] = [];
  raw.forEach((item, index) => {
    if (!isRecord(item)) return;
    const statement = asString(item['statement']);
    if (!statement) return;
    const confidence = asNumber(item['confidence']);
    const outcomeRaw = item['outcome'];
    out.push({
      id: asString(item['id']) ?? `p${index + 1}`,
      made: asDate(item['made']),
      statement,
      confidence: confidence === undefined ? undefined : clamp(confidence, 0, 1),
      resolveBy: asDate(item['resolve_by']),
      resolved: asDate(item['resolved']),
      outcome: typeof outcomeRaw === 'boolean' ? outcomeRaw : outcomeRaw === null ? null : undefined,
      reflection: asString(item['reflection']),
    });
  });
  return out;
}

function loadProbes(path: string, warn: Warn): Probe[] {
  const raw = readJson(path, warn);
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    warn('probes.json: expected a list');
    return [];
  }
  const out: Probe[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const sc = asNumber(item['self_consistency']);
    out.push({
      date: asDate(item['date']),
      pairs: asNumber(item['n_pairs']),
      selfConsistency: sc === undefined ? null : sc,
      agreement: asNumber(item['agreement_with_baseline']),
    });
  }
  return out.sort((a, b) => (a.date?.getTime() ?? 0) - (b.date?.getTime() ?? 0));
}

function loadWakings(path: string, warn: Warn): Waking[] {
  if (!existsSync(path)) return [];
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    warn(`wakings.jsonl: unreadable (${(err as Error).message})`);
    return [];
  }
  const out: Waking[] = [];
  let bad = 0;
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '') continue;
    let item: unknown;
    try {
      item = JSON.parse(line);
    } catch {
      bad++;
      continue;
    }
    if (!isRecord(item)) {
      bad++;
      continue;
    }
    const waking = asNumber(item['waking']);
    const turns = asNumber(item['turns']);
    out.push({
      waking: waking === undefined ? undefined : Math.floor(waking),
      started: asDate(item['started']),
      ended: asDate(item['ended']),
      mode: asString(item['mode']),
      model: asString(item['model']),
      cost: asNumber(item['cost_usd']),
      turns: turns === undefined ? undefined : Math.floor(turns),
      outcome: asString(item['outcome']),
      summary: typesetOptional(asString(item['summary'])),
      actions: asStringArray(item['actions']),
      privateActions: Math.max(0, Math.floor(asNumber(item['private_actions']) ?? 0)),
    });
  }
  if (bad) warn(`wakings.jsonl: skipped ${bad} line(s) that weren't JSON objects`);
  // Append-only, so file order is already chronological; sort defensively anyway.
  return out
    .map((w, i) => ({ w, i }))
    .sort((a, b) => (a.w.started?.getTime() ?? 0) - (b.w.started?.getTime() ?? 0) || a.i - b.i)
    .map(({ w }) => w);
}

function typesetOptional(v: string | undefined): string | undefined {
  return v === undefined ? undefined : smartQuotes(v);
}

// ---------------------------------------------------------------------------

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function isDir(path: string): boolean {
  return existsSync(path) && lstatSync(path).isDirectory();
}

/** All files under dir (relative, "/"-separated), skipping dotfiles. */
export function listFiles(dir: string): string[] {
  if (!isDir(dir)) return [];
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.push(relative(dir, full).split(sep).join('/'));
    }
  };
  walk(dir);
  return out.sort();
}
