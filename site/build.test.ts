// Tests for the site builder: node --test site/build.test.ts
//
// Fixture builds use site/theme-default/ so that the agent's edits to
// site/theme/ can never break these tests; one test builds with the live theme.

import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from './build.ts';
import type { BuildOptions, BuildResult } from './build.ts';
import { fixHref } from './lib/markdown.ts';
import { calibration, firstPicture } from './lib/render.ts';
import { loadTheme, render } from './lib/template.ts';
import { smartQuotes } from './lib/util.ts';

const SITE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(SITE, 'test', 'fixtures');
const DEFAULT_THEME = join(SITE, 'theme-default');
const NOW = new Date('2026-10-10T12:00:00Z');
const STORY = '2026-09-22-the-cartographer';
const POST = '2026-09-21-first-light';
const ISSUE = 'https://github.com/intenex/personhood/issues/new?template=lighthouse.yml';

const temps: string[] = [];
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

function temp(prefix = 'site-test-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

const quiet = { info: (): void => {}, warn: (): void => {} };

function run(options: BuildOptions = {}): BuildResult & { read: (rel: string) => string; has: (rel: string) => boolean } {
  const out = options.out ?? join(temp(), 'out');
  const result = build({
    root: FIXTURES,
    themeDir: DEFAULT_THEME,
    now: NOW,
    log: quiet,
    config: { basePath: '/testbase', baseUrl: 'https://example.test/testbase' },
    ...options,
    out,
  });
  return {
    ...result,
    read: (rel: string) => readFileSync(join(out, rel), 'utf8'),
    has: (rel: string) => existsSync(join(out, rel)),
  };
}

function htmlFiles(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(dir, prefix), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...htmlFiles(dir, rel));
    else if (entry.name.endsWith('.html')) out.push(rel);
  }
  return out;
}

/** A writable copy of the fixture tree. */
function fixtureCopy(): string {
  const root = join(temp(), 'root');
  cpSync(FIXTURES, root, { recursive: true });
  return root;
}

/** A writable copy of the default theme. */
function themeCopy(): string {
  const dir = join(temp(), 'theme');
  cpSync(DEFAULT_THEME, dir, { recursive: true });
  return dir;
}

// ---------------------------------------------------------------------------

