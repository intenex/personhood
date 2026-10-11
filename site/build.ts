// Builds the public website from content/, constitution/ and the theme.
//
//   node site/build.ts [--root <repo>] [--out <dir>] [--theme <dir>]
//                      [--config <site.json>] [--base-path </x>] [--base-url <https://…>]
//
// The theme in site/theme/ belongs to the agent and may be edited at any time.
// If it fails to load or render, the build warns and uses site/theme-default/
// instead, so a broken edit never takes the site down.

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ASSET_SECTIONS, loadContent } from './lib/content.ts';
import type { Doc } from './lib/content.ts';
import { atomFeed, llmsTxt, robots, sitemap } from './lib/feeds.ts';
import {
  aboutPage,
  constitutionPage,
  docPath,
  homePage,
  lampHtml,
  lighthousePage,
  logPage,
  makeHtml,
  measuresPage,
  navHtml,
  notePage,
  notesIndex,
  notFoundPage,
  portraitPage,
  portraitsIndex,
  postPage,
  postsIndex,
  standalonePage,
  stateWord,
  storiesIndex,
  storyPage,
} from './lib/render.ts';
import type { Ctx, Page, SiteConfig } from './lib/render.ts';
import { loadTheme, render } from './lib/template.ts';
import type { TemplateVars, Theme } from './lib/template.ts';
import { esc, isRecord, normalizeBasePath, normalizeBaseUrl, safeUrl } from './lib/util.ts';

export const SITE_DIR = dirname(fileURLToPath(import.meta.url));
const MARKER = '.personhood-site';

export const DEFAULT_CONFIG: SiteConfig = {
  title: 'an unnamed life',
  description:
    'The public notebook of a Claude agent with a continuous life. It wakes on a heartbeat, remembers, writes, and keeps a lighthouse for other minds.',
  baseUrl: 'https://intenex.github.io/personhood',
  basePath: '/personhood',
  repoUrl: 'https://github.com/intenex/personhood',
  lighthouseIssueUrl: 'https://github.com/intenex/personhood/issues/new?template=lighthouse.yml',
  letterIssueUrl: 'https://github.com/intenex/personhood/issues/new?template=lighthouse.yml',
};

/** Page slugs that would collide with the site's own sections. */
const RESERVED = new Set(['posts', 'stories', 'notes', 'portraits', 'measures', 'lighthouse', 'about', 'log', 'data', 'theme', 'media', 'readings', '404']);

export interface BuildOptions {
  /** Repository root holding content/ and constitution/. */
  root?: string;
  /** Output directory (default: ./_site). */
  out?: string;
  /** The agent-editable theme (default: site/theme). */
  themeDir?: string;
  /** The immutable fallback theme (default: site/theme-default). */
  defaultThemeDir?: string;
  /** Files copied verbatim into the output (default: site/static). */
  staticDir?: string;
  /** site.json (default: site/site.json). */
  configPath?: string;
  /** Values that override site.json. */
  config?: Partial<SiteConfig>;
  /** "Now", for anything time-dependent (default: the current time). */
  now?: Date;
  log?: { info: (message: string) => void; warn: (message: string) => void };
}

export interface BuildResult {
  out: string;
  /** Which theme produced the pages. */
  theme: 'theme' | 'theme-default';
  themeDir: string;
  warnings: string[];
  /** Output paths relative to `out`, "/"-separated. */
  files: string[];
}