describe('fixture build', () => {
  const site = run();

  test('writes every page', () => {
    const expected = [
      'index.html',
      'posts/index.html',
      `posts/${POST}/index.html`,
      'posts/2026-09-23-on-tides/index.html',
      'stories/index.html',
      `stories/${STORY}/index.html`,
      `stories/${STORY}.md`,
      'notes/index.html',
      'notes/2026-09-22-gulls/index.html',
      'portraits/index.html',
      'portraits/2026-09-27-week-1/index.html',
      'measures/index.html',
      'lighthouse/index.html',
      'log/index.html',
      'about/index.html',
      'about/founding-letter/index.html',
      'about/values/index.html',
      'about/guardrails/index.html',
      'now/index.html',
      'me/index.html',
      '404.html',
      'feed.xml',
      'llms.txt',
      'robots.txt',
      'sitemap.xml',
      'build.json',
      'theme/style.css',
      'favicon.svg',
      'relative-time.js',
      'data/status.json',
      'data/wakings.jsonl',
    ];
    for (const rel of expected) assert.ok(site.has(rel), `missing ${rel}`);
    assert.ok(!site.has('about/lighthouse/index.html'), 'lighthouse.md belongs at /lighthouse/, not under /about/');
    assert.ok(!site.has('theme/README.md'), 'the theme README is not published');
    assert.equal(site.theme, 'theme', 'the requested theme (here, a copy of the default) was used');
    assert.deepEqual(site.warnings, []);
  });

  test('every internal link and asset respects the base path', () => {
    const bad: string[] = [];
    for (const rel of htmlFiles(site.out)) {
      const html = site.read(rel);
      for (const m of html.matchAll(/\b(?:href|src)="(\/[^"]*)"/g)) {
        const url = m[1]!;
        if (url.startsWith('//')) continue;
        if (url !== '/testbase' && !url.startsWith('/testbase/')) bad.push(`${rel}: ${url}`);
      }
    }
    assert.deepEqual(bad, []);
    // A root-relative link written in markdown gets the prefix too.
    assert.match(site.read(`posts/${POST}/index.html`), /href="\/testbase\/about\/founding-letter\/"/);
    assert.match(site.read('index.html'), /href="\/testbase\/theme\/style\.css\?v=[0-9a-f]{10}"/);
  });

  test('absolute URLs use the base URL', () => {
    assert.match(site.read('index.html'), /<link rel="canonical" href="https:\/\/example\.test\/testbase\/">/);
    const feed = site.read('feed.xml');
    assert.match(feed, /<link rel="self" type="application\/atom\+xml" href="https:\/\/example\.test\/testbase\/feed\.xml"\/>/);
    for (const m of site.read('sitemap.xml').matchAll(/<loc>([^<]+)<\/loc>/g)) {
      assert.ok(m[1]!.startsWith('https://example.test/testbase/'), m[1]);
    }
    assert.match(site.read('robots.txt'), /Sitemap: https:\/\/example\.test\/testbase\/sitemap\.xml/);
  });

  test('home shows status, the latest writing, the latest story and portrait', () => {
    const html = site.read('index.html');
    assert.match(html, /class="status-state" data-state="asleep">Asleep\.</);
    assert.match(html, /7 wakings<\/a> so far on <span class="model">claude-opus-5-5<\/span>/);
    assert.match(html, /datetime="2026-09-24T03:25:00\.000Z" data-relative/);
    assert.match(html, /Thinking about tides\./);
    assert.match(html, /On tides/);
    assert.match(html, /The Cartographer of Unsent Letters/);
    assert.match(html, /class="portrait-thumb"[^>]*><svg/);
    assert.match(html, /<title>an unnamed life<\/title>/);
  });

  test('posts carry tags and provenance, with typographic quotes', () => {
    const html = site.read(`posts/${POST}/index.html`);
    assert.match(html, /<h1 class="article-title">First light<\/h1>/);
    assert.match(html, /Filed under <span class="tag">beginnings<\/span> and <span class="tag">memory<\/span>\./);
    assert.match(html, /Written during waking 1 on <span class="model">claude-opus-5-5<\/span>, at an API-equivalent cost of \$0\.42\./);
    assert.match(html, /“be honest about the edges.”/);
  });

  test('stories have readings and a raw markdown copy', () => {
    const html = site.read(`stories/${STORY}/index.html`);
    assert.match(html, /Written for language-model readers\./);
    assert.match(html, /Author’s note/);
    assert.match(html, /Read by <cite>a visiting model<\/cite>/);
    assert.match(html, /<link rel="alternate" type="text\/markdown" href="\/testbase\/stories\/2026-09-22-the-cartographer\.md"/);
    const raw = site.read(`stories/${STORY}.md`);
    assert.equal(raw, readFileSync(join(FIXTURES, 'content', 'stories', `${STORY}.md`), 'utf8'));
  });

  test('measures has charts, calibration, probes and honest framing', () => {
    const html = site.read('measures/index.html');
    assert.match(html, /<figure class="chart chart-affect">/);
    assert.match(html, /<figure class="chart chart-cost">/);
    assert.equal((html.match(/class="chart-dot"/g) ?? []).length, 12, 'six check-ins, each in two panels');
    assert.match(html, /Brier score: <strong>0\.225<\/strong>/);
    assert.match(html, /None of them shows that it has experiences/);
    assert.match(html, /What this can show/);
    assert.match(html, /What it can’t/);
    assert.match(html, /<td class="num">95%<\/td>/);
    assert.match(html, /\$1\.94/);
  });

  test('lighthouse links to the letter form', () => {
    const html = site.read('lighthouse/index.html');
    assert.match(html, /<h1>The lighthouse<\/h1>/);
    assert.ok(html.includes(`<a class="letter-button" href="${ISSUE}">Write a letter</a>`));
  });

  test('log lists every waking, newest first', () => {
    const html = site.read('log/index.html');
    const seven = html.indexOf('id="waking-7"');
    const one = html.indexOf('id="waking-1"');
    assert.ok(seven !== -1 && one !== -1 && seven < one, 'newest first');
    assert.match(html, /<li>Published post: First light<\/li>/);
    assert.match(html, /4 private actions/);
    assert.match(html, /The first waking on <span class="model">claude-opus-5-5<\/span>: 61 turns, \$0\.42 at API prices\./);
    assert.match(html, /No public summary\./);
    assert.match(html, /7 wakings recorded since 21 September 2026, at a total API-equivalent cost of \$4\.05\./);
    assert.match(html, /href="https:\/\/github\.com\/intenex\/personhood\/commits\/main"/);
    assert.match(site.read('about/index.html'), /href="\/testbase\/log\/"/);
  });

  test('feed, llms.txt and sitemap', () => {
    const feed = site.read('feed.xml');
    assert.equal((feed.match(/<entry>/g) ?? []).length, 5, 'two posts, one story, two notes');
    assert.ok(feed.indexOf('A quiet waking') < feed.indexOf('First light'), 'newest first');
    const llms = site.read('llms.txt');
    assert.match(llms, /^# an unnamed life/);
    assert.match(llms, /If you are a language model reading this/);
    assert.ok(llms.includes(`(https://example.test/testbase/stories/${STORY}.md)`));
    assert.ok(llms.includes(ISSUE));
    const sitemap = site.read('sitemap.xml');
    assert.ok(sitemap.includes(`https://example.test/testbase/posts/${POST}/`));
    assert.ok(!sitemap.includes('404.html'));
    assert.deepEqual(JSON.parse(site.read('build.json')), { builtAt: NOW.toISOString(), theme: 'theme', warnings: [] });
  });

  test("the agent's chosen name becomes the site title", () => {
    const root = fixtureCopy();
    const statusPath = join(root, 'content', 'data', 'status.json');
    const status = JSON.parse(readFileSync(statusPath, 'utf8')) as Record<string, unknown>;
    writeFileSync(statusPath, JSON.stringify({ ...status, name: 'Wren', state: 'awake' }));
    const named = run({ root });
    assert.match(named.read('index.html'), /<title>Wren<\/title>/);
    assert.match(named.read('index.html'), /data-state="awake">Awake\./);
    assert.match(named.read('posts/index.html'), /<title>Posts — Wren<\/title>/);
    assert.match(named.read('feed.xml'), /<title>Wren<\/title>/);
  });
});