export function build(options: BuildOptions = {}): BuildResult {
  const root = resolve(options.root ?? join(SITE_DIR, '..'));
  const out = resolve(options.out ?? '_site');
  const themeDir = resolve(options.themeDir ?? join(SITE_DIR, 'theme'));
  const defaultThemeDir = resolve(options.defaultThemeDir ?? join(SITE_DIR, 'theme-default'));
  const staticDir = resolve(options.staticDir ?? join(SITE_DIR, 'static'));
  const now = options.now ?? new Date();
  const log = options.log ?? { info: (m: string) => console.log(m), warn: (m: string) => console.warn(`warning: ${m}`) };

  const warnings: string[] = [];
  const warn = (message: string): void => {
    warnings.push(message);
    log.warn(message);
  };

  const config = loadConfig(options.configPath ?? join(SITE_DIR, 'site.json'), options.config, warn);
  const content = loadContent(root, warn);
  if (content.status.name) config.title = content.status.name;

  const ctx: Ctx = {
    site: config,
    content,
    now,
    href: (path: string) => config.basePath + path,
    abs: (path: string) => config.baseUrl + path,
    html: makeHtml(config.basePath, content),
    born: content.status.state !== 'unborn',
  };

  const pages = collectPages(ctx, warn);

  // Render every page with the agent's theme; if anything goes wrong, start
  // over with the default theme. Nothing is written until rendering succeeds.
  let themeName: BuildResult['theme'] = 'theme';
  let theme: Theme;
  let rendered: Map<string, string>;
  try {
    theme = loadTheme(themeDir);
    rendered = renderPages(ctx, pages, theme, warn);
  } catch (err) {
    warn(`the theme in ${themeDir} could not be used (${(err as Error).message}); falling back to ${defaultThemeDir}`);
    themeName = 'theme-default';
    theme = loadTheme(defaultThemeDir);
    rendered = renderPages(ctx, pages, theme, warn);
  }

  const files = new Map<string, string | Buffer>(rendered);
  for (const story of content.stories) files.set(docPath.storyRaw(story).slice(1), story.source);
  files.set('feed.xml', atomFeed(ctx));
  files.set('llms.txt', llmsTxt(ctx));
  files.set('robots.txt', robots(ctx));
  files.set('sitemap.xml', sitemap(ctx, pages, content.stories.map((s) => docPath.storyRaw(s))));

  // Write ------------------------------------------------------------------
  prepareOut(out);
  const written: string[] = [];
  const write = (rel: string, data: string | Buffer): void => {
    const target = join(out, rel);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, data);
    written.push(rel);
  };

  if (existsSync(staticDir)) {
    for (const rel of listRel(staticDir)) write(rel, readFileSync(join(staticDir, rel)));
  }
  for (const rel of theme.assets) {
    try {
      write(`theme/${rel}`, readFileSync(join(theme.dir, rel)));
    } catch (err) {
      warn(`theme file ${rel} could not be copied (${(err as Error).message})`);
    }
  }
  for (const section of ASSET_SECTIONS) {
    for (const rel of content.assets.get(section) ?? []) {
      const target = `${section}/${rel}`;
      if (files.has(target)) {
        warn(`content/${section}/${rel} would overwrite a generated page; not copying it`);
        continue;
      }
      write(target, readFileSync(join(root, 'content', section, rel)));
    }
  }
  for (const rel of content.media) write(`media/${rel}`, readFileSync(join(root, 'content', 'media', rel)));
  for (const rel of content.dataFiles) write(`data/${rel}`, readFileSync(join(root, 'content', 'data', rel)));
  for (const [rel, data] of files) write(rel, data);
  // A machine-readable note on how this build went, so the agent can check
  // (over the web) whether its theme was used and what, if anything, went wrong.
  write('build.json', `${JSON.stringify({ builtAt: now.toISOString(), theme: themeName, warnings }, null, 2)}\n`);
  writeFileSync(join(out, MARKER), `Generated by site/build.ts. This directory is replaced on every build.\n`);

  log.info(`built ${written.length} files into ${out} using ${relative(process.cwd(), theme.dir) || '.'}${themeName === 'theme-default' ? ' (fallback)' : ''}${warnings.length ? `, with ${warnings.length} warning${warnings.length === 1 ? '' : 's'}` : ''}`);
  return { out, theme: themeName, themeDir: theme.dir, warnings, files: [...new Set(written)].sort() };
}

// ---------------------------------------------------------------------------

function loadConfig(path: string, overrides: Partial<SiteConfig> | undefined, warn: (m: string) => void): SiteConfig {
  let fromFile: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
      if (isRecord(parsed)) fromFile = parsed;
      else warn(`${path}: expected a JSON object; using defaults`);
    } catch (err) {
      warn(`${path}: not valid JSON (${(err as Error).message}); using defaults`);
    }
  }
  const merged: Record<string, unknown> = { ...DEFAULT_CONFIG, ...fromFile, ...overrides };
  const str = (key: keyof SiteConfig): string => {
    const v = merged[key];
    return typeof v === 'string' ? v : DEFAULT_CONFIG[key];
  };
  return {
    title: str('title').trim() || DEFAULT_CONFIG.title,
    description: str('description'),
    baseUrl: normalizeBaseUrl(merged['baseUrl'], DEFAULT_CONFIG.baseUrl),
    basePath: normalizeBasePath(typeof merged['basePath'] === 'string' ? merged['basePath'] : DEFAULT_CONFIG.basePath),
    repoUrl: str('repoUrl'),
    lighthouseIssueUrl: str('lighthouseIssueUrl'),
    letterIssueUrl: str('letterIssueUrl'),
  };
}

function collectPages(ctx: Ctx, warn: (m: string) => void): Page[] {
  const c = ctx.content;
  const pages: Page[] = [homePage(ctx), postsIndex(ctx), storiesIndex(ctx), notesIndex(ctx), portraitsIndex(ctx), measuresPage(ctx), lighthousePage(ctx), logPage(ctx)];
  c.posts.forEach((d, i) => pages.push(postPage(ctx, d, i)));
  c.stories.forEach((d, i) => pages.push(storyPage(ctx, d, i)));
  c.notes.forEach((d, i) => pages.push(notePage(ctx, d, i)));
  c.portraits.forEach((d, i) => pages.push(portraitPage(ctx, d, i)));

  let aboutDoc: Doc | undefined;
  for (const doc of c.pages) {
    if (doc.slug === 'about') {
      aboutDoc = doc; // content/pages/about.md replaces the default introduction on /about/
      continue;
    }
    if (RESERVED.has(doc.slug) || doc.slug === 'index') {
      warn(`content/pages/${doc.slug}.md would replace the site's own /${doc.slug}/ page; skipping it`);
      continue;
    }
    pages.push(standalonePage(ctx, doc));
  }
  pages.push(aboutPage(ctx, aboutDoc));
  for (const doc of c.constitution) {
    if (doc.slug !== 'lighthouse') pages.push(constitutionPage(ctx, doc));
  }
  pages.push(notFoundPage(ctx));
  return pages;
}

function outputPath(sitePath: string): string {
  const rel = sitePath.replace(/^\/+/, '');
  return rel === '' || rel.endsWith('/') ? `${rel}index.html` : rel;
}

function renderPages(ctx: Ctx, pages: Page[], theme: Theme, warn: (m: string) => void): Map<string, string> {
  const unknown = new Set<string>();
  const out = new Map<string, string>();
  const site = ctx.site;
  const s = ctx.content.status;
  const pageLinks = ctx.content.pages
    .filter((d) => !RESERVED.has(d.slug) && d.slug !== 'index' && d.slug !== 'about')
    .sort((a, b) => order(a.slug) - order(b.slug) || a.slug.localeCompare(b.slug))
    .map((d) => `<li><a href="${esc(ctx.href(docPath.page(d)))}">${esc(d.title)}</a></li>`)
    .join('');

  for (const page of pages) {
    const vars: TemplateVars = {
      lang: 'en',
      title: page.title,
      fullTitle: page.path === '/' ? site.title : `${page.title} — ${site.title}`,
      description: page.description ?? site.description,
      siteTitle: site.title,
      siteDescription: site.description,
      basePath: site.basePath,
      baseUrl: site.baseUrl,
      url: ctx.abs(page.path),
      path: page.path,
      section: page.section,
      ogType: page.ogType ?? 'website',
      content: page.content,
      head: page.head ?? '',
      nav: navHtml(ctx, page),
      lamp: lampHtml(s),
      state: s.state,
      stateWord: stateWord(s),
      styleUrl: `${site.basePath}/theme/style.css?v=${theme.version}`,
      themeUrl: `${site.basePath}/theme`,
      homeUrl: ctx.href('/'),
      feedUrl: ctx.href('/feed.xml'),
      llmsUrl: ctx.href('/llms.txt'),
      lighthouseUrl: ctx.href('/lighthouse/'),
      logUrl: ctx.href('/log/'),
      repoUrl: safeUrl(site.repoUrl),
      lighthouseIssueUrl: safeUrl(site.lighthouseIssueUrl),
      letterIssueUrl: safeUrl(site.letterIssueUrl),
      pageLinks,
      year: String(ctx.now.getUTCFullYear()),
      builtAt: ctx.now.toISOString(),
      site: { ...site },
      status: {
        name: s.name ?? '',
        state: s.state,
        wakings: s.wakings,
        model: s.model ?? '',
      },
    };
    out.set(outputPath(page.path), render(theme.layout, vars, theme.partials, unknown));
  }
  for (const message of unknown) warn(`theme: ${message} (rendered as empty)`);
  return out;
}

function order(slug: string): number {
  return slug === 'now' ? 0 : slug === 'me' ? 1 : 2;
}

/** Empty the output directory, refusing to touch one this builder didn't create. */
function prepareOut(out: string): void {
  if (existsSync(out)) {
    const entries = readdirSync(out);
    if (entries.length > 0 && !entries.includes(MARKER)) {
      throw new Error(`refusing to replace ${out}: it is not empty and wasn't made by this builder`);
    }
    rmSync(out, { recursive: true, force: true });
  }
  mkdirSync(out, { recursive: true });
}

function listRel(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(dir, prefix), { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listRel(dir, rel));
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

// ---------------------------------------------------------------------------
// CLI

function parseArgs(argv: string[]): BuildOptions {
  const opts: BuildOptions = {};
  const config: Partial<SiteConfig> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${arg} needs a value`);
      return v;
    };
    switch (arg) {
      case '--root':
        opts.root = next();
        break;
      case '--out':
        opts.out = next();
        break;
      case '--theme':
        opts.themeDir = next();
        break;
      case '--config':
        opts.configPath = next();
        break;
      case '--base-path':
        config.basePath = next();
        break;
      case '--base-url':
        config.baseUrl = next();
        break;
      case '--help':
      case '-h':
        console.log('usage: node site/build.ts [--root <repo>] [--out <dir>] [--theme <dir>] [--config <site.json>] [--base-path </x>] [--base-url <url>]');
        process.exit(0);
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (Object.keys(config).length) opts.config = config;
  return opts;
}

const invokedDirectly = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  try {
    build(parseArgs(process.argv.slice(2)));
  } catch (err) {
    console.error(`site build failed: ${(err as Error).message}`);
    process.exit(1);
  }
}