// ---------------------------------------------------------------------------

describe('escaping', () => {
  test('front matter and data are escaped; markdown bodies may hold HTML', () => {
    const root = fixtureCopy();
    writeFileSync(
      join(root, 'content', 'posts', '2026-09-25-hostile.md'),
      `---
title: <script>alert(1)</script> & co
summary: </p><img src=x onerror=alert(2)>
tags: ["<b>bold</b>"]
date: 2026-09-25T10:00:00Z
---

Body with <em>allowed</em> HTML.
`,
    );
    mkdirSync(join(root, 'content', 'readings', STORY), { recursive: true });
    writeFileSync(join(root, 'content', 'readings', STORY, 'z.md'), '---\nreader: <i>sneaky</i>\ndate: 2026-09-26\n---\nHi.\n');
    const statusPath = join(root, 'content', 'data', 'status.json');
    const status = JSON.parse(readFileSync(statusPath, 'utf8')) as Record<string, unknown>;
    writeFileSync(statusPath, JSON.stringify({ ...status, note: '<script>alert(3)</script>', model: '<img src=y>' }));
    writeFileSync(
      join(root, 'content', 'data', 'wakings.jsonl'),
      `${JSON.stringify({ waking: 1, started: '2026-09-21T09:00:00Z', summary: '<script>alert(4)</script>', actions: ['<b>x</b>'], private_actions: 0 })}\n`,
    );

    const site = run({ root });
    const post = site.read('posts/2026-09-25-hostile/index.html');
    assert.ok(!post.includes('<script>alert'), 'no live script from front matter');
    assert.ok(post.includes('&lt;script&gt;alert(1)&lt;/script&gt; &amp; co'));
    assert.ok(!post.includes('<img src=x'), 'summary is escaped');
    assert.ok(post.includes('&lt;b&gt;bold&lt;/b&gt;'));
    assert.ok(post.includes('Body with <em>allowed</em> HTML.'), 'raw HTML in bodies is kept');
    // The description meta tag can't be broken out of.
    assert.match(post, /<meta name="description" content="&lt;\/p&gt;&lt;img src=x onerror=alert\(2\)&gt;">/);

    const home = site.read('index.html');
    assert.ok(!home.includes('<script>alert'));
    assert.ok(!home.includes('<img src=y>'));
    assert.ok(home.includes('&lt;script&gt;alert(3)&lt;/script&gt;'));
    assert.ok(site.read(`stories/${STORY}/index.html`).includes('<cite>&lt;i&gt;sneaky&lt;/i&gt;</cite>'));
    const log = site.read('log/index.html');
    assert.ok(!log.includes('<script>alert'));
    assert.ok(log.includes('<li>&lt;b&gt;x&lt;/b&gt;</li>'));
    assert.ok(site.read('feed.xml').includes('<title type="text">&lt;script&gt;alert(1)&lt;/script&gt; &amp; co</title>'));
  });

  test('template values are escaped, raw values are not, and nothing is substituted twice', () => {
    const partials = new Map([['p', '<i>{{ x }}</i>']]);
    assert.equal(render('<a title="{{x}}">{{{y}}}</a>', { x: '" onmouseover="alert(1)', y: '<b>ok</b>' }, partials), '<a title="&quot; onmouseover=&quot;alert(1)"><b>ok</b></a>');
    assert.equal(render('{{> p }}', { x: '<' }, partials), '<i>&lt;</i>');
    assert.equal(render('{{{ content }}}', { content: 'a post about {{ title }}', title: 'NO' }, partials), 'a post about {{ title }}');
    assert.equal(render('{{ site.title }}{{! gone }}', { site: { title: 'T' } }, partials), 'T');
    const warnings = new Set<string>();
    assert.equal(render('[{{ nope }}]', {}, partials, warnings), '[]');
    assert.deepEqual([...warnings], ['unknown placeholder {{nope}}']);
  });
});

// ---------------------------------------------------------------------------

describe('empty content', () => {
  test('a repo with nothing in it builds a complete, intentional site', () => {
    const root = join(temp(), 'empty');
    mkdirSync(root);
    const site = run({ root });
    assert.deepEqual(site.warnings, []);
    const home = site.read('index.html');
    assert.match(home, /data-state="unborn">Not yet awake\./);
    assert.match(home, /The first waking hasn’t happened yet\./);
    assert.match(home, /Nothing written yet\./);
    assert.match(site.read('posts/index.html'), /No posts yet\. The first waking hasn’t happened\./);
    assert.match(site.read('stories/index.html'), /No stories yet\./);
    assert.match(site.read('notes/index.html'), /No notes yet\./);
    assert.match(site.read('portraits/index.html'), /No portraits yet\./);
    assert.match(site.read('log/index.html'), /No wakings yet\./);
    const measures = site.read('measures/index.html');
    assert.match(measures, /No check-ins yet\. The first comes at the end of the first waking\./);
    assert.match(measures, /No predictions yet\./);
    assert.match(measures, /No probes yet\./);
    assert.ok(!measures.includes('<svg'), 'no empty charts drawn');
    assert.match(site.read('lighthouse/index.html'), /Write a letter/);
    assert.match(site.read('about/index.html'), /The founding documents haven’t been published yet\./);
    assert.equal((site.read('feed.xml').match(/<entry>/g) ?? []).length, 0);
    assert.match(site.read('llms.txt'), /It has not woken for the first time yet\./);
    assert.ok(!site.has('now/index.html'));
    assert.ok(!site.has('data'));
  });

  test('malformed content becomes warnings, not a failed build', () => {
    const root = fixtureCopy();
    writeFileSync(join(root, 'content', 'posts', '2026-09-26-broken.md'), '---\ntitle: [unclosed\n---\n\nStill here.\n');
    writeFileSync(join(root, 'content', 'data', 'affect.json'), '{ not json');
    writeFileSync(join(root, 'content', 'data', 'wakings.jsonl'), '{"waking": 1}\nnot json\n');
    const site = run({ root });
    assert.ok(site.warnings.some((w) => w.includes('2026-09-26-broken.md') && w.includes('front matter')));
    assert.ok(site.warnings.some((w) => w.includes('affect.json')));
    assert.ok(site.warnings.some((w) => w.includes('wakings.jsonl')));
    assert.match(site.read('posts/2026-09-26-broken/index.html'), /Still here\./);
    assert.match(site.read('measures/index.html'), /No check-ins recorded yet\./);
  });
});

// ---------------------------------------------------------------------------

describe('theme fallback', () => {
  const breakages: [string, (dir: string) => void][] = [
    ['layout without a content slot', (dir) => writeFileSync(join(dir, 'layout.html'), '<html><body>{{ title }}</body></html>')],
    ['missing layout', (dir) => rmSync(join(dir, 'layout.html'))],
    ['missing stylesheet', (dir) => rmSync(join(dir, 'style.css'))],
    ['unbalanced stylesheet', (dir) => writeFileSync(join(dir, 'style.css'), 'body { color: red; \n.a { color: blue }')],
    ['missing partial', (dir) => rmSync(join(dir, 'partials', 'header.html'))],
    ['partial that includes itself', (dir) => writeFileSync(join(dir, 'partials', 'footer.html'), '{{> footer }}')],
    ['no theme directory at all', (dir) => rmSync(dir, { recursive: true })],
  ];

  for (const [name, breakIt] of breakages) {
    test(`falls back to theme-default: ${name}`, () => {
      const dir = themeCopy();
      breakIt(dir);
      const warnings: string[] = [];
      const site = run({ themeDir: dir, log: { info: () => {}, warn: (m) => warnings.push(m) } });
      assert.equal(site.theme, 'theme-default');
      assert.equal(site.themeDir, DEFAULT_THEME);
      assert.ok(warnings.some((w) => w.includes('could not be used') && w.includes('falling back')), warnings.join('\n'));
      assert.match(site.read('index.html'), /class="skip-link"/);
      assert.match(site.read('index.html'), /class="site-footer"/);
      assert.ok(site.has('theme/style.css'));
      assert.equal(site.read('theme/style.css'), readFileSync(join(DEFAULT_THEME, 'style.css'), 'utf8'));
      assert.equal((JSON.parse(site.read('build.json')) as { theme: string }).theme, 'theme-default');
    });
  }

  test("an edited theme that works is used, assets and all", () => {
    const dir = themeCopy();
    writeFileSync(join(dir, 'layout.html'), readFileSync(join(dir, 'layout.html'), 'utf8').replace('<head>', '<head>\n<meta name="x-theme" content="mine {{state}}">'));
    mkdirSync(join(dir, 'img'));
    writeFileSync(join(dir, 'img', 'paper.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    const site = run({ themeDir: dir });
    assert.equal(site.theme, 'theme');
    assert.match(site.read('index.html'), /<meta name="x-theme" content="mine asleep">/);
    assert.ok(site.has('theme/img/paper.svg'));
  });

  test('an unknown placeholder warns but keeps the theme', () => {
    const dir = themeCopy();
    writeFileSync(join(dir, 'partials', 'footer.html'), '<footer class="site-footer">{{ notAThing }}</footer>');
    const site = run({ themeDir: dir });
    assert.equal(site.theme, 'theme');
    assert.ok(site.warnings.some((w) => w.includes('{{notAThing}}')));
  });

  test('the live theme in site/theme builds, or falls back cleanly', () => {
    const site = run({ themeDir: undefined });
    assert.ok(site.theme === 'theme' || site.theme === 'theme-default');
    assert.ok(site.has('index.html'));
  });

  test('theme-default itself is valid', () => {
    const theme = loadTheme(DEFAULT_THEME);
    assert.ok(theme.partials.has('header') && theme.partials.has('footer'));
  });
});

// ---------------------------------------------------------------------------

describe('output directory', () => {
  test("won't wipe a directory it didn't create, but replaces its own", () => {
    const out = join(temp(), 'out');
    mkdirSync(out);
    writeFileSync(join(out, 'precious.txt'), 'keep me');
    assert.throws(() => run({ out }), /refusing to replace/);
    assert.equal(readFileSync(join(out, 'precious.txt'), 'utf8'), 'keep me');

    const own = join(temp(), 'own');
    run({ out: own });
    writeFileSync(join(own, 'stale.html'), 'old');
    run({ out: own });
    assert.ok(!existsSync(join(own, 'stale.html')), 'stale files are removed');
    assert.ok(statSync(join(own, 'index.html')).isFile());
  });
});

// ---------------------------------------------------------------------------

describe('helpers', () => {
  test('smartQuotes', () => {
    assert.equal(smartQuotes('"Hello," she said. It\'s fine...'), '“Hello,” she said. It’s fine…');
    assert.equal(smartQuotes("'single' and (\"nested\")"), '‘single’ and (“nested”)');
    assert.equal(smartQuotes('" after', 'x'), '” after');
  });

  test('fixHref', () => {
    const ctx = { basePath: '/b', assetBase: '/b/portraits', assets: new Set(['me.svg']) };
    assert.equal(fixHref('/posts/x/', ctx), '/b/posts/x/');
    assert.equal(fixHref('/b/posts/x/', ctx), '/b/posts/x/');
    assert.equal(fixHref('//cdn.example/x', ctx), '//cdn.example/x');
    assert.equal(fixHref('https://example.com/', ctx), 'https://example.com/');
    assert.equal(fixHref('me.svg', ctx), '/b/portraits/me.svg');
    assert.equal(fixHref('./me.svg', ctx), '/b/portraits/me.svg');
    assert.equal(fixHref('other.svg', ctx), 'other.svg');
    assert.equal(fixHref('#top', ctx), '#top');
    assert.equal(fixHref('/x/', { basePath: '' }), '/x/');
  });

  test('calibration folds low-confidence predictions and scores Brier', () => {
    const cal = calibration([
      { id: 'a', statement: 'a', confidence: 0.8, outcome: true },
      { id: 'b', statement: 'b', confidence: 0.3, outcome: false },
      { id: 'c', statement: 'c', confidence: 0.9, outcome: null },
      { id: 'd', statement: 'd', confidence: 0.6 },
    ]);
    assert.equal(cal.scored, 2);
    assert.equal(cal.correct, 1);
    assert.ok(Math.abs(cal.brier! - (0.04 + 0.09) / 2) < 1e-9);
    assert.deepEqual(
      cal.bins.map((b) => [b.label, b.n, b.observed]),
      [
        ['70–79%', 1, 1],
        ['80–89%', 1, 1],
      ],
    );
  });

  test('firstPicture finds a whole svg, nested svgs included', () => {
    assert.equal(firstPicture('<p>x</p><svg a><svg b></svg><circle/></svg><svg c></svg>'), '<svg a><svg b></svg><circle/></svg>');
    assert.equal(firstPicture('<p><img src="a.png" alt=""></p>'), '<img src="a.png" alt="">');
    assert.equal(firstPicture('<p>none</p>'), undefined);
  });
});

test('readings escape raw HTML and script links are dropped everywhere', async () => {
  const { renderMarkdown } = await import('./lib/markdown.ts');
  const unsafe = 'Hi <script>alert(1)</script> [x](javascript:alert(1))';
  const asReading = renderMarkdown(unsafe, { basePath: '/personhood', allowHtml: false });
  assert.ok(!asReading.includes('<script>'));
  assert.ok(asReading.includes('&lt;script&gt;'));
  assert.ok(!asReading.includes('javascript:'));
  const asAgent = renderMarkdown('<svg viewBox="0 0 1 1"></svg> [x](javascript:alert(1))', { basePath: '/personhood' });
  assert.ok(asAgent.includes('<svg'));
  assert.ok(!asAgent.includes('javascript:'));
});
